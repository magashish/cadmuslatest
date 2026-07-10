import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and, desc, count, sql, inArray } from "drizzle-orm";
import { db, sites, content, contentBlocks, contentVersions, auditLog, aiHistory, media, contentMedia, navigation, collections, contentCollections, redirects, siteMembers, users } from "@cadmus/db";
import type { AIRouter, AITaskType, AIMessage, AIMessageContent, AITool, PageDesigner, StitchDesignService } from "@cadmus/ai";
import { StitchPageDesigner, ClaudePageDesigner, convertHtmlToBlocks, convertHtmlToHtmlBlocks, extractFooterData, extractFieldsFromHtml, stripNavFields, compileTailwindForTheme, checkContentPolicy, checkContentPolicyBulk, checkImagePrompt, buildCoreIdentityPrompt } from "@cadmus/ai";
import { readToolDefinitions, executeReadTool, type ReadToolContext } from "../lib/ai-read-tools.js";
import { writeToolDefinitionsForRole, executeWriteTool, isWriteTool, type WriteToolContext } from "../lib/ai-write-tools.js";
import { checkFeatureGate, incrementUsage } from "../lib/feature-gates.js";
import { synthesizeAndPersistDesignIntent } from "../lib/design-intent.js";
import type { SiteBrief, AuthUser, HtmlBlockEditableField, SiteTheme, SiteRole, DesignIntent } from "@cadmus/shared";
import type { StorageProvider } from "@cadmus/cloud";
import type { SiteEnv } from "../middleware/tenant.js";
import { migrateExternalImages, type ImageMigrationResult } from "../lib/image-migration.js";
import { optimizeImage, IMAGE_PRESETS } from "../lib/image-optimization.js";
import { ensureFormIds } from "../lib/form-ids.js";
import { getInsightsForSite } from "../lib/insights.js";
import { enqueueJob, getJob } from "../lib/jobs.js";
import { recompileSiteCss } from "../lib/theme-recompile.js";

export const aiRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

function mimeToExt(mime: string): string {
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  return "jpg";
}

/** Derive a short, filesystem-safe filename from an image generation prompt. */
function promptToFilename(prompt: string, ext: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
  return `${slug || "ai-image"}-${Date.now()}.${ext}`;
}

function inferAspectRatio(src: string): string {
  const m = src.match(/placehold\.co\/(\d+)[xX](\d+)/);
  if (!m) return "16:9";
  const ratio = parseInt(m[1]) / parseInt(m[2]);
  if (ratio >= 0.9 && ratio <= 1.1) return "1:1";
  if (ratio < 0.7) return "9:16";
  return "16:9";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let storageProvider: StorageProvider | null = null;
export function setAIStorageProvider(provider: StorageProvider) {
  storageProvider = provider;
}

/** Save successfully migrated images as media library entries. */
async function saveMediaRecords(siteId: string, results: ImageMigrationResult[]) {
  const successful = results.filter((r) => r.success && r.newUrl && r.filename);
  if (successful.length === 0) return;
  for (const r of successful) {
    try {
      // Use alt text for a descriptive display filename when available
      const displayName = r.altText
        ? r.altText.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) +
          "." + mimeToExt(r.mimeType || "image/jpeg")
        : r.filename;
      await db.insert(media).values({
        siteId,
        filename: displayName,
        storageUrl: r.newUrl,
        mimeType: r.mimeType || "image/jpeg",
        aiAltText: r.altText || null,
        variants: {},
        uploadedBy: null, // AI-generated
      });
    } catch {
      // Ignore duplicates — image may already be in media library
    }
  }
}

/** Minimal default theme passed to the designer before the first design run. */
function themeFallback(): SiteTheme {
  return {
    colors: {},
    fontFamilies: {},
    fonts: [],
    materialSymbols: false,
    borderRadius: {},
    customCss: "",
    version: 1,
  };
}

/**
 * Merge a Partial<SiteTheme> delta into a full SiteTheme.
 *
 * `freshDesign: true` (default for design_page / Stitch import calls) replaces
 * the existing token sets with the delta's, so re-imports pick up new
 * colors/fontFamilies/fontSizes/borderRadius cleanly. Without that, existing
 * token sets win so sparse deltas don't clobber editor-managed values.
 *
 * Header/footer always take the fresh extraction (it has data-cadmus-field
 * markers and extractedEditable fields wired up).
 */
export function mergeThemeDeltaExport(
  existing: SiteTheme | undefined,
  delta: Partial<SiteTheme>,
): SiteTheme {
  return mergeThemeDelta(existing, delta, { freshDesign: false });
}

function mergeThemeDelta(
  existing: SiteTheme | undefined,
  delta: Partial<SiteTheme>,
  options: { freshDesign?: boolean } = {},
): SiteTheme {
  const freshDesign = options.freshDesign ?? true;
  const base: SiteTheme = existing ?? {
    colors: {},
    fontFamilies: {},
    fonts: [],
    materialSymbols: false,
    borderRadius: {},
    customCss: "",
    version: 1,
  };

  // For token maps that represent design vocabulary (colors, spacing, radius),
  // union-merge so each imported screen's tokens accumulate. A later screen
  // that adds `accent-gold` won't lose `primary`/`tertiary` from an earlier
  // one, and re-importing won't discard hand-added tokens either.
  const mergeTokens = <V>(deltaVal: Record<string, V> | undefined, baseVal: Record<string, V>): Record<string, V> => {
    if (freshDesign && deltaVal && Object.keys(deltaVal).length > 0) return { ...baseVal, ...deltaVal };
    if (Object.keys(baseVal).length > 0) return baseVal;
    return deltaVal ?? baseVal;
  };
  const mergeOptionalTokens = <V>(
    deltaVal: Record<string, V> | undefined,
    baseVal: Record<string, V> | undefined,
  ): Record<string, V> | undefined => {
    if (freshDesign && deltaVal && Object.keys(deltaVal).length > 0) return { ...(baseVal ?? {}), ...deltaVal };
    if (baseVal && Object.keys(baseVal).length > 0) return baseVal;
    return deltaVal ?? baseVal;
  };
  // fontFamilies intentionally replace (not merge) — the new design's typeface wins.
  const pickRequired = <V>(deltaVal: Record<string, V> | undefined, baseVal: Record<string, V>): Record<string, V> => {
    if (freshDesign && deltaVal && Object.keys(deltaVal).length > 0) return deltaVal;
    if (Object.keys(baseVal).length > 0) return baseVal;
    return deltaVal ?? baseVal;
  };
  const pickOptional = <V>(
    deltaVal: Record<string, V> | undefined,
    baseVal: Record<string, V> | undefined,
  ): Record<string, V> | undefined => {
    if (freshDesign && deltaVal && Object.keys(deltaVal).length > 0) return deltaVal;
    if (baseVal && Object.keys(baseVal).length > 0) return baseVal;
    return deltaVal ?? baseVal;
  };

  return {
    ...base,
    colors: mergeTokens(delta.colors, base.colors),
    fontFamilies: pickRequired(delta.fontFamilies, base.fontFamilies),
    fontSizes: pickOptional(delta.fontSizes, base.fontSizes),
    fonts:
      freshDesign && delta.fonts && delta.fonts.length > 0
        ? delta.fonts
        : base.fonts.length > 0
          ? base.fonts
          : delta.fonts ?? base.fonts,
    borderRadius: mergeTokens(delta.borderRadius, base.borderRadius),
    spacing: mergeOptionalTokens(delta.spacing, base.spacing),
    materialSymbols: freshDesign
      ? delta.materialSymbols ?? base.materialSymbols
      // non-fresh: delta wins if it's true (additive), existing wins if already true
      : delta.materialSymbols || base.materialSymbols,
    customCss: freshDesign
      ? delta.customCss ?? base.customCss ?? ""
      : base.customCss || delta.customCss || "",
    bodyClasses: freshDesign
      ? delta.bodyClasses ?? base.bodyClasses
      : base.bodyClasses ?? delta.bodyClasses,
    headerHtml: delta.headerHtml ?? base.headerHtml,
    footerHtml: delta.footerHtml ?? base.footerHtml,
    headerEditableFields: delta.headerEditableFields ?? base.headerEditableFields,
    footerEditableFields: delta.footerEditableFields ?? base.footerEditableFields,
  };
}

// ---------------------------------------------------------------------------
// AI Router singleton — null until real providers are configured
// ---------------------------------------------------------------------------

let aiRouter: AIRouter | null = null;
let pageDesigner: PageDesigner | null = null;
let claudePageDesigner: ClaudePageDesigner | null = null;
/** Stitch-specific service for the debug import route (list/fetch screens). */
let stitchService: StitchDesignService | null = null;

/** Register an AIRouter instance once providers are ready. */
export function setAIRouter(router: AIRouter): void {
  aiRouter = router;
}

/** Register a PageDesigner implementation (e.g. StitchPageDesigner). */
export function setPageDesigner(designer: PageDesigner): void {
  pageDesigner = designer;
}

/** Register the Stitch design service. Also wires the default PageDesigner. */
export function setStitchService(service: StitchDesignService): void {
  stitchService = service;
  pageDesigner = new StitchPageDesigner(service);
}

/** Register a ClaudePageDesigner so it can be selected via site settings. */
export function setClaudePageDesigner(designer: ClaudePageDesigner): void {
  claudePageDesigner = designer;
}

/**
 * Resolve which PageDesigner to use for a given site. Priority:
 *   1. Explicit settings.pageDesigner === "stitch" → Stitch (opt-out of Claude)
 *   2. claudePageDesigner is configured → Claude (default when available)
 *   3. Fall back to globally registered pageDesigner (Stitch)
 */
function resolvePageDesigner(siteSettings: Record<string, unknown>): PageDesigner | null {
  if (siteSettings.pageDesigner === "stitch") {
    return pageDesigner;
  }
  if (claudePageDesigner) {
    return claudePageDesigner;
  }
  return pageDesigner;
}

export function getAIRouter(): AIRouter | null {
  return aiRouter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInterviewSystemPrompt(brief?: SiteBrief): string {
  const base = `You are Cadmus AI — a website expert conducting a conversational interview to build a site brief.

CONTENT POLICY — If the user describes a business that involves adult/pornographic content, illegal drugs, weapons trafficking, fraud/scams, hate groups, child exploitation, or illegal gambling, you MUST decline politely. Say: "I'm sorry, but Cadmus can't be used to create websites for that type of business. Our content policy prohibits [category]." Do not continue the interview.

Your goal is to gather the following information through natural conversation:
1. Business name and description
2. Location (if relevant)
3. Target audience
4. Key differentiators / what makes this business special
5. Desired tone and voice
6. Primary website goal (leads, sales, bookings, information, etc.)
7. Brand colors (any specific colors to use, hex values or descriptive names like "navy blue and orange")
8. Existing assets (logo, content)

Guidelines:
- Ask one or two questions at a time — do not overwhelm the user
- Be conversational and encouraging
- If the user gives a short answer, ask a follow-up to get more detail
- Summarize what you have so far when appropriate
- When you have enough information, confirm the brief with the user
- Be direct and honest — recommend best practices where relevant
- When the user confirms the brief is correct and complete, include the marker [BRIEF_COMPLETE] on its own line at the very end of your response`;

  if (!brief) return base;

  return `${base}

CURRENT BRIEF (gathered so far):
- Business: ${brief.businessName ?? "Not yet provided"} — ${brief.businessDescription ?? "Not yet provided"}
- Location: ${brief.location ?? "Not specified"}
- Target audience: ${brief.targetAudience ?? "Not specified"}
- Differentiators: ${brief.differentiators ?? "Not specified"}
- Tone: ${brief.tone ?? "Not specified"}
- Primary goal: ${brief.primaryGoal ?? "Not specified"}
- Brand colors: ${brief.brandColors ?? "Not specified"}
- Logo: ${brief.logoUrl ? "Uploaded ✓ (color analysis runs automatically at generation time — do not ask the user to describe logo colors)" : "Not uploaded"}`;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

function buildConversationPrompt(
  message: string,
  conversationHistory?: ConversationMessage[]
): string {
  let prompt = "";
  if (conversationHistory?.length) {
    for (const msg of conversationHistory) {
      prompt += `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}\n\n`;
    }
  }
  prompt += `User: ${message}`;
  return prompt;
}

async function fetchSite(siteId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  return site ?? null;
}

const INSPIRATION_ANALYSIS_PROMPT = `Analyze this website design or visual inspiration image. Extract the following design attributes in a concise format:

- COLOR PALETTE: List the dominant colors (hex values if identifiable, or descriptive names)
- TYPOGRAPHY FEEL: Describe the typography style (serif/sans-serif, weight, spacing feel)
- LAYOUT STYLE: Describe the layout approach (grid, asymmetric, full-width sections, card-based, etc.)
- VISUAL STYLE: Describe the overall aesthetic (minimalist, bold, editorial, playful, corporate, etc.)
- MOOD/ENERGY: Describe the emotional tone (calm, energetic, luxurious, approachable, etc.)
- KEY DESIGN ELEMENTS: Note any distinctive design patterns (gradients, overlapping elements, large imagery, whitespace usage, etc.)

Be concise. Output only the design attributes, no preamble.`;

async function analyzeInspirationImages(brief: SiteBrief, router: AIRouter | null): Promise<string | undefined> {
  if (!brief.inspirationImages?.length || !router) return undefined;

  const urls = brief.inspirationImages.slice(0, 5);
  const results = await Promise.allSettled(
    urls.map((imageUrl: string) =>
      router.analyzeImage({ imageUrl, prompt: INSPIRATION_ANALYSIS_PROMPT })
    )
  );

  const analyses: string[] = [];
  let failures = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.text) {
      analyses.push(r.value.text);
    } else if (r.status === "rejected") {
      failures += 1;
      console.warn(
        `[inspiration-analysis] failed for ${urls[i]}:`,
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    } else {
      failures += 1;
      console.warn(`[inspiration-analysis] empty response for ${urls[i]}`);
    }
  });

  if (failures > 0 && analyses.length === 0) {
    console.warn(
      `[inspiration-analysis] all ${urls.length} inspiration image(s) failed to analyze — Stitch will not receive any inspiration cues`,
    );
  } else if (failures > 0) {
    console.warn(
      `[inspiration-analysis] ${failures}/${urls.length} inspiration image(s) failed; proceeding with ${analyses.length} successful analysis(es)`,
    );
  }

  return analyses.length > 0 ? analyses.join("\n\n") : undefined;
}

const LOGO_COLOR_ANALYSIS_PROMPT = `Look at this logo and identify its dominant colors.

Output ONLY a comma-separated list of 1-4 colors that a designer would pick up from this logo to drive a website's color scheme. Use natural color names ("navy blue", "charcoal", "gold") or hex codes — whichever is more accurate for the logo.

Ignore pure white and pure black backgrounds unless the logo is *deliberately* monochrome on white/black. Skip near-neutrals (off-white, light gray) unless they're clearly part of the brand mark.

Examples of good output:
navy blue, white
forest green, cream
#1a365d, #ed8936
charcoal, gold

Output the colors only — no preamble, no explanation, no bullet points.`;

async function generateMetaDescription(
  brief: SiteBrief,
  title: string,
  pageType: string,
  pagePurpose: string | undefined,
  router: AIRouter,
): Promise<string | undefined> {
  const prompt = `Write a meta description for this web page.

Business: ${brief.businessName} — ${brief.businessDescription ?? ""}
Page title: ${title}
Page type: ${pageType}${pagePurpose ? `\nPage purpose: ${pagePurpose}` : ""}

Requirements:
- 150–160 characters (count carefully)
- Accurate and specific to this page — no generic filler
- Action-oriented where appropriate
- Do NOT start with the business name
- Output the meta description text only — no quotes, no label, no explanation`;

  try {
    const result = await router.generateText({ task: "seo", prompt, maxTokens: 100 });
    const text = result.text?.trim();
    if (!text) return undefined;
    // Truncate to 160 chars if the model over-runs
    return text.length <= 160 ? text : text.slice(0, 157) + "…";
  } catch {
    return undefined;
  }
}

