import type { HtmlBlockEditableField } from "./design.js";

export type DesignStyle =
  | "modern"
  | "classic"
  | "playful"
  | "minimal"
  | "bold"
  | "elegant";

/**
 * Unified, provider-agnostic site theme. Stored at `sites.settings.theme`.
 * Every page-design provider (Stitch today, Claude Design / Claude Code
 * tomorrow) writes into this same shape, and every renderer reads from it.
 */
export interface FontSizeToken {
  size: string;
  lineHeight?: string;
  letterSpacing?: string;
  fontWeight?: string;
}

export interface SiteTheme {
  colors: Record<string, string>;
  fontFamilies: Record<string, string[]>;
  /** Custom font-size scale (e.g. h1, h2, body-md) emitted as Tailwind v4 --text-* tokens. */
  fontSizes?: Record<string, FontSizeToken>;
  /** External font stylesheet URLs to inject into <head>. Populated by recompileSiteCss
   * with self-hosted mirror URLs (falls back to fonts.googleapis.com if mirroring fails). */
  fonts: string[];
  materialSymbols: boolean;
  /** Self-hosted mirror URL for the Material Symbols icon CSS. Set by recompileSiteCss
   * when materialSymbols is true; BaseLayout falls back to the Google URL if absent. */
  materialSymbolsCssUrl?: string;
  borderRadius: Record<string, string>;
  /** Custom spacing tokens from the Stitch Tailwind config (e.g. section-padding, stack-lg). */
  spacing?: Record<string, string>;
  bodyClasses?: string;

  headerHtml?: string;
  footerHtml?: string;
  headerEditableFields?: Record<string, HtmlBlockEditableField>;
  footerEditableFields?: Record<string, HtmlBlockEditableField>;

  customCss: string;
  compiledCss?: string;

  /**
   * Opaque provider-owned state (e.g. Stitch project id). Only the matching
   * PageDesigner implementation reads into this — Cadmus core never does.
   */
  designerState?: {
    stitch?: { projectId: string };
  };

  /** Preset this was seeded from, for the UI reset button. */
  presetSeed?: DesignStyle;

  version: 1;
}
