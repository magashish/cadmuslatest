import type { SiteBrief, SiteTheme, DesignIntent } from "@cadmus/shared";

/**
 * Input to a PageDesigner. The theme is the site's full, current SiteTheme —
 * every field (colors, fontFamilies, borderRadius, materialSymbols, etc.) is
 * available so the designer can produce a page that is consistent with the
 * rest of the site.
 *
 * `designerState` lets a stateful designer (e.g. Stitch's per-site project)
 * thread opaque state across calls. The core never reads into it.
 */
export interface DesignPageInput {
  brief: SiteBrief;
  pageType: string;
  pagePurpose?: string;
  theme: SiteTheme;
  existingContent?: string;
  inspirationAnalysis?: string;
  deviceType?: "DESKTOP" | "MOBILE";
  designerState?: SiteTheme["designerState"];
  // The realized design intent from the homepage. Present for pages generated
  // AFTER the homepage so they match the established direction (the homepage
  // itself has none yet — it's what the intent is synthesized from).
  designIntent?: DesignIntent;
}

export interface DesignPageOutput {
  html: string;
  /**
   * Opaque state the designer wants persisted onto `theme.designerState` so
   * the next call can reuse session/project context. May be unchanged or
   * extended relative to the input.
   */
  designerState?: SiteTheme["designerState"];
}

/**
 * A pluggable page-design provider. Implementations today: Stitch. Intended
 * future plug-ins: Claude Design, Claude Code.
 *
 * Implementations own how to translate the SiteTheme into their own native
 * prompt/config — the consumer code only sees SiteTheme in and HTML out.
 */
export interface PageDesigner {
  readonly name: string;
  designPage(input: DesignPageInput): Promise<DesignPageOutput>;
}
