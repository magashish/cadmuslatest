import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, media } from "@cadmus/db";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { Storage } from "@google-cloud/storage";
import ffmpeg from "fluent-ffmpeg";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink, mkdir, readdir } from "fs/promises";
import { execFile } from "child_process";
import { randomUUID } from "crypto";

const app = new Hono();
const PUBLIC_BUCKET = process.env.GCS_BUCKET_NAME!;
const STAGING_BUCKET = process.env.GCS_STAGING_BUCKET_NAME!;
const gcs = new Storage();
const vision = new ImageAnnotatorClient();

type ModerationDecision = "approved" | "review" | "blocked";

function likeliness(val: string | null | undefined): number {
  return ({ UNKNOWN: 0, VERY_UNLIKELY: 0, UNLIKELY: 0, POSSIBLE: 1, LIKELY: 2, VERY_LIKELY: 3 } as Record<string, number>)[val ?? "UNKNOWN"] ?? 0;
}

async function visionScan(buf: Buffer): Promise<{ decision: ModerationDecision; scores: Record<string, string> }> {
  const [result] = await vision.safeSearchDetection({ image: { content: buf } });
  const safe = result.safeSearchAnnotation;
  const scores: Record<string, string> = {
    adult: String(safe?.adult ?? "UNKNOWN"),
    violence: String(safe?.violence ?? "UNKNOWN"),
    racy: String(safe?.racy ?? "UNKNOWN"),
    medical: String(safe?.medical ?? "UNKNOWN"),
    spoof: String(safe?.spoof ?? "UNKNOWN"),
  };
  const blocked = likeliness(scores.adult) >= 2 || likeliness(scores.violence) >= 3;
  const review = !blocked && (likeliness(scores.adult) === 1 || likeliness(scores.violence) === 2);
  return { decision: blocked ? "blocked" : review ? "review" : "approved", scores };
}

async function extractFrames(videoBuffer: Buffer, count = 5): Promise<Buffer[]> {
  const dir = join(tmpdir(), randomUUID());
  await mkdir(dir, { recursive: true });
  const inp = join(dir, "input.mp4");
  await writeFile(inp, videoBuffer);
  await new Promise<void>((res, rej) =>
    ffmpeg(inp)
      .outputOptions([`-vf fps=1/${Math.ceil(60 / count)}`, "-frames:v", String(count), "-f", "image2"])
      .output(join(dir, "frame-%d.jpg"))
      .on("end", () => res()).on("error", rej).run()
  );
  const frames: Buffer[] = [];
  for (let i = 1; i <= count; i++) {
    try { frames.push(await readFile(join(dir, `frame-${i}.jpg`))); } catch { /* short video */ }
  }
  // Fallback for very short videos: grab the first frame directly
  if (frames.length === 0) {
    const fallbackPath = join(dir, "fallback.jpg");
    await new Promise<void>((res) =>
      ffmpeg(inp)
        .outputOptions(["-frames:v", "1", "-f", "image2"])
        .output(fallbackPath)
        .on("end", () => res()).on("error", () => res()).run()
    );
    try { frames.push(await readFile(fallbackPath)); } catch { /* truly unreadable */ }
  }
  await unlink(inp).catch(() => {});
  return frames;
}

async function extractPdfThumbnail(pdfBuffer: Buffer): Promise<Buffer | null> {
  const dir = join(tmpdir(), randomUUID());
  await mkdir(dir, { recursive: true });
  const inp = join(dir, "input.pdf");
  await writeFile(inp, pdfBuffer);
  await new Promise<void>((res, rej) =>
    execFile("pdftoppm", ["-r", "150", "-f", "1", "-l", "1", "-jpeg", inp, join(dir, "page")], (err) =>
      err ? rej(err) : res()
    )
  );
  // pdftoppm names output like page-1.jpg or page-01.jpg depending on version
  const files = (await readdir(dir)).filter((f) => f.startsWith("page") && f.endsWith(".jpg"));
  if (files.length === 0) return null;
  const thumb = await readFile(join(dir, files[0]));
  await unlink(inp).catch(() => {});
  return thumb;
}

// Scan all frames and return the worst-case decision across them
async function scanFrames(frames: Buffer[]): Promise<{ decision: ModerationDecision; scores: Record<string, string> }> {
  let worstDecision: ModerationDecision = "approved";
  let worstScores: Record<string, string> = {};
  const rank: Record<ModerationDecision, number> = { approved: 0, review: 1, blocked: 2 };
  for (const frame of frames) {
    const { decision, scores } = await visionScan(frame);
    if (rank[decision] > rank[worstDecision]) {
      worstDecision = decision;
      worstScores = scores;
    }
    if (worstDecision === "blocked") break;
  }
  return { decision: worstDecision, scores: worstScores };
}

