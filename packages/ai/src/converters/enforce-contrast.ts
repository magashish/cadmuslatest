import { parse, HTMLElement } from "node-html-parser";
import type { SiteTheme } from "@cadmus/shared";

// ---------------------------------------------------------------------------
// Deterministic contrast safety-net.
//
// The page designer is told to use var(--color-on-dark) for text on dark
// sections and var(--color-on-primary) only on primary-COLORED backgrounds. If
// it slips — e.g. uses var(--color-on-primary) (which is dark when the primary
// is light) or var(--color-text) on a dark/gradient section — the text renders
// dark-on-dark. This pass walks the markup, tracks whether the nearest
// background is a genuinely-dark CUSTOM surface, and rewrites text tokens that
// would be invisible there.
//
// It is intentionally CONSERVATIVE: it only acts inside a confidently-dark,
// non-brand background. Primary/accent-coloured bands (where on-primary is
// correct), light cards inside dark sections, and light sections are all left
// untouched. When a background's nature is unknown it inherits the ancestor's.
// ---------------------------------------------------------------------------

function relLuminance(hex: string): number | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const c = m[1];
  const ch = (i: number) => {
    const x = parseInt(c.slice(i, i + 2), 16) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

// Matches compile-tailwind.ts computeOnColor: dark text above 0.179, else white.
function computeOnColor(hex: string): string {
  const L = relLuminance(hex);
  return L != null && L > 0.179 ? "#1a1a1a" : "#ffffff";
}

// Tailwind background-shade classes that are unambiguously dark / light.
const DARK_BG_CLASS = /\bbg-(black|(?:gray|grey|slate|zinc|neutral|stone)-(?:700|800|900|950))\b/;
const LIGHT_BG_CLASS = /\bbg-(white|(?:gray|grey|slate|zinc|neutral|stone)-(?:50|100|200))\b/;

type BgKind = "darkCustom" | "brand" | "light" | null;

export function enforceContrast(html: string, theme: SiteTheme): string {
  if (!html) return html;
  const colors = (theme.colors ?? {}) as Record<string, string>;
  const primary = colors.primary;
  const onPrimary = colors.onPrimary ?? (primary ? computeOnColor(primary) : undefined);
  // on-primary only needs flipping on a dark custom section when it's dark.
  const onPrimaryDark = onPrimary ? (relLuminance(onPrimary) ?? 1) < 0.45 : false;

  const isDarkHex = (hex: string) => { const L = relLuminance(hex); return L != null && L < 0.45; };
  const isLightHex = (hex: string) => { const L = relLuminance(hex); return L != null && L > 0.6; };

  // Classify an element's OWN background. null = unknown (inherit ancestor).
  const classifyBg = (el: HTMLElement): BgKind => {
    const style = el.getAttribute("style") || "";
    const cls = el.getAttribute("class") || "";

    // Gradients: brand if built from the primary/accent token; darkCustom if a
    // dark colour stop is present; otherwise unknown.
    if (/linear-gradient|radial-gradient/.test(style)) {
      if (/var\(--color-(?:primary|accent)\)/.test(style)) return "brand";
      if (/#(?:[0-3][0-9a-f]{2}|[0-3][0-9a-f]\b)/i.test(style) || /rgba?\(\s*[0-3]?\d\s*,/.test(style)) return "darkCustom";
      return null;
    }
    if (/background-image\s*:|url\(/.test(style)) return null; // photos — too ambiguous

    // Inline background colour.
    const bgInline = /background(?:-color)?:\s*([^;]+)/.exec(style)?.[1]?.trim();
    if (bgInline) {
      if (/var\(--color-(?:primary|accent)\)/.test(bgInline)) return "brand";
      if (bgInline.startsWith("#")) {
        if (isDarkHex(bgInline)) return "darkCustom";
        if (isLightHex(bgInline)) return "light";
      }
    }

    // Class-based backgrounds.
    if (/\bbg-\[(?:color:)?var\(--color-(?:primary|accent)\)\]/.test(cls)) return "brand";
    if (DARK_BG_CLASS.test(cls)) return "darkCustom";
    if (LIGHT_BG_CLASS.test(cls) || /\bbg-\[(?:color:)?var\(--color-(?:bg|background)\)\]/.test(cls)) return "light";
    const arbHex = /\bbg-\[(#[0-9a-fA-F]{6})\]/.exec(cls);
    if (arbHex) {
      if (isDarkHex(arbHex[1])) return "darkCustom";
      if (isLightHex(arbHex[1])) return "light";
    }
    return null;
  };

  // Rewrite the dark-coloured text tokens in a class/style string to light ones.
  const fixForDark = (value: string): string =>
    value
      .replace(/--color-text-muted\b/g, "--color-on-dark-muted")
      .replace(/--color-text\b/g, "--color-on-dark")
      .replace(/--color-on-primary\b/g, onPrimaryDark ? "--color-on-dark" : "--color-on-primary");

  const root = parse(html);
  let changed = false;

  const walk = (el: HTMLElement, inDarkCustom: boolean) => {
    const kind = classifyBg(el);
    // brand/light backgrounds end the dark-custom context; unknown inherits.
    const ctxDark = kind === "darkCustom" ? true : kind == null ? inDarkCustom : false;

    if (ctxDark) {
      for (const attr of ["style", "class"] as const) {
        const val = el.getAttribute(attr);
        if (!val || !val.includes("--color-")) continue;
        const fixed = fixForDark(val);
        if (fixed !== val) { el.setAttribute(attr, fixed); changed = true; }
      }
    }

    for (const child of el.childNodes) {
      if (child instanceof HTMLElement) walk(child, ctxDark);
    }
  };

  for (const child of root.childNodes) {
    if (child instanceof HTMLElement) walk(child, false);
  }

  return changed ? root.toString() : html;
}
