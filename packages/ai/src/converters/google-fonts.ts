/**
 * Build a single Google Fonts CSS URL covering every non-system family
 * referenced in `fontFamilies`. Returned in the `family=Name:wght@...` form
 * so the rendered page picks up the regular weight range without per-family
 * configuration.
 *
 * Returns `null` if every family resolves to a system/generic stack.
 */

const CSS_GENERICS = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "none",
]);

const SYSTEM_FONTS = new Set([
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "helvetica",
  "helvetica neue",
  "arial",
  "arial black",
  "verdana",
  "tahoma",
  "trebuchet ms",
  "courier new",
  "courier",
  "consolas",
  "monaco",
  "menlo",
  "times new roman",
  "times",
  "georgia",
  "palatino",
  "lucida console",
  "lucida sans unicode",
  "impact",
]);

const DEFAULT_WEIGHTS = "300;400;500;600;700";

export function buildGoogleFontsUrl(
  fontFamilies: Record<string, string[]> | undefined,
): string | null {
  if (!fontFamilies) return null;
  const families = new Set<string>();
  for (const stack of Object.values(fontFamilies)) {
    if (!Array.isArray(stack) || stack.length === 0) continue;
    const first = typeof stack[0] === "string" ? stack[0].trim() : "";
    if (!first) continue;
    const cleaned = first.replace(/^['"]|['"]$/g, "");
    const lower = cleaned.toLowerCase();
    if (CSS_GENERICS.has(lower)) continue;
    if (SYSTEM_FONTS.has(lower)) continue;
    families.add(cleaned);
  }
  if (families.size === 0) return null;
  const params = Array.from(families)
    .sort()
    .map((f) => `family=${f.replace(/\s+/g, "+")}:wght@${DEFAULT_WEIGHTS}`);
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}