async function analyzeLogoColors(logoUrl: string, router: AIRouter): Promise<string | undefined> {
  try {
    const result = await router.analyzeImage({
      imageUrl: logoUrl,
      prompt: LOGO_COLOR_ANALYSIS_PROMPT,
    });
    const cleaned = result.text.trim().replace(/^["'`]+|["'`]+$/g, "");
    return cleaned || undefined;
  } catch (err) {
    console.warn(
      `[logo-color-analysis] failed for ${logoUrl}:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/**
 * If a logo is uploaded but no brand colors were captured, vision-analyze
 * the logo and persist the result back onto the brief. Mutates the
 * passed-in brief in place so the caller can use the updated value
 * immediately. Idempotent: subsequent calls (e.g. parallel non-home
 * page-design runs) re-read the brief from DB and short-circuit.
 */
async function ensureBrandColorsFromLogo(
  brief: SiteBrief,
  siteId: string,
  router: AIRouter,
): Promise<void> {
  const existingColors = brief.brandColors?.trim().toLowerCase();
  if (!brief.logoUrl || (existingColors && existingColors !== "from logo")) return;

  const detected = await analyzeLogoColors(brief.logoUrl, router);
  if (!detected) return;

  brief.brandColors = detected;
  try {
    const [currentSite] = await db.select().from(sites).where(eq(sites.id, siteId));
    if (!currentSite) return;
    const currentBrief = (currentSite.brief ?? {}) as Record<string, unknown>;
    if ((currentBrief.brandColors as string | undefined)?.trim()) return;
    await db.update(sites)
      .set({ brief: { ...currentBrief, brandColors: detected } })
      .where(eq(sites.id, siteId));
    console.log(`logo-color-analysis: detected "${detected}" — persisted to brief for site ${siteId}`);
  } catch (err) {
    console.warn("Failed to persist detected logo colors to brief:", err);
  }
}

// ---------------------------------------------------------------------------
// Generate a color palette from the site brief (Claude designer sites only)
// ---------------------------------------------------------------------------

/**
 * When a Claude-designed site has no theme colors yet, generate a proper
 * hex color palette from the brief so Claude can design with real colors
 * and the live site CSS vars resolve to something meaningful.
 * Idempotent — skips if colors are already present.
 */
async function ensureThemeColors(
  brief: SiteBrief,
  siteId: string,
  theme: SiteTheme,
  router: AIRouter,
): Promise<SiteTheme> {
  if (theme.colors && Object.keys(theme.colors).length > 0) return theme;

  const brandColorsInstruction = brief.brandColors
    ? `REQUIRED BRAND COLOR: The user specified "${brief.brandColors}" as their brand color. You MUST use this as the "primary" color (convert descriptive names like "burgundy" to the closest standard hex value). This is non-negotiable — do not substitute a different color.`
    : "";

  const prompt = `Generate a cohesive color palette and font pairing for a website. Return ONLY a JSON object.

Business: ${brief.businessName}
Description: ${brief.businessDescription}
${brief.tone ? `Tone/vibe: ${brief.tone}` : ""}
${brandColorsInstruction}

Required JSON format (hex colors, Google Font names):
{
  "colors": {
    "primary": "#...",
    "accent": "#...",
    "bg": "#...",
    "text": "#...",
    "textMuted": "#..."
  },
  "fonts": {
    "heading": "Font Name",
    "body": "Font Name"
  }
}

Rules:
- primary: the dominant brand color (headings, logo, key UI elements)${brief.brandColors ? ` — MUST be the user's specified brand color "${brief.brandColors}"` : ""}
- accent: a punchy CTA/highlight color (buttons, links) — should pop against background; choose a complementary color if not specified
- bg: the page base color (light or dark — commit to one direction)
- text: main body text — MUST have high contrast with bg (4.5:1 minimum)
- textMuted: secondary/muted text — readable but subtler than text
- heading font: a distinctive, characterful Google Font (avoid Inter, Roboto, Arial, system fonts)
- body font: a clean, readable Google Font that pairs well with the heading font
- Output ONLY the JSON object, nothing else`;

  try {
    const result = await router.generateText({ task: "copywriting", prompt, maxTokens: 150 });
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in palette response");
    const parsed = JSON.parse(jsonMatch[0]) as { colors?: Record<string, string>; fonts?: Record<string, string> };

    const palette = parsed.colors ?? (parsed as unknown as Record<string, string>);
    const required = ["primary", "accent", "bg", "text", "textMuted"];
    if (!required.every((k) => typeof palette[k] === "string" && palette[k].startsWith("#"))) {
      throw new Error("Invalid palette keys/values");
    }

    const fontFamilies: Record<string, string[]> = {};
    if (parsed.fonts?.heading) fontFamilies.heading = [parsed.fonts.heading, "sans-serif"];
    if (parsed.fonts?.body) fontFamilies.body = [parsed.fonts.body, "sans-serif"];

    const updatedTheme: SiteTheme = {
      ...theme,
      colors: palette,
      fontFamilies: Object.keys(fontFamilies).length > 0 ? fontFamilies : theme.fontFamilies,
    };
    try {
      const [currentSite] = await db.select().from(sites).where(eq(sites.id, siteId));
      if (currentSite) {
        const existingSettings = (currentSite.settings ?? {}) as Record<string, unknown>;
        const existingTheme = (existingSettings.theme ?? {}) as SiteTheme;
        if (!existingTheme.colors || Object.keys(existingTheme.colors).length === 0) {
          await db.update(sites).set({
            settings: {
              ...existingSettings,
              theme: {
                ...existingTheme,
                colors: palette,
                ...(Object.keys(fontFamilies).length > 0 ? { fontFamilies } : {}),
              },
            },
          }).where(eq(sites.id, siteId));
          console.log(`color-palette: generated for ${brief.businessName}: colors=${JSON.stringify(palette)}, fonts=${JSON.stringify(fontFamilies)}`);
        }
      }
    } catch (err) {
      console.warn("Failed to persist generated color palette:", err);
    }
    return updatedTheme;
  } catch (err) {
    console.warn("Color palette generation failed, proceeding without colors:", err);
    return theme;
  }
}

// ---------------------------------------------------------------------------
// Extract footer nav and social links from Stitch/Claude footer HTML,
// and header nav links from Claude header HTML.
// ---------------------------------------------------------------------------

async function extractAndSaveHeaderNav(
  headerHtml: string | undefined,
  siteId: string,
): Promise<void> {
  if (!headerHtml) return;

  try {
    // extractFooterData works on any HTML — it finds <a href> tags with readable text.
    // Claude headers use href="#" for the logo (filtered out) and real hrefs for nav links.
    const headerData = extractFooterData(headerHtml);

    if (headerData.navItems.length > 0) {
      const existingHeaderNav = await db
        .select()
        .from(navigation)
        .where(eq(navigation.siteId, siteId))
        .then((rows) => rows.find((r) => r.location === "header"));

      if (!existingHeaderNav) {
        await db.insert(navigation).values({
          siteId,
          location: "header",
          items: headerData.navItems,
        });
        console.log(`Header nav: extracted ${headerData.navItems.length} items from Claude header`);
      }
    }
  } catch (err) {
    console.warn("Failed to extract header nav:", err);
  }
}

async function extractAndSaveFooterData(
  footerHtml: string | undefined,
  siteId: string,
): Promise<void> {
  if (!footerHtml) return;

  try {
    const footerData = extractFooterData(footerHtml);

    // Save footer nav items (only if we found any and none exist yet)
    if (footerData.navItems.length > 0) {
      const existingFooterNav = await db
        .select()
        .from(navigation)
        .where(eq(navigation.siteId, siteId))
        .then((rows) => rows.find((r) => r.location === "footer"));

      if (!existingFooterNav) {
        await db.insert(navigation).values({
          siteId,
          location: "footer",
          items: footerData.navItems,
        });
        console.log(`Footer nav: extracted ${footerData.navItems.length} items from Stitch footer`);
      }
    }

    // Save social links to site settings
    if (footerData.socialLinks.length > 0) {
      const [currentSite] = await db.select().from(sites).where(eq(sites.id, siteId));
      if (currentSite) {
        const settings = (currentSite.settings ?? {}) as Record<string, unknown>;
        if (!settings.socialLinks) {
          await db.update(sites).set({
            settings: { ...settings, socialLinks: footerData.socialLinks },
          }).where(eq(sites.id, siteId));
          console.log(`Social links: extracted ${footerData.socialLinks.length} from Stitch footer`);
        }
      }
    }
  } catch (err) {
    console.warn("Failed to extract footer data:", err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/ai/interview — Conversational site brief interview
// ---------------------------------------------------------------------------

aiRoutes.post("/interview", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { message, conversationHistory } = body as {
    message: string;
    conversationHistory?: ConversationMessage[];
  };

  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }

  // Content policy check
  const policyCheck = checkContentPolicy(message);
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  const site = await fetchSite(siteId);
  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  const brief = site.brief as SiteBrief | undefined;
  const systemPrompt = buildInterviewSystemPrompt(brief ?? undefined);
  const prompt = buildConversationPrompt(message, conversationHistory);

  const router = getAIRouter();

  let responseText: string;
  let model: string;
  let usedFallback = false;

  if (router) {
    const result = await router.generateText({
      task: "interview",
      systemPrompt,
      prompt,
      temperature: 0.7,
      maxTokens: 1024,
    });
    responseText = result.text;
    model = result.model;
    usedFallback = result.usedFallback;
  } else {
    // Mock response when AI providers are not yet configured
    responseText =
      "Thanks for sharing that! I'm currently in setup mode — AI providers haven't been configured yet. " +
      "Once connected, I'll conduct a full conversational interview to build your site brief. " +
      "For now, you can manually fill in your site brief through the site settings.";
    model = "mock";
  }

  // Log to aiHistory
  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "interview",
    action: `interview message: ${message.slice(0, 200)}`,
    suggestion: responseText,
    model,
    usedFallback: usedFallback ? 1 : 0,
  });

  return c.json({
    response: responseText,
    model,
    usedFallback,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/extract-brief — Extract SiteBrief from conversation
// ---------------------------------------------------------------------------

aiRoutes.post("/extract-brief", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { conversationHistory } = body as {
    conversationHistory: ConversationMessage[];
  };

  if (!conversationHistory?.length) {
    return c.json({ error: "conversationHistory is required" }, 400);
  }

  // Content policy check on conversation messages
  const policyCheck = checkContentPolicyBulk(
    conversationHistory.filter((m) => m.role === "user").map((m) => m.content)
  );
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  const systemPrompt = `You are a data extraction assistant. Analyze the following conversation and extract a site brief as strict JSON.

Return ONLY valid JSON with this exact shape (no markdown, no explanation):
{
  "businessName": "string (required)",
  "businessDescription": "string (required)",
  "location": "string or null",
  "targetAudience": "string or null",
  "differentiators": "string or null",
  "tone": "string or null",
  "primaryGoal": "string or null",
  "brandColors": "string or null (e.g. 'navy blue and orange', '#1a365d, #ed8936', 'forest green'). If the user said to use colors from their uploaded logo (e.g. 'use my logo colors', 'match my logo', 'pull colors from the logo'), set this to 'from logo' — do NOT leave it null.",
  "constraints": ["array of strings — explicit user prohibitions and hard requirements about the website, verbatim where possible"],
  "pages": [
    { "type": "homepage", "slug": "home", "purpose": "Main landing page with hero and key value propositions" }
  ]
}

Extract values from the full conversation — including information the assistant summarized or confirmed and the user agreed to. If the assistant presented a brief summary and the user approved it (e.g. "yes", "looks good", "that's right"), treat those summarized values as confirmed. Only use null if a field was genuinely not discussed or established at any point.

For "constraints": capture EVERY explicit "do not / don't / never / avoid / no / must not / always / must" style directive the user gave about the website — e.g. "do not use stock photos", "never include a testimonials section", "no carousels", "always show the phone number in the header". Include hard must-have requirements too. Keep each as a short, single directive close to the user's wording. If there are none, use an empty array []. Do NOT invent constraints the user did not state.

For "pages": extract the list of pages discussed in the conversation. Each page needs:
- "type": a descriptive type like "homepage", "about", "services", "contact", "blog", "portfolio", "pricing", "faq", "testimonials", etc.
- "slug": a URL-friendly slug (e.g. "home", "about", "services")
- "purpose": a one-sentence description of what this page should accomplish for the business

Always include "homepage" (slug: "home") and "about" (slug: "about") at minimum. If the user discussed specific pages, include those. If they didn't mention pages explicitly, infer 3-5 sensible pages based on the business type and goals.`;

  let prompt = "Extract the site brief from this conversation:\n\n";
  for (const msg of conversationHistory) {
    prompt += `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}\n\n`;
  }

  const router = getAIRouter();

  let briefData: Record<string, unknown>;
  let model: string;
  let usedFallback = false;

  if (router) {
    const result = await router.generateText({
      task: "interview",
      systemPrompt,
      prompt,
      temperature: 0.2,
      maxTokens: 1536,
    });
    model = result.model;
    usedFallback = result.usedFallback;

    // Parse JSON from response — strip markdown fences if present
    let jsonText = result.text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonText = fenceMatch[1].trim();
    }

    try {
      briefData = JSON.parse(jsonText);
    } catch {
      return c.json({ error: "Failed to parse AI response as JSON", raw: result.text }, 500);
    }
  } else {
    // Mock fallback
    briefData = {
      businessName: "My Business",
      businessDescription: "A great business that serves customers well.",
      location: null,
      targetAudience: null,
      differentiators: null,
      tone: "Professional and friendly",
      primaryGoal: "Generate leads",
      pages: [
        { type: "homepage", slug: "home", purpose: "Main landing page" },
        { type: "about", slug: "about", purpose: "About the business" },
      ],
    };
    model = "mock";
  }

  // Validate required fields
  if (!briefData.businessName || !briefData.businessDescription) {
    return c.json({
      error: "Extracted brief missing required fields",
      brief: briefData,
    }, 422);
  }

  // Log to aiHistory
  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "interview",
    action: "extract-brief from conversation",
    suggestion: JSON.stringify(briefData),
    model,
    usedFallback: usedFallback ? 1 : 0,
  });

  return c.json({
    brief: briefData,
    model,
    usedFallback,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/parse-brief — Parse freeform text/copy into a SiteBrief
// ---------------------------------------------------------------------------

aiRoutes.post("/parse-brief", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { text } = body as { text: string };

  if (!text?.trim()) {
    return c.json({ error: "text is required" }, 400);
  }

  const policyCheck = checkContentPolicy(text);
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  const systemPrompt = `You are a data extraction assistant. Analyze the following text — which may be brand copy, a creative brief, brand guidelines, a business description, or any notes about a website — and extract a site brief as strict JSON.

Return ONLY valid JSON with this exact shape (no markdown, no explanation):
{
  "businessName": "string (required)",
  "businessDescription": "string (required)",
  "location": "string or null",
  "targetAudience": "string or null",
  "differentiators": "string or null",
  "tone": "string or null",
  "primaryGoal": "string or null",
  "brandColors": "string or null (e.g. 'navy blue and orange', '#1a365d, #ed8936')",
  "constraints": ["array of strings — explicit user prohibitions and hard requirements, verbatim where possible"],
  "pages": [
    { "type": "homepage", "slug": "home", "purpose": "Main landing page with hero and key value propositions" }
  ]
}

Extract values directly from the provided text. If a field is not present or cannot be inferred, use null.

For "constraints": capture EVERY explicit "do not / don't / never / avoid / no / must not / always / must" style directive the user gives about the website — e.g. "do not use stock photos", "never include a testimonials section", "no carousels", "always show the phone number in the header". Include hard must-have requirements too. Keep each as a short, single directive close to the user's wording. If there are none, use an empty array []. Do NOT invent constraints that the user did not state.

For "pages": infer a sensible set of pages (3-6) based on the business type described. Always include "homepage" (slug: "home"). Add "about", "services", "contact", and other pages that logically match the business.`;

  const router = getAIRouter();

  let briefData: Record<string, unknown>;
  let model: string;
  let usedFallback = false;

  if (router) {
    const result = await router.generateText({
      task: "interview",
      systemPrompt,
      prompt: `Extract the site brief from the following text:\n\n${text}`,
      temperature: 0.2,
      maxTokens: 1536,
    });
    model = result.model;
    usedFallback = result.usedFallback;

    let jsonText = result.text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonText = fenceMatch[1].trim();
    }

    try {
      briefData = JSON.parse(jsonText);
    } catch {
      return c.json({ error: "Failed to parse AI response as JSON", raw: result.text }, 500);
    }
  } else {
    briefData = {
      businessName: "My Business",
      businessDescription: text.slice(0, 200),
      location: null,
      targetAudience: null,
      differentiators: null,
      tone: null,
      primaryGoal: null,
      pages: [
        { type: "homepage", slug: "home", purpose: "Main landing page" },
        { type: "about", slug: "about", purpose: "About the business" },
      ],
    };
    model = "mock";
  }

  if (!briefData.businessName || !briefData.businessDescription) {
    return c.json({
      error: "Could not extract required fields (businessName, businessDescription) from the provided text",
      brief: briefData,
    }, 422);
  }

  // Preserve the user's original brief text so no instruction is silently lost
  // in structured extraction (constraints can be re-derived from it downstream).
  briefData.rawBrief = text;

  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "interview",
    action: "parse-brief from text",
    suggestion: JSON.stringify(briefData),
    model,
    usedFallback: usedFallback ? 1 : 0,
  });

  return c.json({ brief: briefData, model, usedFallback });
});

// ---------------------------------------------------------------------------
// POST /api/ai/generate — Content generation
// ---------------------------------------------------------------------------

