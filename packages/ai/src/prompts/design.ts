import type { SiteBrief } from "@cadmus/shared";

const LANGUAGE_NAMES: Record<string, string> = {
  es: "Spanish",
};

export function buildDesignPrompt(brief: SiteBrief): string {
  return `You are generating a design token set for a website. Based on the business context below, produce a JSON object matching the DesignTokens interface.

Consider:
- Business type and industry norms (a bakery feels different from a law firm)
- Target audience preferences
- The stated tone/vibe
- Accessibility: ensure sufficient contrast ratios (WCAG AA minimum)
- Mobile-first: readable font sizes, touch-friendly spacing

Business context:
- Name: ${brief.businessName}
- Description: ${brief.businessDescription}
- Tone: ${brief.tone || "professional"}
- Audience: ${brief.targetAudience || "general"}
- Location: ${brief.location || "not specified"}

Return ONLY valid JSON matching this structure:
{
  "colors": {
    "primary": "#hex",
    "primaryHover": "#hex",
    "secondary": "#hex",
    "accent": "#hex",
    "background": "#hex",
    "surface": "#hex",
    "text": "#hex",
    "textMuted": "#hex",
    "border": "#hex"
  },
  "fonts": {
    "heading": "font-family string (use Google Fonts)",
    "body": "font-family string (use Google Fonts)"
  },
  "spacing": {
    "unit": 8,
    "scale": [0.5, 1, 1.5, 2, 3, 4, 6, 8]
  },
  "borderRadius": {
    "sm": "Xpx",
    "md": "Xpx",
    "lg": "Xpx",
    "full": "9999px"
  },
  "style": "modern" | "classic" | "playful" | "minimal" | "bold" | "elegant"
}`;
}

export function buildPageAssemblyPrompt(
  brief: SiteBrief,
  pageType: string,
  pagePurpose?: string
): string {
  return `You are assembling a web page from a component library. Based on the business context and page requirements, decide which components to use, in what order, and with what variants.

Available components and their variants:
- hero: centered, split, video-bg, image-bg
- heading: default, with-subtitle, centered
- text: single-col, two-col, with-image
- image: full-width, contained, rounded
- cta: banner, inline, card
- testimonial: carousel, grid, single-feature
- faq: accordion, two-col, simple
- pricing: cards, table, simple
- gallery: grid, masonry, carousel
- form: contact, newsletter, custom
- video: embed, full-width, contained
- map: default, with-info, full-width

Business context:
- Name: ${brief.businessName}
- Description: ${brief.businessDescription}
- Tone: ${brief.tone || "professional"}
- Goal: ${brief.primaryGoal || "not specified"}
- Audience: ${brief.targetAudience || "general"}${brief.language && brief.language !== "en" ? `\n- Language: ${LANGUAGE_NAMES[brief.language] ?? brief.language} — write all copy in this language` : ""}

Page requirements:
- Type: ${pageType}
- Purpose: ${pagePurpose || "general"}

Return a JSON array of blocks, each with blockType, variant, and populated data fields. Apply direct response copywriting principles:
- Lead with the strongest benefit in the hero
- Include social proof (testimonials) if it's a conversion page
- Every page should have at least one clear CTA
- Keep copy scannable with clear hierarchy
- Place the most important content above the fold`;
}
