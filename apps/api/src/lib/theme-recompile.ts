import { eq } from "drizzle-orm";
import { db, sites, content, contentBlocks } from "@cadmus/db";
import { sql } from "drizzle-orm";
import { compileTailwindForTheme, buildGoogleFontsUrl } from "@cadmus/ai";
import type { SiteTheme } from "@cadmus/shared";
import { mirrorGoogleFontsCss } from "./font-mirror.js";

const MATERIAL_SYMBOLS_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200";

/**
 * Regenerate compiled Tailwind CSS for a site against its current blocks
 * and theme tokens, persisting the result to settings.theme.compiledCss.
 *
 * Best-effort: errors are logged and swallowed so callers (block writes)
 * never fail because of a compile hiccup.
 */
export async function recompileSiteCss(siteId: string): Promise<void> {
  try {
    const [siteRow] = await db.select().from(sites).where(eq(sites.id, siteId));
    if (!siteRow) return;

    const settings = (siteRow.settings as Record<string, unknown>) ?? {};
    const theme = (settings.theme ?? null) as Record<string, unknown> | null;
    if (!theme) return;

    const pageRows = await db.select().from(content).where(eq(content.siteId, siteId));
    const blockRows = pageRows.length
      ? await db
          .select()
          .from(contentBlocks)
          .where(sql`${contentBlocks.contentId} IN (${sql.join(pageRows.map((p) => sql`${p.id}`), sql`, `)})`)
      : [];

    // Post-template blocks live in settings.postTemplate, not in contentBlocks.
    // They wrap every blog post at render time, so their classes need to be in
    // the compiled CSS just like any other block.
    const postTemplate = settings.postTemplate as { blocks?: Array<{ data?: { html?: string } }> } | undefined;
    const postTemplateBlocks = postTemplate?.blocks ?? [];

    const allBlocks = [
      ...(blockRows as Array<{ data?: { html?: string } }>),
      ...postTemplateBlocks,
    ];

    const typedTheme = theme as unknown as SiteTheme;
    const css = await compileTailwindForTheme(typedTheme, allBlocks);

    // Keep the Google Fonts <link> URLs in sync with the family stacks the
    // editor most recently saved. Without this, changing fontFamilies in admin
    // would update CSS variables but the browser would never load the new
    // font face. We replace the Google Fonts entries and preserve any
    // non-Google-Fonts URLs the extractor may have captured.
    const generated = buildGoogleFontsUrl(typedTheme.fontFamilies);
    const preservedFonts = (typedTheme.fonts ?? []).filter(
      (url) => typeof url === "string" && !url.includes("fonts.googleapis.com") && !url.includes("storage.googleapis.com/cadmus-"),
    );

    // Mirror Google-hosted CSS into our shared bucket so visitors don't make a
    // render-blocking request to a third party. mirrorGoogleFontsCss returns
    // the original URL on failure, so a transient mirror miss never breaks the
    // site — it just falls back to Google for that recompile.
    const mirroredGenerated = generated ? await mirrorGoogleFontsCss(generated) : null;
    const nextFonts = mirroredGenerated ? [mirroredGenerated, ...preservedFonts] : preservedFonts;
    const mirroredMs = typedTheme.materialSymbols
      ? await mirrorGoogleFontsCss(MATERIAL_SYMBOLS_CSS_URL)
      : undefined;

    const updatedSettings = {
      ...settings,
      theme: {
        ...theme,
        compiledCss: css,
        fonts: nextFonts,
        ...(mirroredMs ? { materialSymbolsCssUrl: mirroredMs } : {}),
      },
    };
    await db.update(sites).set({ settings: updatedSettings }).where(eq(sites.id, siteId));
  } catch (err) {
    console.warn(`[theme-recompile] failed for site ${siteId}:`, err);
  }
}