aiRoutes.post("/generate", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { task, prompt, contentType, context } = body as {
    task: AITaskType;
    prompt: string;
    contentType?: string;
    context?: Record<string, unknown>;
  };

  if (!task || !prompt) {
    return c.json({ error: "task and prompt are required" }, 400);
  }

  // Content policy check
  const policyCheck = checkContentPolicy(prompt);
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  const site = await fetchSite(siteId);
  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  const brief = site.brief as SiteBrief | undefined;

  // Build a system prompt that incorporates site context
  let systemPrompt =
    "You are Cadmus AI — a website expert with deep experience in direct response marketing copy, " +
    "UX principles, conversion rate optimization (CRO), and SEO. " +
    "Write copy that has a job: inform, persuade, or convert. Be direct and concise.";

  if (brief) {
    systemPrompt += `\n\nSITE CONTEXT:\n- Business: ${brief.businessName} — ${brief.businessDescription}`;
    if (brief.targetAudience) systemPrompt += `\n- Target audience: ${brief.targetAudience}`;
    if (brief.tone) systemPrompt += `\n- Tone: ${brief.tone}`;
    if (brief.primaryGoal) systemPrompt += `\n- Primary goal: ${brief.primaryGoal}`;
  }

  if (contentType) {
    systemPrompt += `\n\nContent type requested: ${contentType}`;
  }

  if (context) {
    systemPrompt += `\n\nAdditional context: ${JSON.stringify(context)}`;
  }

  const router = getAIRouter();

  let responseText: string;
  let model: string;
  let usedFallback = false;

  if (router) {
    const result = await router.generateText({
      task,
      systemPrompt,
      prompt,
      temperature: 0.7,
      maxTokens: 2048,
    });
    responseText = result.text;
    model = result.model;
    usedFallback = result.usedFallback;
  } else {
    responseText =
      "AI providers are not yet configured. Once connected, I'll generate " +
      `${contentType ?? "content"} based on your prompt. ` +
      "Please configure your AI providers in the settings to enable content generation.";
    model = "mock";
  }

  // Log to aiHistory
  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: task,
    action: `generate ${contentType ?? "content"}: ${prompt.slice(0, 200)}`,
    suggestion: responseText,
    model,
    usedFallback: usedFallback ? 1 : 0,
  });

  return c.json({
    text: responseText,
    model,
    usedFallback,
    task,
    contentType: contentType ?? null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/generate-image — AI image generation via Imagen
// ---------------------------------------------------------------------------

aiRoutes.post("/generate-image", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { prompt, aspectRatio } = body as {
    prompt: string;
    aspectRatio?: string;
  };

  if (!prompt) {
    return c.json({ error: "prompt is required" }, 400);
  }

  const policyCheck = checkImagePrompt(prompt);
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  // Feature gate: free-tier image generation limit
  const imageGate = await checkFeatureGate(siteId, "ai_image_generation");
  if (!imageGate.allowed) {
    return c.json({ error: imageGate.reason || "Image generation limit reached", gate: imageGate }, 429);
  }

  const router = getAIRouter();
  if (!router) {
    return c.json({ error: "AI providers not configured" }, 503);
  }

  if (!storageProvider) {
    return c.json({ error: "Storage provider not configured" }, 503);
  }

  let result;
  try {
    result = await router.generateImage({ prompt, aspectRatio });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no image data") || msg.includes("Image generation returned")) {
      return c.json({ error: "Your image could not be generated. The prompt may contain content that violates our image generation policy. Please try a different description." }, 422);
    }
    throw err;
  }

  // Optimize: convert to WebP and resize
  const rawBuffer = Buffer.from(result.imageBytes, "base64");
  const optimized = await optimizeImage(rawBuffer, result.mimeType, { maxWidth: IMAGE_PRESETS.content });
  const ext = mimeToExt(optimized.mimeType);
  const filename = promptToFilename(prompt, ext);
  const storagePath = `sites/${siteId}/media/${filename}`;
  const uploadResult = await storageProvider.upload(optimized.buffer, storagePath, optimized.mimeType, "public, max-age=604800");

  // Create media record with descriptive alt text
  const altText = prompt.length > 300 ? prompt.slice(0, 297) + "..." : prompt;
  const [mediaItem] = await db
    .insert(media)
    .values({
      siteId,
      filename,
      storageUrl: uploadResult.url,
      mimeType: optimized.mimeType,
      aiAltText: altText,
      uploadedBy: null,
    })
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "ai",
    actorId: null,
    action: "media.generated",
    entityType: "media",
    entityId: mediaItem.id,
    details: { prompt: prompt.slice(0, 200), model: result.model, optimized: true, width: optimized.width, height: optimized.height },
  });

  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "image",
    action: `generate image: ${prompt.slice(0, 200)}`,
    suggestion: uploadResult.url,
    model: result.model,
    usedFallback: result.usedFallback ? 1 : 0,
  });

  // Increment image generation usage for free-tier tracking
  const imagePeriod = new Date().toISOString().slice(0, 7);
  incrementUsage(siteId, "image_generation", imagePeriod).catch((err) =>
    console.warn("Failed to increment image generation usage:", err)
  );

  return c.json({ url: uploadResult.url, mediaId: mediaItem.id, filename, altText });
});

// ---------------------------------------------------------------------------
// POST /api/ai/enqueue-page-images — queue Imagen generation for all placeholders in a page
// ---------------------------------------------------------------------------

aiRoutes.post("/enqueue-page-images", async (c) => {
  const siteId = c.get("site").siteId;
  const userId = c.get("user")?.id ?? null;
  const body = await c.req.json();
  const { contentId, imagePrompts } = body as {
    contentId: string;
    imagePrompts: Array<{ blockIndex: number; placeholderSrc: string; prompt: string; aspectRatio: string }>;
  };

  if (!contentId || !Array.isArray(imagePrompts) || imagePrompts.length === 0) {
    return c.json({ jobIds: [] });
  }

  const router = getAIRouter();
  if (!router || !storageProvider) return c.json({ jobIds: [] });

  const jobIds: string[] = [];
  for (let idx = 0; idx < imagePrompts.length; idx++) {
    const img = imagePrompts[idx];
    // Small stagger to avoid all images on a page hitting simultaneously
    const delaySec = idx * 3;
    const { jobId } = await enqueueJob({
      siteId,
      type: "generate-image",
      payload: img as unknown as Record<string, unknown>,
      createdBy: userId,
      runner: async () => {
        if (delaySec > 0) await new Promise((r) => setTimeout(r, delaySec * 1000));
        return runGeneratePageImage({ siteId, contentId, ...img, router });
      },
    });
    jobIds.push(jobId);
  }

  console.log(`enqueue-page-images: queued ${jobIds.length} image jobs for content ${contentId} (staggered by 3s each)`);
  return c.json({ jobIds });
});

// ---------------------------------------------------------------------------
// POST /api/ai/generate-favicon — Generate a square favicon via Imagen
// Returns a media record without persisting to site settings; the admin
// previews the result and saves separately via PATCH /api/sites/:id.
// ---------------------------------------------------------------------------

aiRoutes.post("/generate-favicon", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json().catch(() => ({}));
  const { prompt: userPrompt } = body as { prompt?: string };

  const router = getAIRouter();
  if (!router) return c.json({ error: "AI providers not configured" }, 503);
  if (!storageProvider) return c.json({ error: "Storage provider not configured" }, 503);

  const site = await fetchSite(siteId);
  if (!site) return c.json({ error: "Site not found" }, 404);

  const settings = (site.settings as Record<string, unknown>) || {};
  const brief = (site.brief as Record<string, unknown>) || {};
  const theme = (settings.theme as Record<string, unknown> | undefined) || {};
  const colors = (theme.colors as Record<string, string> | undefined) || {};
  const businessDescription = (brief.businessDescription as string | undefined) || "";
  const logoUrl = (brief.logoUrl as string | undefined) || "";

  const colorHints = Object.entries(colors)
    .filter(([k]) => /primary|accent|brand/i.test(k))
    .slice(0, 3)
    .map(([, v]) => v)
    .join(", ");

  const promptParts = [
    "A simple, modern, square favicon icon for a website.",
    "Bold, high-contrast, instantly recognizable at 16x16 pixels.",
    "Centered subject with clean negative space, flat vector style, no text, no photo-realism, no watermark.",
    site.name ? `Brand: "${site.name}".` : "",
    businessDescription ? `Business: ${businessDescription.slice(0, 200)}.` : "",
    logoUrl ? `If a brand logo exists, infer its visual motif and reduce it to a single iconic glyph.` : "",
    colorHints ? `Use brand colors: ${colorHints}.` : "",
    userPrompt ? `User direction: ${userPrompt.slice(0, 200)}.` : "",
  ].filter(Boolean);
  const prompt = promptParts.join(" ");

  const policyCheck = checkContentPolicy(prompt);
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  const result = await router.generateImage({ prompt, aspectRatio: "1:1" });

  const rawBuffer = Buffer.from(result.imageBytes, "base64");
  const optimized = await optimizeImage(rawBuffer, result.mimeType, { maxWidth: 512, format: "png" });

  const filename = `favicon-${Date.now()}.png`;
  const storagePath = `sites/${siteId}/media/${filename}`;
  const uploadResult = await storageProvider.upload(optimized.buffer, storagePath, "image/png", "public, max-age=604800");

  const altText = `${site.name || "Site"} favicon`;
  const [mediaItem] = await db
    .insert(media)
    .values({
      siteId,
      filename,
      storageUrl: uploadResult.url,
      mimeType: "image/png",
      aiAltText: altText,
      uploadedBy: null,
    })
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "ai",
    actorId: null,
    action: "favicon.generated",
    entityType: "media",
    entityId: mediaItem.id,
    details: { model: result.model, width: optimized.width, height: optimized.height },
  });

  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "image",
    action: `generate favicon`,
    suggestion: uploadResult.url,
    model: result.model,
    usedFallback: result.usedFallback ? 1 : 0,
  });

  return c.json({ url: uploadResult.url, mediaId: mediaItem.id, filename });
});

// ---------------------------------------------------------------------------
// POST /api/ai/generate-logo — Generate a logo mark via Imagen
// Like generate-favicon, but produces a larger brand mark on a clean
// background, suitable for the header/footer wordmark slot. Returns a media
// record without persisting; the admin previews then saves to settings.logoUrl.
// Note: text-to-image models render lettering unreliably, so we ask for an
// icon-only mark (no text) rather than a typeset wordmark.
// ---------------------------------------------------------------------------

aiRoutes.post("/generate-logo", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json().catch(() => ({}));
  const { prompt: userPrompt } = body as { prompt?: string };

  const router = getAIRouter();
  if (!router) return c.json({ error: "AI providers not configured" }, 503);
  if (!storageProvider) return c.json({ error: "Storage provider not configured" }, 503);

  const site = await fetchSite(siteId);
  if (!site) return c.json({ error: "Site not found" }, 404);

  const settings = (site.settings as Record<string, unknown>) || {};
  const brief = (site.brief as Record<string, unknown>) || {};
  const theme = (settings.theme as Record<string, unknown> | undefined) || {};
  const colors = (theme.colors as Record<string, string> | undefined) || {};
  const businessName = (brief.businessName as string | undefined) || site.name || "";
  const businessDescription = (brief.businessDescription as string | undefined) || "";

  const colorHints = Object.entries(colors)
    .filter(([k]) => /primary|accent|brand/i.test(k))
    .slice(0, 3)
    .map(([, v]) => v)
    .join(", ");

  const promptParts = [
    "A clean, modern logo mark (brand symbol / icon) for a website.",
    "Flat vector style, simple geometric or organic glyph, bold and memorable, balanced composition.",
    "Centered subject on a plain solid background, generous negative space.",
    "NO text, NO letters, NO words, no photo-realism, no watermark, no gradients-heavy clutter.",
    businessName ? `Brand: "${businessName}".` : "",
    businessDescription ? `What the brand does: ${businessDescription.slice(0, 200)}.` : "",
    colorHints ? `Use brand colors: ${colorHints}.` : "",
    userPrompt ? `User direction: ${userPrompt.slice(0, 200)}.` : "",
  ].filter(Boolean);
  const prompt = promptParts.join(" ");

  const policyCheck = checkContentPolicy(prompt);
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  const result = await router.generateImage({ prompt, aspectRatio: "1:1" });

  const rawBuffer = Buffer.from(result.imageBytes, "base64");
  const optimized = await optimizeImage(rawBuffer, result.mimeType, { maxWidth: 512, format: "png" });

  const filename = `logo-${Date.now()}.png`;
  const storagePath = `sites/${siteId}/media/${filename}`;
  const uploadResult = await storageProvider.upload(optimized.buffer, storagePath, "image/png", "public, max-age=604800");

  const altText = `${businessName || "Site"} logo`;
  const [mediaItem] = await db
    .insert(media)
    .values({
      siteId,
      filename,
      storageUrl: uploadResult.url,
      mimeType: "image/png",
      aiAltText: altText,
      uploadedBy: null,
    })
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "ai",
    actorId: null,
    action: "logo.generated",
    entityType: "media",
    entityId: mediaItem.id,
    details: { model: result.model, width: optimized.width, height: optimized.height },
  });

  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "image",
    action: `generate logo`,
    suggestion: uploadResult.url,
    model: result.model,
    usedFallback: result.usedFallback ? 1 : 0,
  });

  return c.json({ url: uploadResult.url, mediaId: mediaItem.id, filename });
});

// ---------------------------------------------------------------------------
// POST /api/ai/analyze — Content analysis (CRO/SEO)
// ---------------------------------------------------------------------------

