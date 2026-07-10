import type { SiteTheme } from "../types/theme.js";

/**
 * Convert a SiteTheme into the Tailwind config object shape consumed by the
 * CDN script (Play CDN) and the build-time compiler. Used by the renderer,
 * the exporter, and the admin editor preview — a single source of truth so
 * all three stay in sync.
 */
export function themeToTailwindConfig(theme: SiteTheme): {
  theme: {
    extend: {
      colors: Record<string, string>;
      fontFamily: Record<string, string[]>;
      borderRadius: Record<string, string>;
    };
  };
} {
  return {
    theme: {
      extend: {
        colors: theme.colors,
        fontFamily: theme.fontFamilies,
        borderRadius: theme.borderRadius,
      },
    },
  };
}
