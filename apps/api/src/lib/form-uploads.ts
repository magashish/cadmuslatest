import crypto from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import type { StorageProvider } from "@cadmus/cloud";

// File attachments for form submissions (form-file-uploads add-on).
//
// Files land in a PRIVATE bucket (FORM_UPLOADS_BUCKET) — visitor uploads must
// never be world-readable, so this is deliberately not the public media
// bucket. Site admins retrieve them through an authenticated API route that
// streams the object (streamObject needs no signBlob, so it works on Cloud
// Run's keyless SAs).

export interface FormAttachment {
  field: string;
  filename: string;
  path: string; // object key in the form-uploads bucket
  size: number;
  contentType: string;
}

let provider: StorageProvider | null = null;
export function setFormUploadsStorageProvider(p: StorageProvider): void {
  provider = p;
}
export function getFormUploadsStorage(): StorageProvider | null {
  return provider;
}

export const MAX_FILES_PER_SUBMISSION = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — multipart through the API, same ceiling as the video-upload fix

// Extension allowlist with the MIME types file-type sniffs them to. Legacy
// Office files (.doc/.xls) are CFB containers; modern ones sniff to their own
// OOXML types (a plain .zip renamed .docx sniffs as application/zip → reject).
const ALLOWED_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "csv",
  "doc", "docx", "xls", "xlsx",
]);
const ALLOWED_SNIFFED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/x-cfb",
]);
// Text formats have no magic bytes — file-type returns undefined for them.
const TEXT_EXTENSIONS = new Set(["txt", "csv"]);

// The accept attribute rendered on public file inputs (client-side hint only;
// the server checks are authoritative).
export const FORM_UPLOAD_ACCEPT = [...ALLOWED_EXTENSIONS].map((e) => `.${e}`).join(",");

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 120) || "file";
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export async function storeFormUploads(
  siteId: string,
  uploads: Array<{ field: string; file: File }>,
): Promise<{ ok: true; attachments: FormAttachment[] } | { ok: false; error: string }> {
  if (!provider) return { ok: false, error: "File uploads are temporarily unavailable." };
  if (uploads.length > MAX_FILES_PER_SUBMISSION) {
    return { ok: false, error: `At most ${MAX_FILES_PER_SUBMISSION} files per submission.` };
  }

  // Validate everything BEFORE uploading anything so a rejected submission
  // leaves no orphaned objects behind.
  const validated: Array<{ field: string; filename: string; buf: Buffer; contentType: string }> = [];
  for (const { field, file } of uploads) {
    const filename = sanitizeFilename(file.name);
    const ext = extensionOf(filename);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { ok: false, error: `File type .${ext || "?"} is not allowed (${filename}).` };
    }
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, error: `${filename} is too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB).` };
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0) {
      return { ok: false, error: `${filename} is empty.` };
    }
    // Content sniffing: the declared extension is client-controlled. Binary
    // types must sniff to an allowed MIME; text extensions must NOT sniff as
    // any binary format (a disguised executable sniffs to something).
    const sniffed = await fileTypeFromBuffer(buf);
    if (sniffed) {
      if (!ALLOWED_SNIFFED_MIMES.has(sniffed.mime)) {
        return { ok: false, error: `${filename} does not appear to be an allowed file type.` };
      }
    } else if (!TEXT_EXTENSIONS.has(ext)) {
      return { ok: false, error: `${filename} does not appear to be a valid .${ext} file.` };
    }
    const contentType = sniffed?.mime ?? (ext === "csv" ? "text/csv" : "text/plain");
    validated.push({ field, filename, buf, contentType });
  }

  const attachments: FormAttachment[] = [];
  for (const v of validated) {
    const path = `${siteId}/${crypto.randomUUID()}/${v.filename}`;
    await provider.upload(v.buf, path, v.contentType, "private, max-age=0");
    attachments.push({
      field: v.field,
      filename: v.filename,
      path,
      size: v.buf.length,
      contentType: v.contentType,
    });
  }
  return { ok: true, attachments };
}