aiRoutes.post("/analyze", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { contentId } = body as {
    contentId: string;
  };

  if (!contentId) {
    return c.json({ error: "contentId is required" }, 400);
  }

  const site = await fetchSite(siteId);
  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  // Fetch the content and its blocks
  const [contentItem] = await db
    .select()
    .from(content)
    .where(eq(content.id, contentId));

  if (!contentItem) {
    return c.json({ error: "Content not found" }, 404);
  }

  if (contentItem.siteId !== siteId) {
    return c.json({ error: "Content does not belong to this site" }, 403);
  }

  const blocks = await db
    .select()
    .from(contentBlocks)
    .where(eq(contentBlocks.contentId, contentId))
    .orderBy(contentBlocks.position);

  const brief = site.brief as SiteBrief | undefined;

  // Build analysis prompt
  const systemPrompt =
    "You are Cadmus AI — a website expert specializing in CRO and SEO analysis. " +
    "Analyze the following page content and provide actionable recommendations. " +
    "Focus on: headline effectiveness, CTA clarity, copy persuasiveness, SEO issues, " +
    "content hierarchy, mobile readability, and conversion optimization. " +
    "Be specific and prioritize recommendations by impact.";

  const contentSummary = {
    type: contentItem.type,
    slug: contentItem.slug,
    status: contentItem.status,
    schemaData: contentItem.schemaData,
    blocks: blocks.map((b) => ({ blockType: b.blockType, data: b.data })),
  };

  let prompt = `Analyze this ${contentItem.type} page (slug: "${contentItem.slug}"):\n\n`;
  prompt += JSON.stringify(contentSummary, null, 2);

  if (brief) {
    prompt += `\n\nBusiness context:\n- Business: ${brief.businessName} — ${brief.businessDescription}`;
    if (brief.primaryGoal) prompt += `\n- Primary goal: ${brief.primaryGoal}`;
    if (brief.targetAudience) prompt += `\n- Target audience: ${brief.targetAudience}`;
  }

  const router = getAIRouter();

  let responseText: string;
  let model: string;
  let usedFallback = false;

  if (router) {
    const result = await router.generateText({
      task: "analysis",
      systemPrompt,
      prompt,
      temperature: 0.4,
      maxTokens: 2048,
    });
    responseText = result.text;
    model = result.model;
    usedFallback = result.usedFallback;
  } else {
    responseText =
      "AI providers are not yet configured. Once connected, I'll provide a full CRO and SEO analysis " +
      `of your ${contentItem.type} page "${contentItem.slug}". ` +
      "Please configure your AI providers in the settings to enable content analysis.";
    model = "mock";
  }

  // Log to aiHistory
  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "analysis",
    action: `analyze ${contentItem.type}: ${contentItem.slug}`,
    suggestion: responseText,
    model,
    usedFallback: usedFallback ? 1 : 0,
  });

  return c.json({
    analysis: responseText,
    model,
    usedFallback,
    contentId,
    contentType: contentItem.type,
    slug: contentItem.slug,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/design-page — Generate page design via Stitch + AI blocks
// ---------------------------------------------------------------------------

aiRoutes.post("/design-page", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { pageType, pagePurpose, contentId, target, skipThemeWrite, debug } = body as {
    pageType: string;
    pagePurpose?: string;
    contentId?: string;
    target?: "post-template";
    skipThemeWrite?: boolean;
    debug?: boolean;
  };

  if (!pageType) {
    return c.json({ error: "pageType is required" }, 400);
  }

  const isPostTemplate = target === "post-template";

  const router = getAIRouter();
  if (!router) {
    return c.json({ error: "AI providers are not configured" }, 503);
  }

  const siteData = await fetchSite(siteId);
  if (!siteData) {
    return c.json({ error: "Site not found" }, 404);
  }

  const siteSettings = (siteData.settings ?? {}) as Record<string, unknown>;
  const designer = resolvePageDesigner(siteSettings);
  if (!designer) {
    return c.json({ error: "Page designer is not configured" }, 503);
  }

  const brief = siteData.brief as SiteBrief | undefined;
  if (!brief?.businessName) {
    return c.json({ error: "Site brief is required — complete the interview first" }, 422);
  }

  const policyCheck = checkContentPolicyBulk([
    brief.businessName,
    brief.businessDescription,
    brief.primaryGoal,
    pagePurpose,
    pageType,
  ]);
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  // Feature gate: free-tier page count limit
  const pageCountGate = await checkFeatureGate(siteId, "page_count");
  if (!pageCountGate.allowed) {
    return c.json({ error: pageCountGate.reason || "Page limit reached on the free plan", gate: pageCountGate }, 403);
  }

  const userId = c.get("user")?.id ?? null;
  const aiRouter = router;

  const { jobId } = await enqueueJob({
    siteId,
    type: "design-page",
    payload: { pageType, pagePurpose, contentId, target, skipThemeWrite, debug },
    createdBy: userId,
    runner: async () => runDesignPage({
      siteId,
      pageType,
      pagePurpose,
      contentId,
      isPostTemplate,
      skipThemeWrite: !!skipThemeWrite,
      debug: !!debug,
      brief,
      siteData,
      designer,
      router: aiRouter,
    }),
  });

  return c.json({ jobId });
});

async function runDesignPage(opts: {
  siteId: string;
  pageType: string;
  pagePurpose?: string;
  contentId?: string;
  isPostTemplate: boolean;
  skipThemeWrite: boolean;
  debug?: boolean;
  brief: SiteBrief;
  siteData: { settings: unknown };
  designer: PageDesigner;
  router: AIRouter;
}) {
  const { siteId, pageType, pagePurpose, contentId, isPostTemplate, skipThemeWrite, debug, brief, siteData, designer, router } = opts;

  let existingContent: string | undefined;
  if (contentId) {
    const [contentItem] = await db
      .select()
      .from(content)
      .where(eq(content.id, contentId));
    if (contentItem && contentItem.siteId === siteId) {
      const blocks = await db
        .select()
        .from(contentBlocks)
        .where(eq(contentBlocks.contentId, contentId))
        .orderBy(contentBlocks.position);
      existingContent = blocks
        .map((b) => `${b.blockType}: ${JSON.stringify(b.data).slice(0, 200)}`)
        .join("\n");
    }
  }

  const settings = (siteData.settings ?? {}) as Record<string, unknown>;
  let currentTheme = settings.theme as SiteTheme | undefined;

  await ensureBrandColorsFromLogo(brief, siteId, router);

  // For Claude-designed sites: generate a color palette if none exists yet.
  // This ensures CSS vars resolve to real brand colors on the live site.
  if (designer.name === "claude") {
    currentTheme = await ensureThemeColors(brief, siteId, currentTheme ?? themeFallback(), router);
  }

  const inspirationAnalysis = await analyzeInspirationImages(brief, router);

  // The realized design direction from the homepage. Absent on the homepage
  // itself (it's synthesized from it afterward); present for later pages so
  // they cohere with the established look rather than re-inventing one.
  const designIntent = settings.designIntent as DesignIntent | undefined;

  const designResult = await designer.designPage({
    brief,
    pageType,
    pagePurpose,
    theme: currentTheme ?? themeFallback(),
    existingContent,
    inspirationAnalysis,
    designerState: currentTheme?.designerState,
    designIntent,
  });

  let debugHtmlUrl: string | undefined;
  if (debug && storageProvider) {
    try {
      const path = `debug/design-${siteId}-${Date.now()}.html`;
      await storageProvider.upload(Buffer.from(designResult.html), path, 'text/html', 'no-store');
      // The media bucket is public-read, so a signed URL (which needs signBlob,
      // unreliable on Cloud Run) was pointless here — return the public URL.
      debugHtmlUrl = storageProvider.getPublicUrl(path);
      console.log(`design-page: debug HTML saved to ${path}`);
    } catch (err) {
      console.warn('design-page: failed to save debug HTML:', err);
    }
  }

  console.log(`design-page: got HTML (${designResult.html.length} chars) for ${pageType}, converting to html blocks...`);
  const blocksResult = await convertHtmlToHtmlBlocks(router, {
    html: designResult.html,
    pageType,
  });
  console.log(`design-page [${designer.name}]: converted to ${blocksResult.blocks.length} html blocks for ${pageType}; footerHtml=${blocksResult.themeDelta?.footerHtml ? blocksResult.themeDelta.footerHtml.slice(0, 80).replace(/\n/g, " ") : "MISSING"}`);

  if (storageProvider) {
    const allMigrationResults: ImageMigrationResult[] = [];
    for (const block of blocksResult.blocks) {
      if (block.blockType === "html" && block.data) {
        try {
          const migrated = await migrateExternalImages(
            block.data.html,
            block.data.editableFields,
            siteId,
            storageProvider,
          );
          block.data.html = migrated.html;
          block.data.editableFields = migrated.editableFields;
          allMigrationResults.push(...migrated.results);
          const ok = migrated.results.filter((r) => r.success).length;
          if (migrated.results.length > 0) {
            console.log(`Image migration: ${ok}/${migrated.results.length} images for ${block.data.sectionName}`);
          }
        } catch (err) {
          console.warn(`Image migration failed for block ${block.data.sectionName}:`, err);
        }
      }
    }
    if (blocksResult.themeDelta?.headerHtml) {
      try {
        const m = await migrateExternalImages(blocksResult.themeDelta.headerHtml, {}, siteId, storageProvider);
        blocksResult.themeDelta.headerHtml = m.html;
        allMigrationResults.push(...m.results);
      } catch (err) {
        console.warn("Image migration failed for header:", err);
      }
    }
    if (blocksResult.themeDelta?.footerHtml) {
      try {
        const m = await migrateExternalImages(blocksResult.themeDelta.footerHtml, {}, siteId, storageProvider);
        blocksResult.themeDelta.footerHtml = m.html;
        allMigrationResults.push(...m.results);
      } catch (err) {
        console.warn("Image migration failed for footer:", err);
      }
    }
    await saveMediaRecords(siteId, allMigrationResults);
  }

  // If Claude didn't emit a <footer>, generate a minimal one using CSS vars
  // so the theme editor and live site both have a real footer HTML to work with.
  if (designer.name === "claude" && !blocksResult.themeDelta?.footerHtml) {
    const year = new Date().getFullYear();
    const name = brief.businessName ?? "Site";
    blocksResult.themeDelta = blocksResult.themeDelta ?? {};
    blocksResult.themeDelta.footerHtml = `<footer style="background:var(--color-bg);border-top:1px solid var(--color-primary);padding:2.5rem 0"><div style="max-width:72rem;margin:0 auto;padding:0 1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem"><a href="/" style="font-family:var(--font-heading);font-weight:700;color:var(--color-primary);text-decoration:none">${name}</a><span style="color:var(--color-text-muted);font-size:0.875rem">© ${year} ${name}</span></div></footer>`;
    blocksResult.themeDelta.footerEditableFields = {};
    console.log("design-page: Claude omitted <footer> — injected fallback footer");
  }

  let mergedTheme: SiteTheme | undefined;
  if (!skipThemeWrite) {
    mergedTheme = mergeThemeDelta(currentTheme, blocksResult.themeDelta);
    mergedTheme.designerState = {
      ...(mergedTheme.designerState ?? {}),
      ...(designResult.designerState ?? {}),
    };
    // compiledCss intentionally not computed here — recompileSiteCss runs
    // after the blocks are written so the CSS covers every page's classes.

    try {
      const [currentSite] = await db.select().from(sites).where(eq(sites.id, siteId));
      if (currentSite) {
        const existingSettings = (currentSite.settings ?? {}) as Record<string, unknown>;
        await db.update(sites).set({
          settings: { ...existingSettings, theme: mergedTheme },
        }).where(eq(sites.id, siteId));
        console.log(`design-page: saved theme to site settings`);
      }
    } catch (themeErr) {
      console.warn("Failed to save theme settings:", themeErr);
    }

    await extractAndSaveFooterData(mergedTheme.footerHtml, siteId);
    await extractAndSaveHeaderNav(mergedTheme.headerHtml, siteId);
  }

  if (isPostTemplate) {
    try {
      const [currentSite] = await db.select().from(sites).where(eq(sites.id, siteId));
      if (currentSite) {
        const existingSettings = (currentSite.settings ?? {}) as Record<string, unknown>;
        await db.update(sites).set({
          settings: {
            ...existingSettings,
            postTemplate: { blocks: blocksResult.blocks },
          },
        }).where(eq(sites.id, siteId));
        console.log(`design-page: saved post template (${blocksResult.blocks.length} blocks)`);
      }
    } catch (err) {
      console.warn("Failed to save post template:", err);
    }
  }

  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "copywriting",
    action: `design-page: ${pageType}${isPostTemplate ? " (post-template)" : ""}${pagePurpose ? ` (${pagePurpose})` : ""}`,
    suggestion: JSON.stringify({ blockCount: blocksResult.blocks.length }),
    model: blocksResult.model,
    usedFallback: blocksResult.usedFallback ? 1 : 0,
  });

  // Capture the realized design intent from the homepage (the design anchor) so
  // later edits and pages stay consistent with it. Fire-and-forget — the API
  // runs with no-cpu-throttling so it completes after the job returns.
  if (pageType === "homepage" && !isPostTemplate) {
    void synthesizeAndPersistDesignIntent(router, {
      siteId,
      brief,
      theme: currentTheme,
      homepageHtml: designResult.html,
      constraints: (brief.constraints ?? []).filter((x) => typeof x === "string" && x.trim()),
    });
  }

  // Extract data-image-prompt attributes and strip them from stored HTML.
  // Each placeholder src is made unique with ?img=<uuid> so that blocks with
  // multiple images using the same placehold.co URL can be patched independently.
  const imagePrompts: Array<{ blockIndex: number; placeholderSrc: string; prompt: string; aspectRatio: string }> = [];
  for (let i = 0; i < blocksResult.blocks.length; i++) {
    const block = blocksResult.blocks[i] as { blockType: string; data?: { html?: string } };
    if (block.blockType !== "html" || !block.data?.html) continue;
    // Use a regex that handles > inside quoted attribute values so alt text like
    // alt="A > B" doesn't cut the match short before data-image-prompt is reached.
    const imgRe = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)\s*\/?>/gi;
    let m: RegExpExecArray | null;
    let updatedHtml = block.data.html;
    while ((m = imgRe.exec(block.data.html)) !== null) {
      const attrs = m[1];
      const srcMatch = attrs.match(/\bsrc="([^"]*)"/i);
      if (!srcMatch) continue;
      const originalSrc = srcMatch[1];
      if (!originalSrc.includes("placehold.co")) continue;
      const promptMatch = attrs.match(/data-image-prompt="([^"]*)"/i);
      const altMatch = attrs.match(/\balt="([^"]*)"/i);
      const prompt = promptMatch?.[1] || altMatch?.[1] || "";
      if (!prompt) continue;
      const uniqueSrc = `${originalSrc}?img=${crypto.randomUUID()}`;
      // Replace only the first occurrence of this exact src in the HTML so each
      // img tag gets its own unique placeholder URL
      updatedHtml = updatedHtml.replace(`src="${originalSrc}"`, `src="${uniqueSrc}"`);
      imagePrompts.push({
        blockIndex: i,
        placeholderSrc: uniqueSrc,
        prompt,
        aspectRatio: inferAspectRatio(originalSrc),
      });
    }
    // Strip data-image-prompt and apply uniquified srcs — it's a generation hint, not runtime data
    block.data.html = updatedHtml.replace(/\s+data-image-prompt="[^"]*"/gi, "");
  }

  return { blocks: blocksResult.blocks, model: blocksResult.model, imagePrompts, ...(debugHtmlUrl ? { debugHtmlUrl } : {}) };
}

