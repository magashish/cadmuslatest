import { compile, optimize } from "@tailwindcss/node";
import { parse } from "node-html-parser";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SiteTheme } from "@cadmus/shared";

// Resolve the tailwindcss index.css path once at import time
const require = createRequire(import.meta.url);
let tailwindCssPath: string;
try {
  tailwindCssPath = require.resolve("tailwindcss/index.css");
} catch {
  // Fallback: try resolving the package and finding index.css
  const pkgPath = require.resolve("tailwindcss/package.json");
  tailwindCssPath = dirname(pkgPath) + "/index.css";
}
const tailwindBaseCss = readFileSync(tailwindCssPath, "utf-8");

/**
 * Extract all CSS class names from an HTML string.
 */
function extractClassesFromHtml(html: string): Set<string> {
  const classes = new Set<string>();
  const root = parse(html);

  for (const el of root.querySelectorAll("[class]")) {
    const raw = el.getAttribute("class") || "";
    for (const cls of raw.split(/\s+/)) {
      const trimmed = cls.trim();
      if (trimmed) classes.add(trimmed);
    }
  }

  return classes;
}

// Common font names referenced via `font-{name}` utilities that Stitch
// sometimes emits without a matching tailwind.config entry. Provide a
// fallback stack so the class still compiles.
const FONT_NAME_FALLBACKS: Record<string, string> = {
  inter: "Inter, sans-serif",
  roboto: "Roboto, sans-serif",
  "roboto-mono": "'Roboto Mono', monospace",
  poppins: "Poppins, sans-serif",
  lato: "Lato, sans-serif",
  montserrat: "Montserrat, sans-serif",
  nunito: "Nunito, sans-serif",
  "open-sans": "'Open Sans', sans-serif",
  oswald: "Oswald, sans-serif",
  raleway: "Raleway, sans-serif",
  rubik: "Rubik, sans-serif",
  "source-sans": "'Source Sans Pro', sans-serif",
  "playfair-display": "'Playfair Display', serif",
  merriweather: "Merriweather, serif",
  lora: "Lora, serif",
  "noto-serif": "'Noto Serif', serif",
  "fira-code": "'Fira Code', monospace",
};

/** Inspect the supplied class set for `font-{name}` references not covered by theme.fontFamilies. */
function collectFontNameFallbacks(
  theme: SiteTheme,
  classes: Set<string>,
): Record<string, string> {
  const known = new Set(Object.keys(theme.fontFamilies ?? {}).map((n) => n.toLowerCase()));
  const fallbacks: Record<string, string> = {};
  for (const cls of classes) {
    const m = cls.match(/^font-([a-z][a-z0-9-]*)$/i);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (known.has(name)) continue;
    if (fallbacks[name]) continue;
    const stack = FONT_NAME_FALLBACKS[name];
    if (stack) fallbacks[name] = stack;
  }
  return fallbacks;
}

/**
 * Build the full Tailwind CSS input by appending custom theme overrides
 * to the default Tailwind stylesheet.
 */
function computeOnColor(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return "#ffffff";
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lum = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
  return L > 0.179 ? "#1a1a1a" : "#ffffff";
}

// Relative luminance (0 = black, 1 = white) for a #rrggbb colour.
function relLuminance(hex: string): number {
  const c = hex.replace("#", "");
  if (c.length !== 6) return 1;
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lum = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
}

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return `rgba(255,255,255,${alpha})`;
  return `rgba(${parseInt(c.slice(0, 2), 16)},${parseInt(c.slice(2, 4), 16)},${parseInt(c.slice(4, 6), 16)},${alpha})`;
}

function buildTailwindInput(theme: SiteTheme, fontNameFallbacks: Record<string, string> = {}): string {
  const overrides: string[] = ["@theme {"];

  // Colors → --color-*
  if (theme.colors) {
    for (const [name, value] of Object.entries(theme.colors)) {
      const kebab = name.replace(/([A-Z])/g, "-$1").toLowerCase();
      overrides.push(`  --color-${kebab}: ${value};`);
    }
  }

  // Font families → --font-*
  if (theme.fontFamilies) {
    for (const [name, stack] of Object.entries(theme.fontFamilies)) {
      const kebab = name.replace(/([A-Z])/g, "-$1").toLowerCase();
      const value = Array.isArray(stack) ? stack.join(", ") : stack;
      overrides.push(`  --font-${kebab}: ${value};`);
    }
  }

  // Fallback font-* references (e.g. font-inter when not in fontFamily config)
  for (const [name, stack] of Object.entries(fontNameFallbacks)) {
    overrides.push(`  --font-${name}: ${stack};`);
  }

  // Font sizes → --text-* (with --line-height/--letter-spacing/--font-weight siblings for tuples)
  if (theme.fontSizes) {
    for (const [name, token] of Object.entries(theme.fontSizes)) {
      const kebab = name.replace(/([A-Z])/g, "-$1").toLowerCase();
      overrides.push(`  --text-${kebab}: ${token.size};`);
      if (token.lineHeight) {
        overrides.push(`  --text-${kebab}--line-height: ${token.lineHeight};`);
      }
      if (token.letterSpacing) {
        overrides.push(`  --text-${kebab}--letter-spacing: ${token.letterSpacing};`);
      }
      if (token.fontWeight) {
        overrides.push(`  --text-${kebab}--font-weight: ${token.fontWeight};`);
      }
    }
  }

  // Border radius → --radius-*
  if (theme.borderRadius) {
    for (const [name, value] of Object.entries(theme.borderRadius)) {
      const kebab = name.replace(/([A-Z])/g, "-$1").toLowerCase();
      overrides.push(`  --radius-${kebab}: ${value};`);
    }
  }

  // Custom spacing tokens → --spacing-* (e.g. section-padding, stack-lg)
  if (theme.spacing) {
    for (const [name, value] of Object.entries(theme.spacing)) {
      const kebab = name.replace(/([A-Z])/g, "-$1").toLowerCase();
      overrides.push(`  --spacing-${kebab}: ${value};`);
    }
  }

  overrides.push("}");

  // Stitch HTML sets `<html class="light">` and configures `darkMode: "class"`
  // in its tailwind.config script. Tailwind v4's default `dark:` variant uses
  // `prefers-color-scheme`, which would activate dark utilities for any visitor
  // with their OS in dark mode — even though the Stitch markup intends class-
  // based opt-in. Override the `dark` variant to match `.dark` on the element
  // or any ancestor so behavior matches what the Stitch designer expects.
  overrides.push("@custom-variant dark (&:where(.dark, .dark *));");

  // Combine the default Tailwind CSS with our theme overrides
  return tailwindBaseCss + "\n\n" + overrides.join("\n");
}