app.post("/scan", async (c) => {
  const { mediaId } = await c.req.json<{ mediaId: string; siteId: string }>();
  const [item] = await db.select().from(media).where(eq(media.id, mediaId));
  if (!item || item.moderationStatus !== "pending" || !item.stagingPath) {
    return c.json({ ok: true, skipped: true });
  }
  try {
    // Auto-scanning a PDF renders a page fully in memory, which OOMs the
    // container for very large files. Above 100 MB, skip the download/render
    // and route straight to manual review (file stays in staging for a
    // reviewer to approve or block).
    if (item.mimeType === "application/pdf" && Number(item.fileSize ?? 0) > 100 * 1024 * 1024) {
      await db.update(media).set({
        moderationStatus: "review",
        moderationScores: { note: "too_large_for_auto_scan" },
        moderationSource: "auto",
      }).where(eq(media.id, mediaId));
      return c.json({ ok: true, decision: "review" });
    }

    const [buf] = await gcs.bucket(STAGING_BUCKET).file(item.stagingPath).download();
    const buffer = Buffer.from(buf);

    let decision: ModerationDecision;
    let scores: Record<string, string>;
    let thumbnailUrl: string | null = null;

    if (item.mimeType?.startsWith("video/")) {
      const frames = await extractFrames(buffer);
      if (frames.length === 0) {
        ({ decision, scores } = { decision: "review", scores: { error: "no_frames_extracted" } });
      } else {
        ({ decision, scores } = await scanFrames(frames));
        // Save first frame as thumbnail regardless of decision
        const thumbPath = item.stagingPath.replace(/^staging\//, "").replace(/\.[^.]+$/, "") + "_thumb.jpg";
        await gcs.bucket(PUBLIC_BUCKET).file(thumbPath).save(frames[0], { contentType: "image/jpeg" });
        thumbnailUrl = `https://storage.googleapis.com/${PUBLIC_BUCKET}/${thumbPath}`;
      }
    } else if (item.mimeType === "application/pdf") {
      const thumb = await extractPdfThumbnail(buffer).catch(() => null);
      if (thumb) {
        ({ decision, scores } = await visionScan(thumb));
        const thumbPath = item.stagingPath.replace(/^staging\//, "").replace(/\.[^.]+$/, "") + "_thumb.jpg";
        await gcs.bucket(PUBLIC_BUCKET).file(thumbPath).save(thumb, { contentType: "image/jpeg" });
        thumbnailUrl = `https://storage.googleapis.com/${PUBLIC_BUCKET}/${thumbPath}`;
      } else {
        ({ decision, scores } = { decision: "approved", scores: { note: "pdf_thumbnail_failed" } });
      }
    } else {
      ({ decision, scores } = await visionScan(buffer));
    }

    if (decision === "approved") {
      const publicPath = item.stagingPath.replace(/^staging\//, "");
      await gcs.bucket(STAGING_BUCKET).file(item.stagingPath).copy(gcs.bucket(PUBLIC_BUCKET).file(publicPath));
      const publicUrl = `https://storage.googleapis.com/${PUBLIC_BUCKET}/${publicPath}`;
      await db.update(media).set({ moderationStatus: "approved", moderationScores: scores, storageUrl: publicUrl, stagingPath: null, ...(thumbnailUrl ? { thumbnailUrl } : {}) }).where(eq(media.id, mediaId));
      await gcs.bucket(STAGING_BUCKET).file(item.stagingPath).delete().catch(() => {});
    } else {
      await db.update(media).set({
        moderationStatus: decision,
        moderationScores: scores,
        moderationSource: "auto",
        ...(decision === "blocked" ? { blockedAt: new Date(), stagingPath: null } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      }).where(eq(media.id, mediaId));
      if (decision === "blocked") await gcs.bucket(STAGING_BUCKET).file(item.stagingPath).delete().catch(() => {});
    }
    return c.json({ ok: true, decision });
  } catch (err) {
    console.error("scan error:", err);
    await db.update(media).set({ moderationStatus: "review", moderationScores: { error: String(err) } }).where(eq(media.id, mediaId));
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

app.get("/health", (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) }, () =>
  console.log("Scanner running")
);
