import { eq } from "drizzle-orm";
import { db, sites } from "@cadmus/db";
import type { SiteBrief, SiteTheme, DesignIntent } from "@cadmus/shared";
import type { AIRouter } from "@cadmus/ai";

const SYNTH_SYSTEM = `You are a design director. Given a website's brief and its GENERATED homepage HTML, distill the design direction the homepage ACTUALLY executed into a reusable spec that future edits must follow to stay visually and tonally consistent.

Return ONLY valid JSON (no markdown, no commentary) with exactly this shape:
{
  "aestheticDirection": "one or two sentences describing the overall executed look",
  "voiceAndTone": "the copy voice and tone, as a phrase",
  "layoutPrinciples": "section rhythm, composition, spacing, and dark/light usage actually used",
  "imageryStyle": "photographic vs illustrated, mood, subject matter, treatment",
  "colorAndType": "how color and type are used (when the accent appears, heading treatment) — complements the raw tokens",
  "positioning": "differentiators/positioning to reinforce in copy (empty string if none)"
}

Describe what THIS homepage does, not generic best practices. Each field is one phrase or sentence — specific and concise. Do not invent prohibitions; constraints are handled separately.`;

// The free-text direction fields that both the chat tool and the admin UI can
// patch. `constraints` and `positioning` are handled separately (array / optional).
export const DESIGN_INTENT_TEXT_FIELDS = [
  "aestheticDirection",
  "voiceAndTone",
  "layoutPrinciples",
  "imageryStyle",
  "colorAndType",
] as const;

/**
 * Merge a partial update into an existing DesignIntent (or seed a fresh one),
 * bumping `version`, stamping `updatedAt`, and recording `source`. Pure — the
 * caller persists and audits. Keeps version/timestamp bookkeeping in one place
 * so the chat tool and the admin REST endpoint can't drift.
 */
export function mergeDesignIntent(
  existing: DesignIntent | undefined,
  patch: Partial<DesignIntent>,
  source: DesignIntent["source"],
): DesignIntent {
  const base: DesignIntent = existing ?? {
    aestheticDirection: "",
    voiceAndTone: "",
    layoutPrinciples: "",
    imageryStyle: "",
    colorAndType: "",
    constraints: [],
    version: 0,
    updatedAt: "",
    source,
  };
  const next: DesignIntent = { ...base };
  for (const f of DESIGN_INTENT_TEXT_FIELDS) {
    if (typeof patch[f] === "string") next[f] = (patch[f] as string).trim();
  }
  if (patch.positioning !== undefined) {
    const p = typeof patch.positioning === "string" ? patch.positioning.trim() : "";
    next.positioning = p || undefined;
  }
  if (Array.isArray(patch.constraints)) {
    next.constraints = patch.constraints
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => x.trim());
  }
  next.version = (base.version ?? 0) + 1;
  next.updatedAt = new Date().toISOString();
  next.source = source;
  return next;
}

// Synthesize the realized design intent from the generated homepage and persist
// it at settings.designIntent. Fire-and-forget friendly: never throws.
export async function synthesizeAndPersistDesignIntent(
  router: AIRouter,
  opts: {
    siteId: string;
    brief: SiteBrief | undefined;
    theme: SiteTheme | undefined;
    homepageHtml: string;
    constraints: string[];
  },
): Promise<void> {
  try {
    const { siteId, brief, theme, homepageHtml, constraints } = opts;
    const colorTokens = Object.entries(theme?.colors ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const fontTokens = Object.entries(theme?.fontFamilies ?? {})
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v[0] : v}`)
      .join(", ");

    const prompt = `BRIEF
Business: ${brief?.businessName ?? ""} — ${brief?.businessDescription ?? ""}
${brief?.targetAudience ? `Audience: ${brief.targetAudience}` : ""}
${brief?.tone ? `Requested tone: ${brief.tone}` : ""}
${brief?.differentiators ? `Differentiators: ${brief.differentiators}` : ""}

THEME TOKENS
Colors: ${colorTokens || "(none)"}
Fonts: ${fontTokens || "(none)"}

GENERATED HOMEPAGE HTML (may be truncated)
${homepageHtml.slice(0, 12000)}`;

    const result = await router.generateText({
      task: "analysis",
      systemPrompt: SYNTH_SYSTEM,
      prompt,
      temperature: 0.3,
      maxTokens: 1024,
    });

    let jsonText = result.text.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return; // unusable synthesis — leave designIntent unset
    }

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const intent: DesignIntent = {
      aestheticDirection: str(parsed.aestheticDirection),
      voiceAndTone: str(parsed.voiceAndTone),
      layoutPrinciples: str(parsed.layoutPrinciples),
      imageryStyle: str(parsed.imageryStyle),
      colorAndType: str(parsed.colorAndType),
      positioning: str(parsed.positioning) || undefined,
      constraints,
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "generated",
    };
    // Require at least the north star; otherwise the synthesis produced nothing.
    if (!intent.aestheticDirection) return;

    const [site] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, siteId));
    const settings = (site?.settings ?? {}) as Record<string, unknown>;
    await db
      .update(sites)
      .set({ settings: { ...settings, designIntent: intent }, updatedAt: new Date() })
      .where(eq(sites.id, siteId));
  } catch (err) {
    console.warn("Design-intent synthesis failed:", err);
  }
}