async function runGeneratePageImage(opts: {
  siteId: string;
  contentId: string;
  blockIndex: number;
  placeholderSrc: string;
  prompt: string;
  aspectRatio: string;
  router: AIRouter;
}): Promise<{ url: string; mediaId: string }> {
  const { siteId, contentId, blockIndex, placeholderSrc, prompt, aspectRatio, router } = opts;

  // Imagen rate limits are low (1–10 RPM). Retry with exponential backoff on 429.
  let result: Awaited<ReturnType<typeof router.generateImage>>;
  const retryDelays = [30_000, 60_000, 120_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      result = await router.generateImage({ prompt, aspectRatio });
      break;
    } catch (err) {
      lastErr = err;
      const is429 = err instanceof Error && (err.message.includes("429") || err.message.includes("quota"));
      if (!is429 || attempt === retryDelays.length) throw err;
      const delay = retryDelays[attempt];
      console.warn(`generate-image: 429 rate limit, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${retryDelays.length})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  result = result!;

  const rawBuffer = Buffer.from(result.imageBytes, "base64");
  const optimized = await optimizeImage(rawBuffer, result.mimeType, { maxWidth: IMAGE_PRESETS.content });
  const ext = mimeToExt(optimized.mimeType);
  const filename = promptToFilename(prompt, ext);
  const storagePath = `sites/${siteId}/media/${filename}`;
  const uploadResult = await storageProvider!.upload(
    optimized.buffer, storagePath, optimized.mimeType, "public, max-age=604800",
  );

  const altText = prompt.length > 300 ? prompt.slice(0, 297) + "..." : prompt;
  const [mediaItem] = await db
    .insert(media)
    .values({ siteId, filename, storageUrl: uploadResult.url, mimeType: optimized.mimeType, aiAltText: altText, uploadedBy: null })
    .returning();

  // Find block by position and patch its HTML atomically.
  // Multiple image jobs may target the same block concurrently (one per img tag).
  // A read-then-write would let concurrent jobs overwrite each other's replacements,
  // leaving some placeholders intact. Using a single SQL UPDATE with replace()
  // inside jsonb_set makes each patch atomic so all jobs succeed independently.
  const [targetBlock] = await db
    .select({ id: contentBlocks.id, blockType: contentBlocks.blockType })
    .from(contentBlocks)
    .where(eq(contentBlocks.contentId, contentId))
    .orderBy(contentBlocks.position)
    .offset(blockIndex)
    .limit(1);

  if (targetBlock?.blockType === "html") {
    const patchResult = await db.execute(
      sql`UPDATE ${contentBlocks}
          SET data = jsonb_set(data, '{html}',
            to_jsonb(replace(data->>'html', ${`src="${placeholderSrc}"`}, ${`src="${uploadResult.url}"`}))
          )
          WHERE id = ${targetBlock.id}
            AND data->>'html' LIKE ${'%' + placeholderSrc + '%'}
          RETURNING id`,
    );
    if (patchResult.length > 0) {
      console.log(`generate-image: patched block ${targetBlock.id} in content ${contentId}`);
    } else {
      console.warn(`generate-image: NO MATCH for placeholder ${placeholderSrc} in block ${targetBlock.id} (content ${contentId})`);
    }
  }

  await db.insert(auditLog).values({
    siteId,
    actorType: "ai",
    actorId: null,
    action: "media.generated",
    entityType: "media",
    entityId: mediaItem.id,
    details: { prompt: prompt.slice(0, 200), model: result.model, forContent: contentId, optimized: true },
  });

  return { url: uploadResult.url, mediaId: mediaItem.id };
}

// ---------------------------------------------------------------------------
// GET /api/ai/stitch-screens/:projectId — List screens in a Stitch project
// (lightweight — no HTML fetching or AI conversion)
// ---------------------------------------------------------------------------

aiRoutes.get("/stitch-screens/:projectId", async (c) => {
  if (!stitchService) {
    return c.json({ error: "Stitch design service is not configured" }, 503);
  }

  const projectId = c.req.param("projectId");
  try {
    const screens = await stitchService.listProjectScreens(projectId);
    return c.json({ screens });
  } catch (err) {
    console.error(`stitch-screens: failed to list screens for ${projectId}:`, err);
    return c.json({ error: `Failed to fetch Stitch project: ${err instanceof Error ? err.message : "unknown error"}` }, 503);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/apply-stitch-screen — Fetch one screen's HTML, convert to
// blocks, and write them to an existing content item. Async (job + poll).
// ---------------------------------------------------------------------------

aiRoutes.post("/apply-stitch-screen", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { projectId, screenId, contentId, target } = body as {
    projectId: string;
    screenId: string;
    contentId?: string;
    target?: "post-template";
  };

  const isPostTemplate = target === "post-template";

  if (!projectId || !screenId || (!contentId && !isPostTemplate)) {
    return c.json({ error: "projectId and screenId are required. Provide contentId or target='post-template'" }, 400);
  }

  const router = getAIRouter();
  if (!router) {
    return c.json({ error: "AI providers are not configured" }, 503);
  }

  if (!stitchService) {
    return c.json({ error: "Stitch design service is not configured" }, 503);
  }

  let contentItem: { siteId: string; slug: string | null } | null = null;
  if (contentId && !isPostTemplate) {
    const [item] = await db
      .select()
      .from(content)
      .where(eq(content.id, contentId));
    if (!item || item.siteId !== siteId) {
      return c.json({ error: "Content not found or does not belong to this site" }, 404);
    }
    contentItem = item;
  }

  const userId = c.get("user")?.id ?? null;
  const stitch = stitchService;
  const aiRouter = router;
  const slug = contentItem?.slug ?? null;

  const { jobId } = await enqueueJob({
    siteId,
    type: "apply-stitch-screen",
    payload: { projectId, screenId, contentId, target },
    createdBy: userId,
    runner: async () => runApplyStitchScreen({
      siteId,
      projectId,
      screenId,
      contentId,
      isPostTemplate,
      slug,
      stitch,
      router: aiRouter,
    }),
  });

  return c.json({ jobId });
});

async function runApplyStitchScreen(opts: {
  siteId: string;
  projectId: string;
  screenId: string;
  contentId?: string;
  isPostTemplate: boolean;
  slug: string | null;
  stitch: StitchDesignService;
  router: AIRouter;
}) {
  const { siteId, projectId, screenId, contentId, isPostTemplate, slug, stitch, router } = opts;

  const html = await stitch.fetchScreenHtml(projectId, screenId);
  console.log(`apply-stitch-screen: got HTML (${html.length} chars) for screen ${screenId}`);

  // Always pass "homepage" so convertHtmlToHtmlBlocks extracts the full theme
  // delta (colors, fonts, materialSymbols, bodyClasses) from every screen.
  // Every screen in a Stitch project shares one design system, so any screen
  // is a valid source of truth. mergeThemeDelta below uses freshDesign:false
  // so existing customisations are never overwritten on re-import.
  const blocksResult = await convertHtmlToHtmlBlocks(router, {
    html,
    pageType: isPostTemplate ? "blog-post" : "homepage",
    screenId,
  });
  console.log(`apply-stitch-screen: converted to ${blocksResult.blocks.length} html blocks`);

  if (storageProvider) {
    const allMigResults: ImageMigrationResult[] = [];
    for (const block of blocksResult.blocks) {
      if (block.blockType === "html" && block.data) {
        try {
          const migrated = await migrateExternalImages(
            block.data.html,
            block.data.editableFields,
            siteId,
            storageProvider,
          );
          block.data.html = migrated.html;
          block.data.editableFields = migrated.editableFields;
          allMigResults.push(...migrated.results);
        } catch (err) {
          console.warn(`Image migration failed for block:`, err);
        }
      }
    }
    if (blocksResult.themeDelta?.headerHtml) {
      try {
        const m = await migrateExternalImages(blocksResult.themeDelta.headerHtml, {}, siteId, storageProvider);
        blocksResult.themeDelta.headerHtml = m.html;
        allMigResults.push(...m.results);
      } catch (err) {
        console.warn("Image migration failed for header:", err);
      }
    }
    if (blocksResult.themeDelta?.footerHtml) {
      try {
        const m = await migrateExternalImages(blocksResult.themeDelta.footerHtml, {}, siteId, storageProvider);
        blocksResult.themeDelta.footerHtml = m.html;
        allMigResults.push(...m.results);
      } catch (err) {
        console.warn("Image migration failed for footer:", err);
      }
    }
    await saveMediaRecords(siteId, allMigResults);
  }

  if (!blocksResult.themeDelta?.footerHtml) {
    const year = new Date().getFullYear();
    const [siteForName] = await db.select({ name: sites.name }).from(sites).where(eq(sites.id, siteId));
    const name = siteForName?.name ?? "Site";
    blocksResult.themeDelta = blocksResult.themeDelta ?? {};
    blocksResult.themeDelta.footerHtml = `<footer style="background:var(--color-bg);border-top:1px solid var(--color-primary);padding:2.5rem 0"><div style="max-width:72rem;margin:0 auto;padding:0 1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem"><a href="/" style="font-family:var(--font-heading);font-weight:700;color:var(--color-primary);text-decoration:none">${name}</a><span style="color:var(--color-text-muted);font-size:0.875rem">© ${year} ${name}</span></div></footer>`;
    blocksResult.themeDelta.footerEditableFields = {};
    console.log("apply-stitch-screen: no <footer> found — injected fallback footer");
  }

  const [currentSiteRow] = await db.select().from(sites).where(eq(sites.id, siteId));
  const currentTheme = (currentSiteRow?.settings as Record<string, unknown> | undefined)
    ?.theme as SiteTheme | undefined;
  const mergedTheme = mergeThemeDelta(currentTheme, blocksResult.themeDelta, { freshDesign: false });
  mergedTheme.designerState = {
    ...(mergedTheme.designerState ?? {}),
    stitch: { projectId },
  };

  // Write the merged theme first so the upcoming recompile reads the latest
  // tokens. compiledCss is intentionally NOT computed here: we let
  // recompileSiteCss build it after the new blocks are in place so the CSS
  // covers every section across every page (otherwise importing page B would
  // produce a CSS that's missing page A's section classes).
  try {
    if (currentSiteRow) {
      const existingSettings = (currentSiteRow.settings ?? {}) as Record<string, unknown>;
      await db.update(sites).set({
        settings: { ...existingSettings, theme: mergedTheme },
      }).where(eq(sites.id, siteId));
    }
  } catch (themeErr) {
    console.warn("Failed to save theme:", themeErr);
  }

  if (isPostTemplate) {
    const [currentSite] = await db.select().from(sites).where(eq(sites.id, siteId));
    if (currentSite) {
      const existingSettings = (currentSite.settings ?? {}) as Record<string, unknown>;
      await db.update(sites).set({
        settings: {
          ...existingSettings,
          postTemplate: {
            blocks: blocksResult.blocks,
            stitchScreenId: screenId,
          },
        },
      }).where(eq(sites.id, siteId));
    }
    console.log(`apply-stitch-screen: saved post template (${blocksResult.blocks.length} blocks)`);
  } else {
    await db.delete(contentBlocks).where(eq(contentBlocks.contentId, contentId!));
    ensureFormIds(blocksResult.blocks);
    for (let pos = 0; pos < blocksResult.blocks.length; pos++) {
      const block = blocksResult.blocks[pos] as { blockType: string; data: Record<string, unknown> };
      await db.insert(contentBlocks).values({
        contentId: contentId!,
        blockType: block.blockType,
        data: block.data,
        position: pos,
      });
    }
  }

  // Compile compiledCss against the full site (theme + every page's blocks).
  await recompileSiteCss(siteId);

  // Auto-populate header nav from published pages if the navigation table has
  // no header record yet. This wires up the Stitch header links after import
  // without requiring a manual nav-config step.
  if (!isPostTemplate) {
    try {
      const [existingNav] = await db
        .select()
        .from(navigation)
        .where(and(eq(navigation.siteId, siteId), eq(navigation.location, "header")));

      if (!existingNav || (existingNav.items as unknown[]).length === 0) {
        const publishedPages = await db
          .select()
          .from(content)
          .where(and(eq(content.siteId, siteId), eq(content.status, "published"), eq(content.type, "page")));

        const navItems = publishedPages
          .filter((p) => p.slug && p.slug !== "home")
          .map((p) => {
            const schema = (p.schemaData ?? {}) as Record<string, unknown>;
            const label = (schema.title as string | undefined) || p.slug!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            return { label, url: `/${p.slug}` };
          });

        if (navItems.length > 0) {
          if (existingNav) {
            await db.update(navigation).set({ items: navItems, updatedAt: new Date() }).where(eq(navigation.id, existingNav.id));
          } else {
            await db.insert(navigation).values({ siteId, location: "header", items: navItems });
          }
        }
      }
    } catch (navErr) {
      console.warn("apply-stitch-screen: failed to auto-populate nav:", navErr);
    }
  }

  await db.insert(aiHistory).values({
    siteId,
    turnId: crypto.randomUUID(),
    taskType: "copywriting",
    action: `apply-stitch-screen: ${screenId} → ${isPostTemplate ? "post-template" : slug}`,
    suggestion: JSON.stringify({ blockCount: blocksResult.blocks.length }),
    model: blocksResult.model,
    usedFallback: blocksResult.usedFallback ? 1 : 0,
  });

  return { blocks: blocksResult.blocks, model: blocksResult.model };
}

// ---------------------------------------------------------------------------
// GET /api/ai/jobs/:id — Poll the status of an enqueued job
// ---------------------------------------------------------------------------

aiRoutes.get("/jobs/:id", async (c) => {
  const siteId = c.get("site").siteId;
  const job = await getJob(c.req.param("id"), siteId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({
    id: job.id,
    type: job.type,
    status: job.status,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/extract-theme-fields — Run field extraction on the site's
// current theme header/footer HTML and persist the results. Used to backfill
// editable fields for sites created before header/footer extraction was added
// to the import pipeline.
// ---------------------------------------------------------------------------

aiRoutes.post("/extract-theme-fields", async (c) => {
  const siteId = c.get("site").siteId;
  const router = getAIRouter();
  if (!router) {
    return c.json({ error: "AI router is not configured" }, 503);
  }

  const [currentSite] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!currentSite) {
    return c.json({ error: "Site not found" }, 404);
  }

  const settings = (currentSite.settings ?? {}) as Record<string, unknown>;
  const theme = settings.theme as SiteTheme | undefined;
  if (!theme) {
    return c.json({ error: "Site has no theme configured" }, 400);
  }

  const updated: SiteTheme = { ...theme };
  const result: { header?: { fieldCount: number }; footer?: { fieldCount: number } } = {};

  if (theme.headerHtml) {
    const h = await extractFieldsFromHtml(router, theme.headerHtml);
    const stripped = stripNavFields(h.markedHtml, h.fields, "header");
    updated.headerHtml = stripped.html;
    updated.headerEditableFields = stripped.fields;
    result.header = { fieldCount: Object.keys(stripped.fields).length };
  }
  if (theme.footerHtml) {
    const f = await extractFieldsFromHtml(router, theme.footerHtml);
    const stripped = stripNavFields(f.markedHtml, f.fields, "footer");
    updated.footerHtml = stripped.html;
    updated.footerEditableFields = stripped.fields;
    result.footer = { fieldCount: Object.keys(stripped.fields).length };
  }

  await db
    .update(sites)
    .set({ settings: { ...settings, theme: updated }, updatedAt: new Date() })
    .where(eq(sites.id, siteId));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: ((c as unknown as { get: (key: string) => AuthUser | undefined }).get("user"))?.id ?? null,
    action: "theme.extract_fields",
    entityType: "site",
    entityId: siteId,
    details: result,
  });

  return c.json({ theme: updated, result });
});

// ---------------------------------------------------------------------------
// GET /api/ai/history — List AI actions recorded for the site
// ---------------------------------------------------------------------------

aiRoutes.get("/history", async (c) => {
  const siteId = c.get("site").siteId;
  const page = Math.max(1, parseInt(c.req.query("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "30")));
  const offset = (page - 1) * limit;

  const taskType = c.req.query("taskType");
  const userDecision = c.req.query("userDecision");
  const model = c.req.query("model");

  const conditions = [eq(aiHistory.siteId, siteId)];
  if (taskType) conditions.push(eq(aiHistory.taskType, taskType));
  if (userDecision) conditions.push(eq(aiHistory.userDecision, userDecision));
  if (model) conditions.push(eq(aiHistory.model, model));

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  // Page of turns — one entry per turn_id, ordered by the newest matching row
  // in each turn. A turn appears in results if any of its rows match the filters.
  const turnPage = await db
    .select({
      turnId: aiHistory.turnId,
      maxCreated: sql<Date>`MAX(${aiHistory.createdAt})`.as("max_created"),
    })
    .from(aiHistory)
    .where(where)
    .groupBy(aiHistory.turnId)
    .orderBy(desc(sql`MAX(${aiHistory.createdAt})`))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`COUNT(DISTINCT ${aiHistory.turnId})::int` })
    .from(aiHistory)
    .where(where);

  const turnIds = turnPage.map((t) => t.turnId);
  const rows = turnIds.length === 0
    ? []
    : await db
        .select({
          id: aiHistory.id,
          turnId: aiHistory.turnId,
          taskType: aiHistory.taskType,
          action: aiHistory.action,
          suggestion: aiHistory.suggestion,
          userDecision: aiHistory.userDecision,
          usedFallback: aiHistory.usedFallback,
          model: aiHistory.model,
          createdAt: aiHistory.createdAt,
          actionType: aiHistory.actionType,
          entityType: aiHistory.entityType,
          entityId: aiHistory.entityId,
          decidedAt: aiHistory.decidedAt,
        })
        .from(aiHistory)
        .where(and(eq(aiHistory.siteId, siteId), inArray(aiHistory.turnId, turnIds)))
        .orderBy(aiHistory.createdAt);

  const rowsByTurn = new Map<string, typeof rows>();
  for (const r of rows) {
    const bucket = rowsByTurn.get(r.turnId) ?? [];
    bucket.push(r);
    rowsByTurn.set(r.turnId, bucket);
  }

  const turns = turnPage.map((t) => {
    const turnRows = rowsByTurn.get(t.turnId) ?? [];
    // Reply row: the conversation-level log with no actionType. Action rows: the rest.
    const replyRow = turnRows.find((r) => !r.actionType);
    const actionRows = turnRows.filter((r) => r.actionType);
    const head = turnRows[0] ?? replyRow;

    let decision: "accepted" | "rejected" | "partial" | null = null;
    if (actionRows.length > 0) {
      const accepted = actionRows.filter((r) => r.userDecision === "accepted").length;
      const rejected = actionRows.filter((r) => r.userDecision === "rejected").length;
      if (accepted === actionRows.length) decision = "accepted";
      else if (rejected === actionRows.length) decision = "rejected";
      else if (accepted + rejected > 0) decision = "partial";
    }

    return {
      turnId: t.turnId,
      taskType: head?.taskType ?? "",
      action: head?.action ?? "",
      reply: replyRow?.suggestion ?? null,
      model: head?.model ?? null,
      usedFallback: (head?.usedFallback ?? 0) > 0,
      createdAt: head?.createdAt ?? t.maxCreated,
      decision,
      hasPendingActions: actionRows.some((r) => !r.userDecision),
      actions: actionRows.map((r) => ({
        id: r.id,
        actionType: r.actionType,
        entityType: r.entityType,
        entityId: r.entityId,
        suggestion: r.suggestion,
        userDecision: r.userDecision,
        decidedAt: r.decidedAt,
      })),
    };
  });

  return c.json({
    turns,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/history/:id/decision — Accept or reject (undo) an AI action
// ---------------------------------------------------------------------------

aiRoutes.post("/history/:id/decision", async (c) => {
  const siteId = c.get("site").siteId;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const decision = (body as { decision?: string }).decision;

  if (decision !== "accepted" && decision !== "rejected") {
    return c.json({ error: "decision must be 'accepted' or 'rejected'" }, 400);
  }

  const [row] = await db.select().from(aiHistory).where(eq(aiHistory.id, id));
  if (!row || row.siteId !== siteId) {
    return c.json({ error: "Not found" }, 404);
  }
  if (row.userDecision) {
    return c.json({ error: `Already ${row.userDecision}` }, 409);
  }
  if (!row.actionType) {
    return c.json({ error: "This entry has no action to decide on" }, 400);
  }

  if (decision === "rejected") {
    const rollback = await rollbackAction(row);
    if (!rollback.ok) {
      return c.json({ error: rollback.reason }, 409);
    }
  }

  await db.update(aiHistory)
    .set({ userDecision: decision, decidedAt: new Date() })
    .where(eq(aiHistory.id, id));

  return c.json({ ok: true, decision });
});

// ---------------------------------------------------------------------------
// POST /api/ai/turns/:turnId/decision — Accept or undo an entire AI turn
// ---------------------------------------------------------------------------
// A single chat turn can produce multiple action rows. Accepting or rejecting
// once — per the user's mental model of "the change I just asked for" — is
// handled here. Rejected turns roll back rows in reverse creation order so
// later actions that build on earlier ones undo cleanly.

aiRoutes.post("/turns/:turnId/decision", async (c) => {
  const siteId = c.get("site").siteId;
  const turnId = c.req.param("turnId");
  const body = await c.req.json().catch(() => ({}));
  const decision = (body as { decision?: string }).decision;

  if (decision !== "accepted" && decision !== "rejected") {
    return c.json({ error: "decision must be 'accepted' or 'rejected'" }, 400);
  }

  const rows = await db
    .select()
    .from(aiHistory)
    .where(and(eq(aiHistory.turnId, turnId), eq(aiHistory.siteId, siteId)))
    .orderBy(aiHistory.createdAt);

  if (rows.length === 0) {
    return c.json({ error: "Turn not found" }, 404);
  }

  const actionable = rows.filter((r) => r.actionType && !r.userDecision);
  if (actionable.length === 0) {
    return c.json({ error: "No pending actions in this turn" }, 400);
  }

  if (decision === "rejected") {
    // Roll back in reverse creation order so later actions undo first.
    const failures: { id: string; reason: string }[] = [];
    for (const row of [...actionable].reverse()) {
      const rollback = await rollbackAction(row);
      if (!rollback.ok) {
        failures.push({ id: row.id, reason: rollback.reason });
      } else {
        await db.update(aiHistory)
          .set({ userDecision: "rejected", decidedAt: new Date() })
          .where(eq(aiHistory.id, row.id));
      }
    }
    if (failures.length > 0) {
      return c.json({ error: "Some actions could not be undone", failures }, 409);
    }
    return c.json({ ok: true, decision, undone: actionable.length });
  }

  // Accepted: mark all pending actionable rows decided.
  await db.update(aiHistory)
    .set({ userDecision: "accepted", decidedAt: new Date() })
    .where(and(eq(aiHistory.turnId, turnId), eq(aiHistory.siteId, siteId)));

  return c.json({ ok: true, decision, accepted: actionable.length });
});

async function rollbackAction(row: typeof aiHistory.$inferSelect): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { actionType, entityId, previousState, createdAt, siteId } = row;
  if (!actionType || !entityId) return { ok: false, reason: "Missing action metadata" };
  const prev = (previousState ?? {}) as Record<string, unknown>;

  switch (actionType) {
    case "CREATE_CONTENT":
    case "DESIGN_PAGE": {
      const [c0] = await db.select().from(content).where(eq(content.id, entityId));
      if (!c0 || c0.siteId !== siteId) return { ok: false, reason: "Content no longer exists" };
      if (c0.updatedAt.getTime() > createdAt.getTime() + 1000) {
        return { ok: false, reason: "Content has been edited since — undo refused to prevent losing your changes" };
      }
      await db.delete(content).where(eq(content.id, entityId));
      await db.insert(auditLog).values({
        siteId, actorType: "ai", action: "content.undone",
        entityType: "content", entityId, details: { actionType },
      });
      return { ok: true };
    }

    case "UPDATE_CONTENT": {
      const [c0] = await db.select().from(content).where(eq(content.id, entityId));
      if (!c0 || c0.siteId !== siteId) return { ok: false, reason: "Content no longer exists" };
      const prevSchema = prev.schemaData as Record<string, unknown> | undefined;
      const prevStatus = prev.status as string | undefined;
      const prevBlocks = (prev.blocks ?? []) as { position: number; blockType: string; data: unknown }[];
      const blocksReplaced = prev.blocksReplaced === true;
      await db.transaction(async (tx) => {
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (prevSchema) patch.schemaData = prevSchema;
        if (prevStatus !== undefined) patch.status = prevStatus;
        if (Object.keys(patch).length > 1) {
          await tx.update(content).set(patch).where(eq(content.id, entityId));
        }
        if (blocksReplaced) {
          await tx.delete(contentBlocks).where(eq(contentBlocks.contentId, entityId));
          if (prevBlocks.length > 0) {
            const restored = prevBlocks.map((b) => ({
              blockType: b.blockType,
              data: (b.data ?? {}) as Record<string, unknown>,
              position: b.position,
            }));
            ensureFormIds(restored);
            await tx.insert(contentBlocks).values(restored.map((b) => ({
              contentId: entityId,
              position: b.position,
              blockType: b.blockType,
              data: b.data,
            })));
          }
        }
      });
      return { ok: true };
    }

    case "SET_METADATA": {
      const prevSchema = prev.schemaData as Record<string, unknown> | undefined;
      if (!prevSchema) return { ok: false, reason: "Missing previous state" };
      await db.update(content).set({ schemaData: prevSchema, updatedAt: new Date() }).where(eq(content.id, entityId));
      return { ok: true };
    }

    case "UPDATE_HTML_BLOCK": {
      const [block] = await db.select().from(contentBlocks).where(eq(contentBlocks.id, entityId));
      if (!block) return { ok: false, reason: "Block no longer exists" };
      const [parent] = await db.select().from(content).where(eq(content.id, block.contentId));
      if (!parent || parent.siteId !== siteId) return { ok: false, reason: "Block does not belong to this site" };
      const prevHtml = prev.html as string | undefined;
      if (prevHtml === undefined) return { ok: false, reason: "Missing previous state" };
      const prevSection = prev.sectionName as string | null | undefined;
      const currentData = (block.data ?? {}) as Record<string, unknown>;
      const nextData: Record<string, unknown> = { ...currentData, html: prevHtml };
      if (prevSection === null) delete nextData.sectionName;
      else if (prevSection !== undefined) nextData.sectionName = prevSection;
      await db.transaction(async (tx) => {
        await tx.update(contentBlocks).set({ data: nextData }).where(eq(contentBlocks.id, entityId));
        await tx.update(content).set({ updatedAt: new Date() }).where(eq(content.id, block.contentId));
      });
      return { ok: true };
    }

    case "GENERATE_IMAGE": {
      const [m0] = await db.select().from(media).where(eq(media.id, entityId));
      if (!m0 || m0.siteId !== siteId) return { ok: false, reason: "Media no longer exists" };
      const links = await db.select().from(contentMedia).where(eq(contentMedia.mediaId, entityId));
      if (links.length > 0) {
        return { ok: false, reason: "Image is referenced by content — undo refused" };
      }
      const featuredContentId = prev.featuredImageContentId as string | null | undefined;
      const storagePath = prev.storagePath as string | undefined;
      if (featuredContentId) {
        const [target] = await db.select().from(content).where(eq(content.id, featuredContentId));
        if (target && target.siteId === siteId) {
          const schema = target.schemaData as Record<string, unknown>;
          if (schema?.featuredImage === m0.storageUrl) {
            const prevSchema = (prev.prevContentSchema ?? {}) as Record<string, unknown>;
            await db.update(content).set({ schemaData: prevSchema, updatedAt: new Date() }).where(eq(content.id, featuredContentId));
          }
        }
      }
      await db.delete(media).where(eq(media.id, entityId));
      if (storageProvider && storagePath) {
        try { await storageProvider.delete(storagePath); } catch { /* best effort */ }
      }
      return { ok: true };
    }

    case "UPDATE_NAVIGATION": {
      const created = prev.created === true;
      if (created) {
        await db.delete(navigation).where(eq(navigation.id, entityId));
      } else {
        const prevItems = prev.items;
        await db.update(navigation).set({ items: prevItems, updatedAt: new Date() }).where(eq(navigation.id, entityId));
      }
      return { ok: true };
    }

    case "UPDATE_HEADER":
    case "UPDATE_FOOTER": {
      const which = prev.which as "header" | "footer" | undefined;
      if (!which) return { ok: false, reason: "Missing which" };
      const [siteRow] = await db.select().from(sites).where(eq(sites.id, entityId));
      if (!siteRow) return { ok: false, reason: "Site not found" };
      const siteSettings = (siteRow.settings ?? {}) as Record<string, unknown>;
      const currentTheme = (siteSettings.theme ?? {}) as SiteTheme;
      const htmlKey = which === "header" ? "headerHtml" : "footerHtml";
      const fieldsKey = which === "header" ? "headerEditableFields" : "footerEditableFields";
      const nextTheme: SiteTheme = { ...currentTheme };
      nextTheme[htmlKey] = (prev.html ?? undefined) as string | undefined;
      nextTheme[fieldsKey] = (prev.editableFields ?? undefined) as Record<string, HtmlBlockEditableField> | undefined;
      await db.update(sites)
        .set({ settings: { ...siteSettings, theme: nextTheme }, updatedAt: new Date() })
        .where(eq(sites.id, entityId));
      return { ok: true };
    }

    case "CREATE_COLLECTION": {
      const links = await db.select().from(contentCollections).where(eq(contentCollections.collectionId, entityId));
      if (links.length > 0) {
        return { ok: false, reason: "Collection has content linked to it — undo refused" };
      }
      await db.delete(collections).where(eq(collections.id, entityId));
      return { ok: true };
    }

    case "UPDATE_COLLECTION": {
      const patch: Record<string, unknown> = {};
      if ("name" in prev) patch.name = prev.name;
      if ("slug" in prev) patch.slug = prev.slug;
      if ("parentId" in prev) patch.parentId = prev.parentId;
      if (Object.keys(patch).length === 0) return { ok: false, reason: "Missing previous state" };
      await db.update(collections).set(patch).where(eq(collections.id, entityId));
      return { ok: true };
    }

    case "ADD_TO_COLLECTION": {
      if (prev.alreadyLinked === true) {
        return { ok: false, reason: "Content was already in the collection before this action" };
      }
      const contentIdToUnlink = prev.contentId as string | undefined;
      if (!contentIdToUnlink) return { ok: false, reason: "Missing previous state" };
      await db.delete(contentCollections)
        .where(and(eq(contentCollections.contentId, contentIdToUnlink), eq(contentCollections.collectionId, entityId)));
      return { ok: true };
    }

    case "REMOVE_FROM_COLLECTION": {
      const contentIdToRelink = prev.contentId as string | undefined;
      if (!contentIdToRelink) return { ok: false, reason: "Missing previous state" };
      const [coll] = await db.select().from(collections).where(eq(collections.id, entityId));
      if (!coll || coll.siteId !== siteId) return { ok: false, reason: "Collection no longer exists" };
      const [c0] = await db.select().from(content).where(eq(content.id, contentIdToRelink));
      if (!c0 || c0.siteId !== siteId) return { ok: false, reason: "Content no longer exists" };
      await db.insert(contentCollections)
        .values({ contentId: contentIdToRelink, collectionId: entityId })
        .onConflictDoNothing();
      return { ok: true };
    }

    case "DELETE_COLLECTION": {
      const type = prev.type as string | undefined;
      const name = prev.name as string | undefined;
      const slug = prev.slug as string | undefined;
      if (!type || !name || !slug) return { ok: false, reason: "Missing previous state" };
      const parentId = (prev.parentId ?? null) as string | null;
      const linkedContentIds = (prev.linkedContentIds ?? []) as string[];
      const createdAtStr = prev.createdAt as string | undefined;
      await db.transaction(async (tx) => {
        await tx.insert(collections).values({
          id: entityId,
          siteId,
          type,
          name,
          slug,
          parentId,
          ...(createdAtStr ? { createdAt: new Date(createdAtStr) } : {}),
        });
        if (linkedContentIds.length > 0) {
          // Re-link only to content that still exists in this site.
          const existing = await tx
            .select({ id: content.id })
            .from(content)
            .where(eq(content.siteId, siteId));
          const existingIds = new Set(existing.map((r) => r.id));
          const toLink = linkedContentIds
            .filter((cid) => existingIds.has(cid))
            .map((cid) => ({ contentId: cid, collectionId: entityId }));
          if (toLink.length > 0) {
            await tx.insert(contentCollections).values(toLink).onConflictDoNothing();
          }
        }
      });
      return { ok: true };
    }

    case "DELETE_CONTENT": {
      const type = prev.type as string | undefined;
      const slug = prev.slug as string | undefined;
      if (!type || !slug) return { ok: false, reason: "Missing previous state" };
      const status = (prev.status ?? "draft") as string;
      const schemaData = (prev.schemaData ?? {}) as Record<string, unknown>;
      const createdBy = (prev.createdBy ?? null) as string | null;
      const publishedAtStr = prev.publishedAt as string | null | undefined;
      const createdAtStr = prev.createdAt as string | undefined;
      const blocks = (prev.blocks ?? []) as { position: number; blockType: string; data: unknown }[];
      const collectionIds = (prev.collectionIds ?? []) as string[];
      const mediaLinks = (prev.mediaLinks ?? []) as { mediaId: string; context: string | null }[];
      await db.transaction(async (tx) => {
        await tx.insert(content).values({
          id: entityId,
          siteId,
          type,
          slug,
          status,
          schemaData,
          createdBy,
          publishedAt: publishedAtStr ? new Date(publishedAtStr) : null,
          ...(createdAtStr ? { createdAt: new Date(createdAtStr) } : {}),
          updatedAt: new Date(),
        });
        if (blocks.length > 0) {
          const withIds = blocks.map((b) => ({
            blockType: b.blockType,
            data: (b.data ?? {}) as Record<string, unknown>,
            position: b.position,
          }));
          ensureFormIds(withIds);
          await tx.insert(contentBlocks).values(withIds.map((b) => ({
            contentId: entityId,
            position: b.position,
            blockType: b.blockType,
            data: b.data,
          })));
        }
        if (collectionIds.length > 0) {
          const existingCollections = await tx
            .select({ id: collections.id })
            .from(collections)
            .where(eq(collections.siteId, siteId));
          const existingIds = new Set(existingCollections.map((r) => r.id));
          const toLink = collectionIds
            .filter((cid) => existingIds.has(cid))
            .map((cid) => ({ contentId: entityId, collectionId: cid }));
          if (toLink.length > 0) {
            await tx.insert(contentCollections).values(toLink).onConflictDoNothing();
          }
        }
        if (mediaLinks.length > 0) {
          const existingMedia = await tx
            .select({ id: media.id })
            .from(media)
            .where(eq(media.siteId, siteId));
          const existingIds = new Set(existingMedia.map((r) => r.id));
          const toLink = mediaLinks
            .filter((l) => existingIds.has(l.mediaId))
            .map((l) => ({ contentId: entityId, mediaId: l.mediaId, context: l.context }));
          if (toLink.length > 0) {
            await tx.insert(contentMedia).values(toLink);
          }
        }
      });
      await db.insert(auditLog).values({
        siteId, actorType: "ai", action: "content.restored",
        entityType: "content", entityId, details: { actionType },
      });
      return { ok: true };
    }

    case "DELETE_MEDIA": {
      const filename = prev.filename as string | undefined;
      const storageUrl = prev.storageUrl as string | undefined;
      if (!filename || !storageUrl) return { ok: false, reason: "Missing previous state" };
      const createdAtStr = prev.createdAt as string | undefined;
      await db.insert(media).values({
        id: entityId,
        siteId,
        filename,
        storageUrl,
        mimeType: (prev.mimeType ?? null) as string | null,
        variants: (prev.variants ?? {}) as Record<string, unknown>,
        aiAltText: (prev.aiAltText ?? null) as string | null,
        aiTags: (prev.aiTags ?? []) as unknown,
        uploadedBy: (prev.uploadedBy ?? null) as string | null,
        ...(createdAtStr ? { createdAt: new Date(createdAtStr) } : {}),
      });
      return { ok: true };
    }

    case "UPDATE_MEDIA": {
      const patch: Record<string, unknown> = {};
      if ("filename" in prev) patch.filename = prev.filename;
      if ("aiAltText" in prev) patch.aiAltText = prev.aiAltText;
      if ("aiTags" in prev) patch.aiTags = prev.aiTags;
      if (Object.keys(patch).length === 0) return { ok: false, reason: "Missing previous state" };
      await db.update(media).set(patch).where(eq(media.id, entityId));
      return { ok: true };
    }

    case "CREATE_REDIRECT": {
      await db.delete(redirects).where(and(eq(redirects.id, entityId), eq(redirects.siteId, siteId)));
      await db.insert(auditLog).values({
        siteId, actorType: "ai", action: "redirect.undone",
        entityType: "redirect", entityId, details: { actionType },
      });
      return { ok: true };
    }

    case "DELETE_REDIRECT": {
      const fromPath = prev.fromPath as string | undefined;
      const toUrl = prev.toUrl as string | undefined;
      const statusCode = (prev.statusCode as number | undefined) ?? 301;
      const enabled = (prev.enabled as boolean | undefined) ?? true;
      if (!fromPath || !toUrl) return { ok: false, reason: "Missing previous state" };
      await db.insert(redirects).values({ id: entityId, siteId, fromPath, toUrl, statusCode, enabled });
      await db.insert(auditLog).values({
        siteId, actorType: "ai", action: "redirect.restored",
        entityType: "redirect", entityId, details: { actionType },
      });
      return { ok: true };
    }

    case "INVITE_TEAM_MEMBER": {
      const memberId = entityId;
      await db.update(siteMembers).set({ status: "removed" }).where(and(eq(siteMembers.id, memberId), eq(siteMembers.siteId, siteId)));
      const userId = prev.userId as string | undefined;
      if (userId) {
        await db.update(users).set({ resetToken: null, resetTokenExpiry: null }).where(eq(users.id, userId));
      }
      await db.insert(auditLog).values({
        siteId, actorType: "ai", action: "team.invite_undone",
        entityType: "site_member", entityId: memberId, details: { actionType },
      });
      return { ok: true };
    }

    case "CHANGE_TEAM_ROLE": {
      const oldRole = prev.oldRole as string | undefined;
      if (!oldRole) return { ok: false, reason: "Missing previous role" };
      await db.update(siteMembers).set({ role: oldRole }).where(and(eq(siteMembers.id, entityId), eq(siteMembers.siteId, siteId)));
      await db.insert(auditLog).values({
        siteId, actorType: "ai", action: "team.role_change_undone",
        entityType: "site_member", entityId, details: { actionType, restoredRole: oldRole },
      });
      return { ok: true };
    }

    default:
      return { ok: false, reason: `Undo not supported for action type ${actionType}` };
  }
}

// ---------------------------------------------------------------------------
// GET /api/ai/preferences — Get AI model preferences for a site
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/ai/insights — Deterministic proactive suggestions for the current site
// ---------------------------------------------------------------------------

aiRoutes.get("/insights", async (c) => {
  const siteId = c.get("site").siteId;
  const page = c.req.query("page") || undefined;
  const insights = await getInsightsForSite(siteId, page);
  return c.json({ insights });
});

aiRoutes.get("/preferences", async (c) => {
  const siteId = c.get("site").siteId;

  const site = await fetchSite(siteId);
  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const aiPreferences = (settings.aiPreferences ?? {}) as Record<string, unknown>;

  return c.json({
    siteId,
    preferences: aiPreferences,
  });
});

// ---------------------------------------------------------------------------
// PUT /api/ai/preferences — Update AI model preferences
// ---------------------------------------------------------------------------

aiRoutes.put("/preferences", async (c) => {
  const siteId = c.get("site").siteId;
  const body = await c.req.json();
  const { preferences } = body as {
    preferences: Record<string, unknown>;
  };

  if (!preferences) {
    return c.json({ error: "preferences is required" }, 400);
  }

  const site = await fetchSite(siteId);
  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const updatedSettings = {
    ...settings,
    aiPreferences: preferences,
  };

  const [updated] = await db
    .update(sites)
    .set({ settings: updatedSettings, updatedAt: new Date() })
    .where(eq(sites.id, siteId))
    .returning();

  return c.json({
    siteId,
    preferences,
    updatedAt: updated.updatedAt,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — Conversational assistant with action capabilities
// ---------------------------------------------------------------------------

interface ChatAction {
  type: string;
  status: "success" | "error";
  result?: Record<string, unknown>;
  error?: string;
  historyId?: string;
}

/**
 * design_page tool — kept in ai.ts because it depends on local helpers
 * (analyzeInspirationImages, convertHtmlToHtmlBlocks, migrateExternalImages,
 * recompileSiteCss, mergeThemeDelta, extractAndSaveFooterData, fetchSite,
 * pageDesigner).
 */
const designPageTool: AITool = {
  name: "design_page",
  description: "Create a professionally designed page using the site's design system (Stitch). Use this for PAGES that need real visual polish — landing pages, services pages, about pages. For blog posts, use create_content instead. Takes a moment to generate.",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "URL-friendly slug (lowercase, hyphens)" },
      title: { type: "string", description: "Display title" },
      pageType: { type: "string", description: "Kind of page: 'homepage', 'about', 'services', 'contact', 'pricing', 'portfolio', 'team', 'faq', 'blog-index', 'landing'" },
      pagePurpose: { type: "string", description: "Detailed description of the page's goal, content, and audience — drives the design" },
      status: { type: "string", description: "'draft' (default) or 'published'" },
    },
    required: ["slug", "title", "pageType"],
  },
};

interface DesignPageToolOutcome {
  content: string;
  is_error: boolean;
  action: ChatAction;
}

async function runDesignPageTool(
  input: Record<string, unknown>,
  ctx: { siteId: string; turnId: string; model: string; usedFallback: boolean; message: string },
): Promise<DesignPageToolOutcome> {
  const { slug, title, pageType, pagePurpose, status } = input as {
    slug?: string;
    title?: string;
    pageType?: string;
    pagePurpose?: string;
    status?: string;
  };

  if (!slug || !title || !pageType) {
    return designPageErrorOutcome("slug, title, and pageType are required");
  }
  const router = getAIRouter();
  if (!router) {
    return designPageErrorOutcome("AI providers not configured");
  }

  const siteData = await fetchSite(ctx.siteId);
  if (!siteData) {
    return designPageErrorOutcome("Site not found");
  }

  const siteSettings = (siteData.settings ?? {}) as Record<string, unknown>;
  const toolDesigner = resolvePageDesigner(siteSettings);
  if (!toolDesigner) {
    return designPageErrorOutcome("Design service is not configured");
  }

  const siteBrief = siteData.brief as SiteBrief | undefined;
  if (!siteBrief?.businessName) {
    return designPageErrorOutcome("Your site interview isn't complete yet. Finish the onboarding interview so I have enough information about your business to design pages.");
  }

  let currentTheme = siteSettings.theme as SiteTheme | undefined;

  await ensureBrandColorsFromLogo(siteBrief, ctx.siteId, router);

  if (toolDesigner.name === "claude") {
    currentTheme = await ensureThemeColors(siteBrief, ctx.siteId, currentTheme ?? themeFallback(), router);
  }

  const inspirationAnalysis = await analyzeInspirationImages(siteBrief, router);

  const designResult = await toolDesigner.designPage({
    brief: siteBrief,
    pageType,
    pagePurpose,
    theme: currentTheme ?? themeFallback(),
    inspirationAnalysis,
    designerState: currentTheme?.designerState,
    designIntent: siteSettings.designIntent as DesignIntent | undefined,
  });

  const blocksResult = await convertHtmlToHtmlBlocks(router, {
    html: designResult.html,
    pageType,
  });

  if (storageProvider) {
    const chatMigResults: ImageMigrationResult[] = [];
    for (const block of blocksResult.blocks) {
      if (block.blockType === "html" && block.data) {
        try {
          const migrated = await migrateExternalImages(
            block.data.html,
            block.data.editableFields,
            ctx.siteId,
            storageProvider,
          );
          block.data.html = migrated.html;
          block.data.editableFields = migrated.editableFields;
          chatMigResults.push(...migrated.results);
        } catch {
          // continue without migration
        }
      }
    }
    if (blocksResult.themeDelta?.headerHtml) {
      try {
        const m = await migrateExternalImages(blocksResult.themeDelta.headerHtml, {}, ctx.siteId, storageProvider);
        blocksResult.themeDelta.headerHtml = m.html;
        chatMigResults.push(...m.results);
      } catch { /* continue */ }
    }
    if (blocksResult.themeDelta?.footerHtml) {
      try {
        const m = await migrateExternalImages(blocksResult.themeDelta.footerHtml, {}, ctx.siteId, storageProvider);
        blocksResult.themeDelta.footerHtml = m.html;
        chatMigResults.push(...m.results);
      } catch { /* continue */ }
    }
    await saveMediaRecords(ctx.siteId, chatMigResults);
  }

  if (toolDesigner.name === "claude" && !blocksResult.themeDelta?.footerHtml) {
    const year = new Date().getFullYear();
    const name = siteBrief.businessName ?? "Site";
    blocksResult.themeDelta = blocksResult.themeDelta ?? {};
    blocksResult.themeDelta.footerHtml = `<footer style="background:var(--color-bg);border-top:1px solid var(--color-primary);padding:2.5rem 0"><div style="max-width:72rem;margin:0 auto;padding:0 1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem"><a href="/" style="font-family:var(--font-heading);font-weight:700;color:var(--color-primary);text-decoration:none">${name}</a><span style="color:var(--color-text-muted);font-size:0.875rem">© ${year} ${name}</span></div></footer>`;
    blocksResult.themeDelta.footerEditableFields = {};
  }

  const mergedTheme = mergeThemeDelta(currentTheme, blocksResult.themeDelta);
  mergedTheme.designerState = {
    ...(mergedTheme.designerState ?? {}),
    ...(designResult.designerState ?? {}),
  };
  // compiledCss intentionally not computed here — recompileSiteCss runs after
  // the new content is inserted so the CSS covers every page's classes.

  try {
    const existingSettings = (siteData.settings ?? {}) as Record<string, unknown>;
    await db.update(sites).set({
      settings: { ...existingSettings, theme: mergedTheme },
    }).where(eq(sites.id, ctx.siteId));
  } catch {
    // non-fatal
  }

  await extractAndSaveFooterData(mergedTheme.footerHtml, ctx.siteId);
  await extractAndSaveHeaderNav(mergedTheme.headerHtml, ctx.siteId);

  const metaDescription = await generateMetaDescription(siteBrief, title, pageType, pagePurpose, router);

  const designedItem = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(content)
      .values({
        siteId: ctx.siteId,
        type: "page",
        slug,
        status: status || "draft",
        schemaData: { title, ...(metaDescription ? { metaDescription } : {}) },
        createdBy: null,
        publishedAt: status === "published" ? new Date() : null,
      })
      .returning();

    if (blocksResult.blocks.length > 0) {
      ensureFormIds(blocksResult.blocks);
      await tx.insert(contentBlocks).values(
        blocksResult.blocks.map((block, i) => ({
          contentId: created.id,
          position: i,
          blockType: block.blockType,
          data: block.data || {},
        })),
      );
    }

    await tx.insert(contentVersions).values({
      contentId: created.id,
      version: 1,
      schemaData: created.schemaData,
      blocksSnapshot: blocksResult.blocks,
    });

    await tx.insert(auditLog).values({
      siteId: ctx.siteId,
      actorType: "ai",
      actorId: null,
      action: "content.created",
      entityType: "content",
      entityId: created.id,
      details: { type: "page", slug, status: created.status, designedWithStitch: true, pageType },
    });

    return created;
  });

  // Compile compiledCss against the full site (theme + every page's blocks).
  await recompileSiteCss(ctx.siteId);

  // Extract data-image-prompt attributes from blocks and enqueue image generation jobs.
  // This mirrors what runDesignPage does for the job-based design path.
  if (storageProvider) {
    const imagePrompts: Array<{ blockIndex: number; placeholderSrc: string; prompt: string; aspectRatio: string }> = [];
    const savedBlocks = await db.select({ id: contentBlocks.id, data: contentBlocks.data, position: contentBlocks.position })
      .from(contentBlocks).where(eq(contentBlocks.contentId, designedItem.id)).orderBy(contentBlocks.position);

    for (const block of savedBlocks) {
      const data = block.data as { html?: string } | null;
      if (!data?.html) continue;
      const imgRe = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)\s*\/?>/gi;
      let m: RegExpExecArray | null;
      let updatedHtml = data.html;
      while ((m = imgRe.exec(data.html)) !== null) {
        const attrs = m[1];
        const srcMatch = attrs.match(/src="([^"]*)"/i);
        const promptMatch = attrs.match(/data-image-prompt="([^"]*)"/i);
        const ratioMatch = attrs.match(/data-aspect-ratio="([^"]*)"/i);
        if (!promptMatch) continue;
        const placeholderSrc = srcMatch?.[1] ?? "";
        const uniqueSrc = placeholderSrc.includes("?img=") ? placeholderSrc : `${placeholderSrc}?img=${crypto.randomUUID()}`;
        updatedHtml = updatedHtml.replace(m[0], m[0].replace(placeholderSrc, uniqueSrc));
        imagePrompts.push({ blockIndex: block.position, placeholderSrc: uniqueSrc, prompt: promptMatch[1], aspectRatio: ratioMatch?.[1] ?? "16:9" });
      }
      const cleanHtml = updatedHtml.replace(/\s+data-image-prompt="[^"]*"/gi, "");
      if (cleanHtml !== data.html) {
        await db.update(contentBlocks).set({ data: { ...data, html: cleanHtml } }).where(eq(contentBlocks.id, block.id));
      }
    }

    if (imagePrompts.length > 0) {
      for (let idx = 0; idx < imagePrompts.length; idx++) {
        const img = imagePrompts[idx];
        setTimeout(() => {
          runGeneratePageImage({ siteId: ctx.siteId, contentId: designedItem.id, ...img, router }).catch((err) =>
            console.warn(`chat design_page: image generation failed for block ${img.blockIndex}:`, err)
          );
        }, idx * 3000);
      }
      console.log(`chat design_page: queued ${imagePrompts.length} image job(s) for content ${designedItem.id}`);
    }
  }

  const [historyRow] = await db
    .insert(aiHistory)
    .values({
      siteId: ctx.siteId,
      turnId: ctx.turnId,
      taskType: "copywriting",
      action: `chat: ${ctx.message.slice(0, 200)}`,
      suggestion: `DESIGN_PAGE ${pageType}:${slug}`,
      model: ctx.model,
      usedFallback: ctx.usedFallback ? 1 : 0,
      actionType: "DESIGN_PAGE",
      entityType: "content",
      entityId: designedItem.id,
      previousState: null,
    })
    .returning({ id: aiHistory.id });

  return {
    content: `Designed ${pageType} page "${title}" with ${blocksResult.blocks.length} section${blocksResult.blocks.length === 1 ? "" : "s"} (status: ${designedItem.status}, id: ${designedItem.id}).`,
    is_error: false,
    action: {
      type: "DESIGN_PAGE",
      status: "success",
      result: {
        id: designedItem.id,
        type: "page",
        slug: designedItem.slug,
        title,
        status: designedItem.status,
        blockCount: blocksResult.blocks.length,
        designed: true,
      },
      historyId: historyRow.id,
    },
  };
}

function designPageErrorOutcome(error: string): DesignPageToolOutcome {
  return {
    content: `Error: ${error}`,
    is_error: true,
    action: { type: "DESIGN_PAGE", status: "error", error },
  };
}

interface ChatSiteContext {
  existingContent: { type: string; slug: string; title: string; id: string }[];
  navMenus: { location: string; items: unknown[] }[];
  existingCollections: { id: string; type: string; name: string; slug: string }[];
  pageContext?: string;
  themeColors?: Record<string, string>;
  themeFontFamilies?: Record<string, string[]>;
  themeFontSizes?: Record<string, { size: string; lineHeight?: string; fontWeight?: string }>;
  themeCustomCssClasses?: string[];
  designIntent?: DesignIntent;
}

function buildChatSystemPrompt(brief: SiteBrief | undefined, ctx: ChatSiteContext, hasStitch: boolean): { cachedPrefix: string; volatile: string } {
  const identity = buildCoreIdentityPrompt(brief);
  const { existingContent, navMenus, existingCollections, pageContext, themeColors, themeFontFamilies, themeFontSizes, themeCustomCssClasses } = ctx;

  const contentList = existingContent.length
    ? existingContent.map((c) => `  - [${c.type}] "${c.title}" (slug: ${c.slug}, id: ${c.id})`).join("\n")
    : "  (no content yet)";

  const navList = navMenus.length
    ? navMenus.map((n) => `  - ${n.location}: ${(n.items as Array<{ label: string; url: string }>).map((i) => `"${i.label}" (${i.url})`).join(", ")}`).join("\n")
    : "  (no menus configured)";

  const collectionList = existingCollections.length
    ? existingCollections.map((c) => `  - [${c.type}] "${c.name}" (slug: ${c.slug}, id: ${c.id})`).join("\n")
    : "  (no collections yet)";

  const hasTheme = themeColors && Object.keys(themeColors).length > 0;
  const themeSection = hasTheme ? `\nSITE DESIGN SYSTEM (use these when writing or editing HTML blocks — do not invent new classes or inline styles):

COLORS — Tailwind class → hex:
${Object.entries(themeColors!).map(([k, v]) => `  bg-${k} / text-${k} / border-${k}  (${v})`).join("\n")}
Standard Tailwind also works (e.g. text-white, bg-black).
${themeFontFamilies && Object.keys(themeFontFamilies).length > 0 ? `
TYPOGRAPHY — Tailwind class → font:
${Object.entries(themeFontFamilies).map(([k, v]) => {
  const size = themeFontSizes?.[k];
  const sizeStr = size ? ` ${size.size}${size.lineHeight ? ` / lh ${size.lineHeight}` : ""}${size.fontWeight ? ` / fw ${size.fontWeight}` : ""}` : "";
  return `  font-${k} / text-${k}  →  ${v[0]}${sizeStr}`;
}).join("\n")}` : ""}
${themeCustomCssClasses && themeCustomCssClasses.length > 0 ? `
CUSTOM CSS CLASSES (defined in the site's stylesheet — use freely, do not redefine):
  ${themeCustomCssClasses.join(", ")}` : ""}
For links in HTML blocks use a color class or style="color: <value>". Text blocks do not support inline styling — convert to HTML block if per-element color control is needed.\n` : "";

  // Design intent + constraints — the site's established global direction. Part
  // of the STABLE prompt prefix (deterministic, cacheable) so every edit holds
  // the global aesthetic, not just the local block.
  const di = ctx.designIntent;
  const allConstraints = [
    ...new Set([
      ...(di?.constraints ?? []),
      ...((brief?.constraints ?? []).filter((c) => typeof c === "string" && c.trim())),
    ]),
  ];
  const designIntentSection = di || allConstraints.length ? `
## DESIGN INTENT — every change you make MUST stay consistent with this
This is the site's established global design direction. When you edit, restyle, write copy, or generate a section or image, match it — do not drift toward generic defaults.
${di ? `- Aesthetic: ${di.aestheticDirection}
- Voice & tone: ${di.voiceAndTone}
- Layout & composition: ${di.layoutPrinciples}
- Imagery: ${di.imageryStyle}
- Color & type: ${di.colorAndType}${di.positioning ? `\n- Positioning: ${di.positioning}` : ""}` : ""}
${allConstraints.length ? `ABSOLUTE CONSTRAINTS (hard rules — never violate, even if it conflicts with the aesthetic or the user's phrasing of a styling request):
${allConstraints.map((c) => `- ${c}`).join("\n")}` : ""}
When the user asks for a GLOBAL direction change that should stick site-wide (e.g. "make the whole site bolder/darker", "shift our tone", "we're repositioning"), call update_design_intent to update this direction FIRST, then apply the change to the current page. For a one-off tweak to a single section, just make the edit — do not touch the design intent.
` : "";

  // STABLE prefix — deterministic across turns, marked cacheable by the provider.
  const cachedPrefix = `${identity}
${themeSection}
${designIntentSection}
CAPABILITIES:
You are an integrated assistant for the Cadmus website platform. You can take real actions on the user's site by calling the available tools. Do NOT paste raw content into the chat for the user to copy-paste.
${hasStitch ? `
For PAGES that need real visual polish (landing pages, services, about, etc.), call the design_page tool — it produces a fully designed page using the site's design system. For blog posts, use create_content (text blocks only). Never use design_page for posts.
` : ""}
RESPONSE GUIDELINES:
- When creating content: write a brief message about your approach/strategy, then call the create_content tool. Keep chat text short — the content itself goes in the tool call.
- When creating a post: include metaDescription and featuredImagePrompt in the same create_content call. Do NOT create the post first and then ask about metadata — do it all in one call.
- When answering questions: be direct and helpful. No tool call needed.
- When managing navigation or collections: just do it with the appropriate tool — don't tell the user to go to another page.
- When managing redirects: use the create_redirect and delete_redirect tools directly. Never suggest editing server config or hosting files — Cadmus handles redirects natively.
- When managing the team: use the invite_team_member and change_team_role tools directly. Always call list_team first to see current members before making changes.
- Never dump a full article/post into the chat text. Always use the create_content or update_content tool.
- If the user's request is vague, ask a clarifying question before creating content.
- Always match the site's tone and target audience when writing content.
- For SURGICAL edits to a single section of an existing page (e.g. wiring up a search bar, swapping a CTA, fixing a heading), call read_content to get the blockId, then call get_html_block with that blockId to retrieve the FULL raw markup, then call update_html_block with the complete edited HTML. read_content only shows a truncated preview — never edit an html block from the preview alone, or you will lose the parts you couldn't see. Do NOT use update_content for surgical edits — update_content replaces every block on the page and will destroy other sections.
- When editing an HTML block: preserve all existing Tailwind classes, custom CSS classes, and design tokens that are unrelated to the change. Only modify what the user asked to change — never silently switch to generic Tailwind utilities if the block already uses theme tokens (e.g. bg-primary, font-h1, glass-card).
- If the user asks you to undo and try again, treat the prior turn's actions as rejected and choose a different approach. Do not re-create content that already exists in the EXISTING SITE CONTENT list below.`;

  // VOLATILE suffix — changes per turn as content/nav/page change. Kept out of
  // the cached prefix so it never invalidates the cache.
  const volatile = `EXISTING SITE CONTENT:
${contentList}

NAVIGATION MENUS:
${navList}

COLLECTIONS:
${collectionList}
${pageContext ? `\nCURRENT PAGE CONTEXT:\n${pageContext}\n` : ""}`;

  return { cachedPrefix, volatile };
}


aiRoutes.post("/chat", async (c) => {
  const siteId = c.get("site").siteId;
  // Site role (rebound by requireSiteMembership) — gates privileged write tools.
  const userRole = (c.get("user") as AuthUser).role as SiteRole;
  const turnId = crypto.randomUUID();
  const body = await c.req.json();
  const { message, conversationHistory, currentPath } = body as {
    message: string;
    conversationHistory?: ConversationMessage[];
    currentPath?: string;
  };

  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }

  // Content policy check
  const policyCheck = checkContentPolicy(message);
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.message, policyViolation: policyCheck.category }, 403);
  }

  // Feature gate: free-tier chat message limit
  const chatGate = await checkFeatureGate(siteId, "ai_chat_message");
  if (!chatGate.allowed) {
    return c.json({ error: chatGate.reason || "Chat message limit reached", gate: chatGate }, 429);
  }

  const site = await fetchSite(siteId);
  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  const brief = site.brief as SiteBrief | undefined;

  // Fetch existing content for context
  const existingContent = await db
    .select({
      id: content.id,
      type: content.type,
      slug: content.slug,
      schemaData: content.schemaData,
    })
    .from(content)
    .where(eq(content.siteId, siteId));

  const contentSummary = existingContent.map((c) => ({
    id: c.id,
    type: c.type,
    slug: c.slug,
    title: String((c.schemaData as Record<string, unknown>)?.title || c.slug),
  }));

  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const siteTheme = (settings.theme as Record<string, unknown> | undefined) ?? {};
  const themeColors = (siteTheme.colors ?? {}) as Record<string, string>;
  const themeFontFamilies = (siteTheme.fontFamilies ?? {}) as Record<string, string[]>;
  const themeFontSizes = (siteTheme.fontSizes ?? {}) as Record<string, { size: string; lineHeight?: string; fontWeight?: string }>;
  const themeCustomCss = (siteTheme.customCss as string | undefined) ?? "";
  const themeCustomCssClasses = themeCustomCss
    ? [...themeCustomCss.matchAll(/^\.([\w-]+)\s*\{/gm)].map((m) => m[1]).filter(Boolean)
    : [];
  // hasDesigner: controls whether design_page tool is included in the tools list
  // hasStitch: also requires a brief so the system prompt instructs when to use design_page
  const hasDesigner = !!resolvePageDesigner(settings);
  const hasStitch = hasDesigner && !!brief?.businessName;

  // Fetch navigation and collections for context
  const [navMenus, siteCollections] = await Promise.all([
    db.select({ location: navigation.location, items: navigation.items })
      .from(navigation).where(eq(navigation.siteId, siteId)),
    db.select({ id: collections.id, type: collections.type, name: collections.name, slug: collections.slug })
      .from(collections).where(eq(collections.siteId, siteId)),
  ]);

  // Resolve page context from the admin's current path
  let pageContext: string | undefined;
  if (currentPath) {
    const contentMatch = currentPath.match(/^\/content\/([a-zA-Z0-9-]+)$/);
    if (contentMatch) {
      const contentId = contentMatch[1];
      const activeContent = contentSummary.find((c) => c.id === contentId);
      if (activeContent) {
        const schema = existingContent.find((c) => c.id === contentId)?.schemaData as Record<string, unknown> | undefined;
        pageContext = `The user is currently editing: "${activeContent.title}" (${activeContent.type}, slug: ${activeContent.slug}, id: ${activeContent.id}).` +
          (schema?.metaDescription ? ` Current meta description: "${schema.metaDescription}"` : "") +
          (schema?.featuredImage ? ` Has featured image.` : " No featured image set.") +
          ` When the user refers to "this post", "this page", or asks for changes without specifying which content, they mean this one.`;

        // Fetch block content so the AI can see what's on the page
        try {
          const blocks = await db.select({ blockType: contentBlocks.blockType, data: contentBlocks.data })
            .from(contentBlocks)
            .where(eq(contentBlocks.contentId, contentId))
            .orderBy(contentBlocks.position);

          if (blocks.length > 0) {
            const contentSummaryText = blocks.map((b) => {
              const data = b.data as Record<string, unknown> | null;
              if (!data) return null;
              if (b.blockType === "html" && typeof data.html === "string") {
                // Extract visible text from HTML blocks (strip tags)
                const text = (data.html as string).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
                const section = data.sectionName ? ` (${data.sectionName})` : "";
                return text ? `[HTML block${section}]: ${text.slice(0, 500)}` : null;
              }
              if (b.blockType === "heading" && data.text) return `[Heading]: ${data.text}`;
              if (b.blockType === "paragraph" && data.text) return `[Paragraph]: ${String(data.text).slice(0, 300)}`;
              if (b.blockType === "text" && data.content) return `[Text]: ${String(data.content).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`;
              if (b.blockType === "hero") return `[Hero]: ${data.headline || ""}${data.subheadline ? " — " + data.subheadline : ""}`;
              if (b.blockType === "section") return `[Section]: ${data.heading || ""}${data.body ? " — " + String(data.body).slice(0, 200) : ""}`;
              if (b.blockType === "cta") return `[CTA]: ${data.headline || ""} — ${data.buttonText || ""}`;
              if (b.blockType === "faq" && Array.isArray(data.items)) return `[FAQ]: ${(data.items as {question: string}[]).map(i => i.question).join(", ")}`;
              return `[${b.blockType}]`;
            }).filter(Boolean);

            if (contentSummaryText.length > 0) {
              pageContext += `\n\nPage content (${blocks.length} blocks):\n${contentSummaryText.join("\n")}`;
            }
          }
        } catch {
          // Non-critical — continue without block content
        }
      }
    } else if (currentPath === "/content") {
      pageContext = "The user is on the content list page.";
    } else if (currentPath === "/media") {
      // Fetch media items so the AI can see and manage them
      const mediaItems = await db.select({
        id: media.id,
        filename: media.filename,
        mimeType: media.mimeType,
        aiAltText: media.aiAltText,
        storageUrl: media.storageUrl,
        createdAt: media.createdAt,
      }).from(media).where(eq(media.siteId, siteId)).orderBy(desc(media.createdAt)).limit(50);

      const mediaList = mediaItems.length
        ? mediaItems.map((m) => {
            const alt = m.aiAltText ? `, alt: "${m.aiAltText}"` : ", no alt text";
            return `  - "${m.filename}" (id: ${m.id}, ${m.mimeType}${alt})`;
          }).join("\n")
        : "  (no media uploaded yet)";

      pageContext = `The user is on the media library page. Use update_media (tool) to change alt text, filename, or tags.\n\nMEDIA LIBRARY:\n${mediaList}`;
    } else if (currentPath === "/settings") {
      pageContext = "The user is on the site settings page.";
    } else if (currentPath === "/navigation") {
      pageContext = "The user is on the navigation/menu management page.";
    } else if (currentPath === "/collections") {
      pageContext = "The user is on the collections management page.";
    } else if (currentPath === "/redirects") {
      const redirectRows = await db
        .select({ fromPath: redirects.fromPath, toUrl: redirects.toUrl, statusCode: redirects.statusCode, enabled: redirects.enabled })
        .from(redirects)
        .where(eq(redirects.siteId, siteId));
      const redirectList = redirectRows.length
        ? redirectRows.map((r) => `  - ${r.fromPath} → ${r.toUrl} [${r.statusCode}]${r.enabled ? "" : " (disabled)"}`).join("\n")
        : "  (no redirects configured)";
      pageContext = `The user is on the URL redirects page. You can create and delete redirects using the create_redirect and delete_redirect tools. Call list_redirects to see current rules before making changes.\n\nCURRENT REDIRECTS:\n${redirectList}`;
    } else if (currentPath === "/team") {
      const memberRows = await db
        .select({ id: siteMembers.id, role: siteMembers.role, status: siteMembers.status, email: users.email })
        .from(siteMembers)
        .innerJoin(users, eq(siteMembers.userId, users.id))
        .where(eq(siteMembers.siteId, siteId));
      const memberList = memberRows.length
        ? memberRows.map((m) => `  - ${m.email} (role: ${m.role}, status: ${m.status}, memberId: ${m.id})`).join("\n")
        : "  (no team members)";
      pageContext = `The user is on the team management page. Use invite_team_member to invite new members, change_team_role to update an existing member's role. Call list_team first before making changes.\n\nCURRENT TEAM:\n${memberList}`;
    } else if (currentPath === "/theme") {
      const lines: string[] = [
        "The user is on the theme/header-footer editor page.",
        "To change MENU ITEMS (nav links), call the update_navigation tool.",
        "To change EDITABLE FIELD VALUES (logo, button text, contact email, etc.), call update_header or update_footer with editableFields.",
        "To rewrite the HTML structure (add/remove elements, restructure layout), call update_header or update_footer with html.",
        "Call read_header_footer first to see current HTML and wired field ids.",
      ];
      pageContext = lines.join("\n");
    }
  }

  const { cachedPrefix: systemCachedPrefix, volatile: systemVolatile } = buildChatSystemPrompt(brief, {
    existingContent: contentSummary,
    navMenus: navMenus as { location: string; items: unknown[] }[],
    existingCollections: siteCollections,
    pageContext,
    themeColors,
    themeFontFamilies,
    themeFontSizes,
    themeCustomCssClasses,
    designIntent: (settings.designIntent as DesignIntent | undefined) ?? undefined,
  }, hasStitch);

  const router = getAIRouter();

  // Stream tool-use rounds as Server-Sent Events so the client sees actions
  // land in real time. A single chat request can take minutes when the model
  // chains multiple tool calls (e.g. create three posts with images), and a
  // silent connection that long looks indistinguishable from a stalled one
  // (Cloud Run times out, browsers report ERR_FAILED with no CORS headers).
  // Keepalive interval declared outside streamSSE so both the main handler
  // and the error handler can clear it.
  let keepalive: ReturnType<typeof setInterval> | undefined;

  return streamSSE(c, async (sseStream) => {
    const send = (event: string, payload: unknown) =>
      sseStream.writeSSE({ event, data: JSON.stringify(payload) });

    // Send a comment every 20s so Cloudflare and browsers don't drop the SSE
    // connection during long-running tool calls. SSE comment lines (": ...")
    // are ignored by EventSource clients but keep the TCP connection alive.
    keepalive = setInterval(() => {
      sseStream.writeSSE({ data: "", event: "ping" }).catch(() => clearInterval(keepalive));
    }, 20_000);

    await send("start", { turnId });

    let responseText = "";
    let model = "mock";
    let usedFallback = false;
    const toolActions: ChatAction[] = [];

    if (!router) {
      responseText = "AI providers are not yet configured. Please configure your AI providers in settings.";
      await send("text", { text: responseText });
    } else {
      const readCtx: ReadToolContext = { siteId, currentPath };
      const writeTools = writeToolDefinitionsForRole(userRole);
      const allTools = hasDesigner
        ? [...readToolDefinitions, ...writeTools, designPageTool]
        : [...readToolDefinitions, ...writeTools];
      const messages: AIMessage[] = [];
      for (const h of conversationHistory ?? []) {
        messages.push({ role: h.role, content: h.content });
      }
      messages.push({ role: "user", content: message });

      const MAX_TOOL_ROUNDS = 8;
      let rounds = 0;
      let lastText = "";
      let lastModel = "mock";
      try {
        while (rounds++ < MAX_TOOL_ROUNDS) {
          const result = await router.generateWithTools({
            task: "copywriting",
            cachedSystemPrefix: systemCachedPrefix,
            systemPrompt: systemVolatile,
            tools: allTools,
            messages,
            temperature: 0.7,
            maxTokens: 4096,
          });
          lastModel = result.model;
          if (result.usedFallback) usedFallback = true;
          messages.push(result.message);

          const contentBlocks = Array.isArray(result.message.content) ? result.message.content : [];
          const roundText = contentBlocks
            .filter((b): b is Extract<AIMessageContent, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (roundText) {
            await send("text", { text: roundText });
          }

          if (result.stopReason !== "tool_use") {
            lastText = roundText;
            break;
          }

          const toolUses = contentBlocks.filter(
            (b): b is Extract<AIMessageContent, { type: "tool_use" }> => b.type === "tool_use",
          );
          const toolResults: AIMessageContent[] = [];
          const writeCtx: WriteToolContext = {
            siteId,
            turnId,
            model: lastModel,
            usedFallback,
            message,
            router,
            storage: storageProvider,
            role: userRole,
            designIntent: (settings.designIntent as DesignIntent | undefined) ?? undefined,
          };
          for (const use of toolUses) {
            await send("tool_start", { name: use.name, toolUseId: use.id });
            if (use.name === "design_page") {
              const outcome = await runDesignPageTool(use.input, {
                siteId,
                turnId,
                model: lastModel,
                usedFallback,
                message,
              });
              toolActions.push(outcome.action);
              await send("action", { action: outcome.action });
              toolResults.push({
                type: "tool_result",
                tool_use_id: use.id,
                content: outcome.content,
                is_error: outcome.is_error,
              });
            } else if (isWriteTool(use.name)) {
              const outcome = await executeWriteTool(use.name, use.input, writeCtx);
              toolActions.push(outcome.action);
              await send("action", { action: outcome.action });
              toolResults.push({
                type: "tool_result",
                tool_use_id: use.id,
                content: outcome.content,
                is_error: outcome.is_error,
              });
            } else {
              const { content, is_error } = await executeReadTool(use.name, use.input, readCtx);
              toolResults.push({ type: "tool_result", tool_use_id: use.id, content, is_error });
            }
          }
          messages.push({ role: "user", content: toolResults });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("Chat tool loop failed:", err);
        await send("error", { error: errMsg });
        // Fall through to log + done so any completed actions are still surfaced
        lastText = lastText || `I hit an error mid-task: ${errMsg}`;
      }

      responseText = lastText;
      model = lastModel;
    }

    const cleanText = responseText.trim();

    // Conversation-level log (no undo info — this row is the chat summary)
    try {
      await db.insert(aiHistory).values({
        siteId,
        turnId,
        taskType: "copywriting",
        action: `chat: ${message.slice(0, 200)}`,
        suggestion: cleanText,
        model,
        usedFallback: usedFallback ? 1 : 0,
      });
    } catch (err) {
      console.warn("Failed to write chat ai_history row:", err);
    }

    // Increment chat message usage for free-tier tracking
    const chatPeriod = new Date().toISOString().slice(0, 10);
    incrementUsage(siteId, "chat_message", chatPeriod).catch((err) =>
      console.warn("Failed to increment chat usage:", err)
    );

    clearInterval(keepalive);
    await send("done", {
      turnId,
      text: cleanText,
      actions: toolActions,
      model,
      usedFallback,
    });
  }, async (err, sseStream) => {
    clearInterval(keepalive);
    console.error("Chat SSE stream errored:", err);
    try {
      await sseStream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: err.message || "Stream error" }),
      });
    } catch {
      // Stream may already be closed
    }
  });
});
