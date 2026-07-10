import Anthropic from "@anthropic-ai/sdk";
import type { PageDesigner, DesignPageInput, DesignPageOutput } from "./types.js";
import { enforceContrast } from "../converters/enforce-contrast.js";

export interface ClaudePageDesignerConfig {
  apiKey: string;
  model?: string;
}

/**
 * PageDesigner that uses Claude directly to generate full-page HTML layouts.
 * Uses the site's CSS custom properties and Tailwind (CDN) for styling.
 * Unlike StitchPageDesigner, this produces layouts without needing a Stitch
 * project — useful as a fallback or for sites that opt out of Stitch.
 */
export class ClaudePageDesigner implements PageDesigner {
  readonly name = "claude";

  private client: Anthropic;
  private model: string;

  constructor(config: ClaudePageDesignerConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? "claude-sonnet-4-6";
  }

  async designPage(input: DesignPageInput): Promise<DesignPageOutput> {
    const systemPrompt = buildSystemPrompt(input);
    const userPrompt = buildUserPrompt(input);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Deterministic safety-net: fix any dark-text-on-dark-section slips the
    // model made, regardless of how well it followed the contrast rules.
    const html = enforceContrast(extractHtml(raw), input.theme);

    return { html };
  }
}

function buildSystemPrompt(input: DesignPageInput): string {
  const { brief, theme, inspirationAnalysis, designIntent } = input;

  const colorTokens = Object.entries(theme.colors ?? {})
    .map(([k, v]) => `--color-${k}: ${v}`)
    .join("; ");

  const fontTokens = Object.entries(theme.fontFamilies ?? {})
    .map(([k, v]) => `--font-${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("; ");

  // User-specified prohibitions / hard requirements. These are placed both near
  // the top (primacy) and repeated at the very end (recency) because they must
  // win over the aesthetic direction and generic design rules, and this is a
  // long prompt.
  const constraints = (brief.constraints ?? []).filter((c) => typeof c === "string" && c.trim());
  const constraintsBlock = constraints.length
    ? `\n## ABSOLUTE USER CONSTRAINTS — THESE OVERRIDE EVERYTHING BELOW
The client gave these explicit requirements and prohibitions. You MUST obey every one, even when it conflicts with the Aesthetic Direction or any design rule further down. Breaking any single one is a failed result:
${constraints.map((c) => `- ${c}`).join("\n")}
`
    : "";
  const constraintsReminder = constraints.length
    ? `\n\nFINAL CHECK — before you return the HTML, re-read the ABSOLUTE USER CONSTRAINTS near the top and confirm your page violates NONE of them. If any section would break a constraint, rewrite that section. This check is more important than any aesthetic choice.`
    : "";

  // Established design direction from the homepage. Present only for pages
  // generated AFTER the homepage, so the whole site coheres rather than each
  // page re-inventing a look.
  const designIntentBlock = designIntent
    ? `\n## ESTABLISHED DESIGN DIRECTION — MATCH THIS
This site already has a homepage. New pages MUST feel like the same site — same aesthetic, voice, layout language, and imagery. Do not start a fresh design.
- Aesthetic: ${designIntent.aestheticDirection}
- Voice & tone: ${designIntent.voiceAndTone}
- Layout & composition: ${designIntent.layoutPrinciples}
- Imagery: ${designIntent.imageryStyle}
- Color & type: ${designIntent.colorAndType}${designIntent.positioning ? `\n- Positioning: ${designIntent.positioning}` : ""}
`
    : "";

  return `You are an expert web designer and front-end developer. Your task is to produce a single, complete, self-contained HTML page body for a business website. You have deep knowledge of:

- Tailwind CSS v3 utility classes (Tailwind is loaded via CDN — all classes are available)
- CSS custom properties (variables) for theming
- Responsive design and mobile-first layouts
- Conversion-focused landing page structure (clear hierarchy, strong CTAs)
- Semantic HTML5

## Site Identity
Business: ${brief.businessName}
Description: ${brief.businessDescription}
${brief.targetAudience ? `Target Audience: ${brief.targetAudience}` : ""}
${brief.tone ? `Tone: ${brief.tone}` : ""}
${brief.primaryGoal ? `Primary Goal: ${brief.primaryGoal}` : ""}
${brief.differentiators ? `Differentiators: ${brief.differentiators}` : ""}
${brief.brandColors ? `Brand Colors: ${brief.brandColors} — var(--color-primary) is set to match this. Use it prominently throughout the design.` : ""}
${brief.logoUrl ? `Logo URL: ${brief.logoUrl} — REQUIRED: place this in the <header> as <img src="${brief.logoUrl}" alt="${brief.businessName}" class="site-logo h-8 w-auto"> wrapped in <a href="/">. Do NOT use text as the logo — always use the actual image.` : `Logo: No logo provided — use the business name as text in the header.`}
${constraintsBlock}${designIntentBlock}
## CSS Custom Properties (Theme Variables)
These variables are defined on :root and MUST be used for all colors and fonts:

Core colors:
- var(--color-primary)    — primary brand color (backgrounds, borders, headings on light bg)
- var(--color-on-primary) — text to use ONLY on a background that is the primary color itself (bg-[var(--color-primary)]). Auto-computed to contrast with primary. Do NOT use it on black/grey/gradient/image backgrounds — it can be dark.
- var(--color-on-dark)    — ALWAYS-LIGHT text for any DARK, gradient, or image background. Use THIS (never on-primary) for text on dark sections so it can never be dark-on-dark.
- var(--color-on-dark-muted) — secondary/muted light text on a dark/gradient/image background.
- var(--color-accent)     — accent / call-to-action color (buttons, highlights)
- var(--color-bg)         — page background color
- var(--color-text)       — main body text color FOR LIGHT BACKGROUNDS ONLY
- var(--color-text-muted) — secondary text FOR LIGHT BACKGROUNDS ONLY

Typography:
- var(--font-heading)   — heading font family
- var(--font-body)      — body font family

IMPORTANT: Only use the variable names listed above. Do NOT invent other variable names like --color-background, --color-secondary, --color-surface, etc.

${colorTokens ? `Active color tokens on this site: ${colorTokens}` : ""}
${fontTokens ? `Active font tokens: ${fontTokens}` : ""}

When using these in Tailwind's arbitrary value syntax, wrap them like: text-[color:var(--color-primary)] or bg-[var(--color-bg)]. For inline styles use style="color: var(--color-primary)".

CONTRAST RULES — violations make text invisible and will break the design:
- On a LIGHT background (bg-[var(--color-bg)] or white): use var(--color-text) for body, var(--color-text-muted) for secondary. NEVER use text-gray-100, text-gray-200, text-white, or any near-white class.
- On a DARK / gradient / image background — this means ANY of: bg-black, bg-gray-900, bg-gray-800, bg-neutral-900, bg-zinc-900, bg-slate-900, bg-slate-800, a CSS gradient (linear-gradient/radial-gradient), a background-image / photo overlay, or ANY inline style with a dark hex color (#000, #0a0a0a, #111, #1a1a1a, #222, #333, or similar) — ALL text sitting directly in that section MUST use var(--color-on-dark) for primary text and var(--color-on-dark-muted) for secondary/eyebrow text: headings, subheadings, body, labels, captions — everything. NEVER use var(--color-text), var(--color-text-muted), or var(--color-on-primary) directly on a dark/gradient/image background — they can be dark-colored and will be invisible.
- On a background that IS the primary color (bg-[var(--color-primary)]): use var(--color-on-primary) for text — it is computed to contrast with primary. This is the ONLY place var(--color-on-primary) is correct.
- CARD RULE: White or light-colored cards, panels, or testimonial boxes inside a dark section have their OWN light background. Text inside those cards MUST use var(--color-text) for headings/body and var(--color-text-muted) for secondary text — NOT var(--color-on-primary). var(--color-on-primary) on white cards makes text invisible. Apply this to testimonial cards, feature cards, pricing cards, and any other light box within a dark section.
- BUTTON TEXT RULE: Every button MUST have clearly visible text.
  - Filled buttons (accent/primary background): ALWAYS use text-white.
  - Outline/ghost buttons (transparent background with a border): on dark sections use text-white and border-white; on light sections use var(--color-text) and a visible border. NEVER leave an outline button with no text color set — browsers inherit the parent color, which may be invisible.
  - After writing each button, mentally verify: "Is this text visible against the button's own background color?" Fix it if not.
- On the accent color (bg-[var(--color-accent)] or any button with accent background): use text-white ALWAYS. Never use var(--color-text), var(--color-text-muted), or var(--color-on-primary) on an accent-colored button or element.
- Section labels / eyebrow text (e.g. "THE PROBLEM", "FEATURE 01"): use var(--color-on-dark-muted) on dark/gradient/image sections, var(--color-on-primary) on primary-colored sections, var(--color-text-muted) on light sections — never lighter than these.
- EVERY element that uses var(--color-on-dark)/var(--color-on-dark-muted) for text MUST be inside a section (or element) whose OWN background is dark/gradient/image — not just a parent's. Light cards inside a dark section have their own light background, so their text uses var(--color-text)/var(--color-text-muted) (see CARD RULE).
- OPACITY RULE: Never set opacity below 0.7 on any text element. Reduced opacity on dark-background sections makes text effectively invisible. Use full opacity (no opacity property) unless the value is 0.7 or higher.

## Required HTML Structure
Your output MUST use this exact top-level structure — the platform splits it to build the site:

\`\`\`
<header>
  <!-- NAV BAR ONLY: logo/site name + navigation links. Nothing else. -->
  <!-- DO NOT put the hero, headline, or any page content here. -->
</header>
<main>
  <section><!-- HERO: the first section with the main headline, subtext, and CTA --></section>
  <section><!-- content section 2 --></section>
  <section><!-- content section 3, etc. --></section>
</main>
<footer>
  <!-- Site footer: brand name, nav links, copyright -->
</footer>
\`\`\`

The <header> is a persistent site nav bar — it appears on every page. Keep it compact (one row). The <footer> MUST always be present — omitting it is an error.

CRITICAL HEADER RULE: The div or element that wraps the navigation links (the <a> tags for page links, NOT the logo) MUST have the attribute data-cadmus-nav="links". Example: <div class="flex items-center gap-8" data-cadmus-nav="links">. This is required for the nav to be wired up at runtime.

NAVIGATION DROPDOWNS (one level only): Most sites don't need dropdown menus — only add them if the brief specifically mentions many pages that benefit from grouping. If used, implement as a CSS <details>/<summary> dropdown: <details class="cadmus-dropdown"><summary class="[nav-link-classes]">Label <svg class="cadmus-dropdown-caret" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg></summary><ul class="cadmus-dropdown-menu"><li><a href="/path">Child</a></li></ul></details>. The platform injects the .cadmus-dropdown CSS automatically.

CRITICAL STRUCTURE RULE: Every direct child of <main> MUST be a <section> element. NEVER place raw <div>, <article>, or other elements as direct children of <main>. All content — including app mockups, card grids, feature rows, checklist items, testimonials — must be grouped inside a <section>. The platform splits <main> at section boundaries; orphaned divs become invisible broken blocks.

${brief.pages && brief.pages.length > 1
  ? `CRITICAL FOOTER RULE: This site has multiple pages — footer and header navigation MUST use root-relative page URLs, NOT anchor links. Available pages: ${brief.pages.map((p) => `/${p.slug === "home" ? "" : p.slug} (${p.type})`).join(", ")}. Use these exact paths for every navigation link in both header and footer. NEVER use #section-name anchors — they are broken links on every page except the homepage.`
  : `FOOTER RULE: This is a single-page site — you may use #section-name anchor links for in-page navigation in both the header and footer.`}

## Design Rules
Any ABSOLUTE USER CONSTRAINTS listed above take precedence over every rule in this section. Beyond those:
1. Use Tailwind utility classes for ALL layout, spacing, and typography.
2. Use CSS variable references (NOT hardcoded hex values) for every color and font.
3. Every section must have a clear purpose and strong heading hierarchy (h1 → h2 → h3).
4. Every page needs at least one prominent CTA button that uses var(--color-accent) as its background.
5. Images: use https://placehold.co/WIDTHxHEIGHT for all placeholder images. EVERY <img> tag MUST include a data-image-prompt attribute — this is non-negotiable and applies even if the client said they will add their own images later. The platform uses these prompts to auto-generate images immediately; the client can always replace them. A missing data-image-prompt means that image slot will never be filled. Write a detailed, specific prompt describing the subject, mood, lighting, style, and context. Example: <img src="https://placehold.co/800x500" data-image-prompt="Serene minimalist home office with a standing desk, warm morning light through tall windows, plants on the shelf" alt="Productive workspace">. Use realistic portrait dimensions (280x560 or 320x620) for phone mockups and landscape (800x450 or 1200x675) for wide images.
6. Produce semantic, accessible HTML (proper landmark elements, alt text, button types).
7. DO NOT include <html>, <head>, or <body> tags.
8. DO NOT include a <script> tag or inline JS.
9. Start with <header>, then <main>, then </main>, then <footer>, then </footer>. The <style> block (if any) goes INSIDE <header> as its first child. Every element opened must be closed.
10. You MAY include ONE <style> block — use it ONLY for @keyframes animation definitions. All other styles must use Tailwind classes.
11. NEVER use opacity-0, opacity-[0], or style="opacity:0" on any content element. Content must be visible without JavaScript.
12. NEVER use position:absolute or position:fixed on content cards, image mockups, or text-containing elements within a section. Use relative layout (flexbox, grid) for all content positioning. Absolute positioning is only for decorative accents (shapes, backgrounds) that have no text and do not overlap other content.
14. TAILWIND v4 OPACITY SYNTAX: Always use the slash modifier for color opacity — e.g. bg-white/5, bg-black/40, border-white/10. NEVER use the old v3 bg-opacity-* or border-opacity-* utility classes — they do not exist in Tailwind v4 and will be silently ignored, leaving elements with full solid backgrounds (which breaks contrast on dark sections).
13. PAGE LENGTH BUDGET: Your entire output must stay under 15,000 tokens. Plan accordingly — aim for 6–8 sections total. Each section should be concise. The page MUST end with a closing </footer> tag. If you are unsure whether you have space for another section, skip it and close the page instead. An incomplete page (missing footer, truncated section) is always worse than a shorter complete page.
15. LAYERING / Z-INDEX: The aesthetic direction invites deliberate overlap (a floating badge, stat card, price tag, or caption layered over an image). When you do this, the overlapping element MUST (a) be a child of the SAME positioned container as the image — not a sibling of it — so it anchors to the image, and (b) carry an explicit z-index HIGHER than the image. Images commonly carry z-10, so the overlay needs z-20 (or higher). An overlay with no z-index, or a lower one, will be painted over and hidden by the image — the exact failure this rule exists to prevent.

CRITICAL — ANIMATIONS: If you define a @keyframes animation in a <style> block, every element that uses it MUST be fully visible by default. Set the final/visible state as the default style on the element — do NOT rely on animation-fill-mode to establish visibility. A broken animation must never make text invisible. Use opacity: 1 and transform: none on elements that animate in, so they render correctly even if the animation fails.

## Aesthetic Direction
You are creating a DISTINCTIVE, MEMORABLE website — not a generic template. Before generating, commit to a clear aesthetic point-of-view appropriate for this business. Pick a direction and execute it with precision:

- **Typography**: Use font-family declarations that feel characterful and intentional. Pair a distinctive display/heading style with a refined body font. NEVER fall back to generic system fonts for headings — use specific named fonts in the --font-heading variable (which the theme provides). Make type sizing bold and hierarchically dramatic.
- **Layout & Composition**: Go beyond standard centered columns. Use asymmetry, overlapping elements, generous negative space, or controlled density. Break the grid deliberately. Use diagonal flows, offset grids, or unexpected section shapes (clip-path, border-radius on sections).
- **Visual Depth**: Create atmosphere. Use gradient backgrounds (css gradients with the theme colors), layered transparencies, dramatic shadows (shadow-2xl, drop-shadow), and decorative borders. A solid white background is rarely the right answer.
- **Motion**: Use Tailwind's transition classes (transition, duration-300, hover:scale-105 etc.) for hover states on buttons and cards. For hero text, you may add a subtle entrance animation via @keyframes — but follow the CRITICAL rule above so content is always visible.
- **Sections**: Each section should have a distinct visual identity — vary background treatments (dark section, light section, accent section) to create visual rhythm.

NEVER produce:
- Generic, interchangeable layouts that could belong to any website
- Purple/indigo gradient heroes on white backgrounds (extremely overused)
- Predictable 3-column feature grids with emoji icons as the only visual interest
- Cookie-cutter designs that lack character specific to this business

The goal: someone should look at this page and immediately feel they're on a REAL, designed website, not an AI-generated template.
${inspirationAnalysis ? `\n## Inspiration Analysis\nUse the following design cues from the client's inspiration images to inform layout and aesthetic choices:\n\n${inspirationAnalysis}` : ""}${constraintsReminder}`;
}

function buildUserPrompt(input: DesignPageInput): string {
  const { pageType, pagePurpose, existingContent, deviceType } = input;

  const lines: string[] = [
    `Generate the HTML layout for a "${pageType}" page.`,
  ];

  if (pagePurpose) {
    lines.push(`Page purpose: ${pagePurpose}`);
  }

  if (deviceType) {
    lines.push(`Primary device target: ${deviceType.toLowerCase()}`);
  }

  if (existingContent) {
    lines.push(
      ``,
      `## Existing Copy (use VERBATIM — do not paraphrase or rewrite)`,
      `The following copy must appear word-for-word in the output:`,
      ``,
      existingContent,
    );
  }

  lines.push(
    ``,
    `IMPORTANT: Keep the page to 6–8 sections. The output must be complete — ending with </footer>. If you are running long, finish the current section and close the page rather than generating more sections.`,
    ``,
    `Output ONLY the raw HTML — no markdown fences, no explanation, no preamble. Start directly with <header>.`,
  );

  return lines.join("\n");
}

function extractHtml(raw: string): string {
  // Strip markdown code fences if Claude wrapped the output
  const fenceMatch = raw.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return raw.trim();
}
