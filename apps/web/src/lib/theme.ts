import { themePresets } from "@cadmus/shared";
import type { SiteTheme, DesignStyle } from "@cadmus/shared";

function relLuminance(hex: string): number {
  const c = hex.replace("#", "");
  if (c.length !== 6) return 1;
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lum = (x: number) => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
}

function computeOnColor(hex: string): string {
  return relLuminance(hex) > 0.179 ? "#1a1a1a" : "#ffffff";
}

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return `rgba(255,255,255,${alpha})`;
  return `rgba(${parseInt(c.slice(0, 2), 16)},${parseInt(c.slice(2, 4), 16)},${parseInt(c.slice(4, 6), 16)},${alpha})`;
}

function resolveTheme(raw: unknown): SiteTheme {
  if (raw && typeof raw === "object" && "colors" in (raw as Record<string, unknown>)) {
    return raw as SiteTheme;
  }
  const seed = (typeof raw === "string" ? raw : "modern") as DesignStyle;
  return themePresets[seed] ?? themePresets.modern;
}

export function getThemeVars(settings?: Record<string, unknown> | null): string {
  const theme = resolveTheme(settings?.theme);
  const colors = theme.colors ?? {};
  const radius = theme.borderRadius ?? {};
  const headingFont = (theme.fontFamilies?.heading ?? ["system-ui"]).join(", ");
  const bodyFont = (theme.fontFamilies?.body ?? ["system-ui"]).join(", ");

  // Stitch-imported themes use Material Design naming (on-surface, outline,
  // surface-container-low) — different from preset themes which use the
  // simple text/textMuted/border. Legacy blocks (Hero, TextSection, etc.)
  // read the simple names via these CSS vars, so when a Stitch theme is
  // active we'd fall through to the gray defaults and render unreadable
  // text on a dark Stitch background. Map the Material Design tokens to
  // the legacy var slots so legacy blocks stay readable on Stitch sites.
  const text = colors.text ?? colors["on-surface"] ?? colors["on-background"];
  const textMuted = colors.textMuted ?? colors["on-surface-variant"];
  const border = colors.border ?? colors["outline-variant"] ?? colors.outline;

  // --color-on-primary: text colour to use ON top of a primary-coloured background.
  // Compute by luminance: if primary is dark use white, otherwise dark text.
  const onPrimary = colors.onPrimary ?? computeOnColor(colors.primary ?? "#1a1a1a");

  // Always-light text for dark/image/gradient sections (see compile-tailwind.ts).
  const bgHex = colors.background ?? "#ffffff";
  const onDark = colors.onDark ?? (/^#[0-9a-fA-F]{6}$/.test(bgHex) && relLuminance(bgHex) > 0.6 ? bgHex : "#ffffff");

  return [
    `--color-primary: ${colors.primary ?? "#1a1a1a"}`,
    `--color-primary-hover: ${colors.primaryHover ?? colors.primary ?? "#333"}`,
    `--color-on-primary: ${onPrimary}`,
    `--color-accent: ${colors.accent ?? colors.primary ?? "#1a1a1a"}`,
    `--color-bg: ${colors.background ?? "#ffffff"}`,
    `--color-surface: ${colors.surface ?? "#f8fafc"}`,
    `--color-text: ${text ?? "#1a1a1a"}`,
    `--color-text-muted: ${textMuted ?? "#64748b"}`,
    `--color-on-dark: ${onDark}`,
    `--color-on-dark-muted: ${hexToRgba(onDark, 0.74)}`,
    `--color-border: ${border ?? "#e2e8f0"}`,
    `--font-heading: ${headingFont}`,
    `--font-body: ${bodyFont}`,
    `--spacing-unit: 8px`,
    `--radius-sm: ${radius.sm ?? "4px"}`,
    `--radius-md: ${radius.md ?? "8px"}`,
    `--radius-lg: ${radius.lg ?? "12px"}`,
    `--radius-full: ${radius.full ?? "9999px"}`,
  ].join("; ");
}
