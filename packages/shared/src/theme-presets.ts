import type { DesignStyle, SiteTheme } from "./types/theme.js";

export const themePresets: Record<DesignStyle, SiteTheme> = {
  modern: {
    colors: {
      primary: "#2563eb",
      primaryHover: "#1d4ed8",
      secondary: "#64748b",
      accent: "#2563eb",
      background: "#ffffff",
      surface: "#f8fafc",
      text: "#1a1a1a",
      textMuted: "#64748b",
      border: "#e2e8f0",
    },
    fontFamilies: {
      heading: ["system-ui", "-apple-system", "sans-serif"],
      body: ["system-ui", "-apple-system", "sans-serif"],
    },
    fonts: [],
    materialSymbols: false,
    borderRadius: { sm: "4px", md: "8px", lg: "12px", full: "9999px" },
    customCss: "",
    presetSeed: "modern",
    version: 1,
  },

  classic: {
    colors: {
      primary: "#8b4513",
      primaryHover: "#6d3410",
      secondary: "#6b7280",
      accent: "#b8860b",
      background: "#faf8f5",
      surface: "#f5f0e8",
      text: "#2c1810",
      textMuted: "#78716c",
      border: "#d6cfc7",
    },
    fontFamilies: {
      heading: ["Georgia", "'Times New Roman'", "serif"],
      body: ["Georgia", "'Times New Roman'", "serif"],
    },
    fonts: [],
    materialSymbols: false,
    borderRadius: { sm: "2px", md: "4px", lg: "6px", full: "9999px" },
    customCss: "",
    presetSeed: "classic",
    version: 1,
  },

  playful: {
    colors: {
      primary: "#e84393",
      primaryHover: "#d63384",
      secondary: "#6c5ce7",
      accent: "#00b894",
      background: "#ffffff",
      surface: "#fef9ff",
      text: "#1a1a2e",
      textMuted: "#636e72",
      border: "#dfe6e9",
    },
    fontFamilies: {
      heading: ["Nunito", "system-ui", "sans-serif"],
      body: ["Nunito", "system-ui", "sans-serif"],
    },
    fonts: [
      "https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap",
    ],
    materialSymbols: false,
    borderRadius: { sm: "8px", md: "16px", lg: "24px", full: "9999px" },
    customCss: "",
    presetSeed: "playful",
    version: 1,
  },

  minimal: {
    colors: {
      primary: "#111111",
      primaryHover: "#333333",
      secondary: "#666666",
      accent: "#111111",
      background: "#ffffff",
      surface: "#fafafa",
      text: "#111111",
      textMuted: "#888888",
      border: "#eaeaea",
    },
    fontFamilies: {
      heading: ["Inter", "system-ui", "sans-serif"],
      body: ["Inter", "system-ui", "sans-serif"],
    },
    fonts: [
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
    ],
    materialSymbols: false,
    borderRadius: { sm: "2px", md: "2px", lg: "4px", full: "9999px" },
    customCss: "",
    presetSeed: "minimal",
    version: 1,
  },

  bold: {
    colors: {
      primary: "#dc2626",
      primaryHover: "#b91c1c",
      secondary: "#1e293b",
      accent: "#dc2626",
      background: "#ffffff",
      surface: "#f1f5f9",
      text: "#0d0d0d",
      textMuted: "#475569",
      border: "#cbd5e1",
    },
    fontFamilies: {
      heading: ["system-ui", "-apple-system", "sans-serif"],
      body: ["system-ui", "-apple-system", "sans-serif"],
    },
    fonts: [],
    materialSymbols: false,
    borderRadius: { sm: "0px", md: "0px", lg: "0px", full: "9999px" },
    customCss: "",
    presetSeed: "bold",
    version: 1,
  },

  elegant: {
    colors: {
      primary: "#8b7355",
      primaryHover: "#6d5a43",
      secondary: "#9ca3af",
      accent: "#8b7355",
      background: "#fcfbf9",
      surface: "#f7f5f2",
      text: "#2d2d2d",
      textMuted: "#78716c",
      border: "#e7e5e4",
    },
    fontFamilies: {
      heading: ["'Playfair Display'", "Georgia", "serif"],
      body: ["system-ui", "-apple-system", "sans-serif"],
    },
    fonts: [
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&display=swap",
    ],
    materialSymbols: false,
    borderRadius: { sm: "2px", md: "4px", lg: "8px", full: "9999px" },
    customCss: "",
    presetSeed: "elegant",
    version: 1,
  },
};