/**
 * Compile Tailwind CSS for the given theme + HTML blocks.
 *
 * Extracts class names from all HTML (blocks + header + footer + body),
 * compiles Tailwind with the theme tokens applied via @theme, and
 * returns the minimal CSS. Appends any customCss from the theme.
 */
export async function compileTailwindForTheme(
  theme: SiteTheme,
  htmlBlocks: Array<{ data?: { html?: string } }>,
): Promise<string> {
  // Collect all classes from all HTML sources
  const allClasses = new Set<string>();

  for (const block of htmlBlocks) {
    if (block.data?.html) {
      for (const cls of extractClassesFromHtml(block.data.html)) {
        allClasses.add(cls);
      }
    }
  }

  if (theme.headerHtml) {
    for (const cls of extractClassesFromHtml(theme.headerHtml)) {
      allClasses.add(cls);
    }
  }
  if (theme.footerHtml) {
    for (const cls of extractClassesFromHtml(theme.footerHtml)) {
      allClasses.add(cls);
    }
  }

  // Include body/html-level classes (e.g. scroll-smooth, bg-surface, selection:*)
  if (theme.bodyClasses) {
    for (const cls of theme.bodyClasses.split(/\s+/)) {
      const trimmed = cls.trim();
      if (trimmed) allClasses.add(trimmed);
    }
  }

  if (allClasses.size === 0) {
    return theme.customCss ? optimize(theme.customCss, { minify: true }).code : "";
  }

  // Compile Tailwind with the full base + theme overrides
  const fontNameFallbacks = collectFontNameFallbacks(theme, allClasses);
  const input = buildTailwindInput(theme, fontNameFallbacks);
  const compiled = await compile(input, {
    base: dirname(tailwindCssPath),
    onDependency: () => {},
  });

  const tailwindCss = compiled.build(Array.from(allClasses));

  // Combine Tailwind output with any custom CSS
  const parts: string[] = [];
  if (tailwindCss) parts.push(tailwindCss);
  if (theme.customCss) parts.push(theme.customCss);

  // Plain :root rules for variables that are only used in inline style="" attributes
  // and would be tree-shaken out of @theme by Tailwind v4's compiler.
  const rootVars: string[] = [];

  // Mirror EVERY theme color into :root. Generated blocks reference these tokens
  // via inline `style="color: var(--color-text)"`, which Tailwind v4 doesn't see
  // as usage — so it tree-shakes the unused ones (e.g. --color-text,
  // --color-text-muted) out of @theme and they end up undefined at runtime,
  // making that text fall back to an inherited colour (unreadable). Emitting a
  // plain :root copy guarantees every token resolves regardless of tree-shaking.
  if (theme.colors) {
    for (const [name, value] of Object.entries(theme.colors)) {
      if (typeof value !== "string") continue;
      const kebab = name.replace(/([A-Z])/g, "-$1").toLowerCase();
      rootVars.push(`--color-${kebab}:${value}`);
    }
  }

  // --color-on-primary: never stored in theme.colors by any pipeline.
  if (theme.colors?.primary && !theme.colors?.onPrimary) {
    rootVars.push(`--color-on-primary:${computeOnColor(theme.colors.primary)}`);
  }

  // --color-on-dark / -muted: an ALWAYS-LIGHT text colour for text on dark or
  // image/gradient section backgrounds. Unlike on-primary (computed from the
  // primary colour, so DARK when the primary is light → dark-on-dark), this is
  // guaranteed light. The page designer uses it for text on dark sections.
  if (!theme.colors?.onDark) {
    const bgHex = theme.colors?.bg ?? theme.colors?.background;
    const onDark = bgHex && /^#[0-9a-fA-F]{6}$/.test(bgHex) && relLuminance(bgHex) > 0.6 ? bgHex : "#ffffff";
    rootVars.push(`--color-on-dark:${onDark}`);
    rootVars.push(`--color-on-dark-muted:${hexToRgba(onDark, 0.74)}`);
  }

  // --color-bg alias: the palette generator used to store this as "background"
  // (→ --color-background) but Claude-generated HTML references var(--color-bg).
  // Emit the alias for any site that hasn't migrated to the "bg" key yet.
  if (theme.colors?.background && !theme.colors?.bg) {
    rootVars.push(`--color-bg:${theme.colors.background}`);
  }

  if (rootVars.length > 0) {
    parts.push(`:root{${rootVars.join(";")}}`);
  }

  // Minify at compile time so the inlined <style> in BaseLayout ships the
  // smallest possible payload — this CSS is regenerated on every theme save
  // and block write, so the cost is paid once per change, not per request.
  const combined = parts.join("\n\n");
  return combined ? optimize(combined, { minify: true }).code : "";
}
