import { parse as parseHtml } from "node-html-parser";
import type { AIRouter } from "../router.js";
import type { HtmlBlock, HtmlBlockEditableField, SiteTheme, FontSizeToken } from "@cadmus/shared";
import {
  STITCH_HEADER_NAV_CONTAINER_RE,
  CLAUDE_HEADER_NAV_CONTAINER_RE,
  STITCH_FOOTER_NAV_COLUMN_RE,
  STITCH_FOOTER_SOCIAL_CONTAINER_RE,
} from "@cadmus/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HtmlToHtmlBlocksOptions {
  html: string;
  pageType?: string;
  screenId?: string;
}

export interface HtmlToHtmlBlocksResult {
  blocks: HtmlBlock[];
  themeDelta: Partial<SiteTheme>;
  model: string;
  usedFallback: boolean;
}

// ---------------------------------------------------------------------------
// Editable field extraction prompt
// ---------------------------------------------------------------------------

const FIELD_EXTRACTION_PROMPT = `You are a content extraction assistant. Given an HTML section from a website design, identify the user-editable content elements.

For each editable element, return a JSON object with:
- "id": unique kebab-case identifier (e.g., "hero-headline", "mission-body")
- "type": one of "text", "richtext", "image", "link"
- "value": the current text content, image src URL, or link href
- "label": human-readable label for an editor UI (e.g., "Hero Headline", "CTA Button Text")

Rules:
1. Focus on: headings (h1-h6), paragraphs, button/link text, image src+alt, anchor hrefs
2. Ignore: icons (material-symbols), decorative elements, structural wrappers, CSS classes
3. For images, set type="image" and value=the src URL
4. For <a> tags and CTA <button> elements with meaningful text, create TWO fields:
   - One "text" field for the display text (e.g., id "cta-button-text", value="Get Started")
   - One "link" field for the destination URL (e.g., id "cta-button-link", value=the href for <a> tags, or "#" for <button> elements)
   - Use the same ID prefix for both (e.g., "cta-button-text" and "cta-button-link")
   - EXCEPTION: submit buttons inside a <form> (a <button> or <input type="submit"> within form tags) trigger the form, not navigation — create ONLY the "text" field for their label, never a "link" field
5. For non-link text elements (headings, paragraphs, list items), set type="text" and value=the text content
6. Search-bar placeholder text (e.g. "Search...", "Search Archive...") inside header search controls IS editable — extract it as a "text" field with id "nav-search-placeholder". The icon next to it is still ignored.
7. Return ONLY a valid JSON array. No markdown fences, no explanation.
8. Keep IDs unique within the section — prefix with a section-relevant word`;

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

export async function convertHtmlToHtmlBlocks(
  router: AIRouter,
  options: HtmlToHtmlBlocksOptions,
): Promise<HtmlToHtmlBlocksResult> {
  const { html, pageType } = options;

  // Step 1: Parse and extract metadata
  const themeDelta = extractThemeFromHtml(html);
  const sections = splitIntoSections(html);

  // The theme delta represents *site-shell* state — header/footer HTML, body
  // classes, colors, font families, font sizes, border radius, fonts, custom
  // CSS, material symbols. All of that comes from the home page. Other page
  // types (post, about, services, etc.) re-emit the same Stitch tokens (since
  // every screen in a Stitch project shares one design system), but they may
  // also drift — e.g. a Ballot Info screen using `bg-background` while the
  // homepage uses `bg-surface`. If we let those non-home extractions merge in,
  // they clobber the homepage's authoritative theme. Drop the entire delta on
  // non-home imports so the homepage extraction stays canonical.
  //
  // Accept both conventions: onboarding + AI tool calls use "homepage"; the
  // slug-based caller in ai.ts passes "home".
  const isHomePage = pageType === "home" || pageType === "homepage";
  // Page-level custom CSS (e.g. .project-overlay hover rules) must survive even
  // on non-home pages. We don't let it merge into the site theme (that would
  // clobber the homepage's canonical theme), so we capture it here and inject
  // it as a <style> tag into the first section's HTML instead.
  const pageCustomCss = !isHomePage ? (themeDelta.customCss ?? "") : "";
  if (!isHomePage) {
    delete themeDelta.headerHtml;
    delete themeDelta.footerHtml;
    delete themeDelta.bodyClasses;
    delete themeDelta.customCss;
    delete themeDelta.colors;
    delete themeDelta.fontFamilies;
    delete themeDelta.fontSizes;
    delete themeDelta.borderRadius;
    delete themeDelta.fonts;
    delete themeDelta.materialSymbols;
  }

  // Step 2: Extract editable fields for each section via AI
  const blocks: HtmlBlock[] = [];
  let lastModel = "unknown";
  let usedFallback = false;
  let pageCustomCssInjected = false;

  for (const section of sections) {
    // Stitch sometimes emits newsletter signups as a bare <input type="email">
    // + button without a wrapping <form>. Wrap them so the rest of the pipeline
    // (form detection, formId assignment, runtime submit handler) works.
    section.html = wrapOrphanEmailInputs(section.html);

    // Inject page-level custom CSS into the first block so hover/animation
    // rules (e.g. .project-overlay transitions) survive the theme stripping.
    if (pageCustomCss && !pageCustomCssInjected) {
      section.html = `<style>${pageCustomCss}</style>\n${section.html}`;
      pageCustomCssInjected = true;
    }

    const fields = await extractEditableFields(router, section.html);
    lastModel = fields.model;
    usedFallback = usedFallback || fields.usedFallback;

    // Inject data-cadmus-field attributes into the HTML
    let markedHtml = injectFieldMarkers(section.html, fields.fields);

    const hasForm = /<form[\s>]/i.test(section.html);
    let formSettings: { name: string } | undefined;
    if (hasForm) {
      formSettings = { name: deriveFormName(section.html, section.name) };
      // Assign semantic `name` attrs to form inputs. Stitch forms typically only
      // set placeholders (often with example VALUES like "Alexander Hamilton"),
      // so without this the admin Forms page and notification emails would show
      // placeholder text as if it were the field label.
      const named = await assignFormFieldNames(router, markedHtml);
      markedHtml = named.html;
      lastModel = named.model;
      usedFallback = usedFallback || named.usedFallback;
    }

    blocks.push({
      blockType: "html",
      variant: "stitch",
      data: {
        html: markedHtml,
        editableFields: fields.fields,
        sectionName: section.name,
        ...(formSettings ? { formSettings } : {}),
      },
    });
  }

  // Step 3: Extract editable fields for header/footer so they're editable in
  // the theme editor alongside page content. Strip nav-link fields because
  // those elements get replaced at render time by applyNavToStitch{Header,Footer}
  // from the navigation table — editing them would be dead-code from the UI.
  if (themeDelta.headerHtml) {
    const headerResult = await extractFieldsFromHtml(router, themeDelta.headerHtml);
    const stripped = stripNavFields(headerResult.markedHtml, headerResult.fields, "header");
    themeDelta.headerHtml = stripped.html;
    themeDelta.headerEditableFields = stripped.fields;
    lastModel = headerResult.model;
    usedFallback = usedFallback || headerResult.usedFallback;
  }
  if (themeDelta.footerHtml) {
    const footerResult = await extractFieldsFromHtml(router, themeDelta.footerHtml);
    const stripped = stripNavFields(footerResult.markedHtml, footerResult.fields, "footer");
    themeDelta.footerHtml = stripped.html;
    themeDelta.footerEditableFields = stripped.fields;
    lastModel = footerResult.model;
    usedFallback = usedFallback || footerResult.usedFallback;
  }

  return {
    blocks,
    themeDelta,
    model: lastModel,
    usedFallback,
  };
}

/**
 * Remove editable fields whose markers sit inside regions that are overwritten
 * by the render-time nav/social wiring. Strips the data-cadmus-field attribute
 * from the HTML too so the two stay consistent.
 *
 * Call on header/footer HTML after extraction — nav-link and footer-social
 * fields are dead from the UI because applyNavToStitch{Header,Footer} replaces
 * those regions with data from the navigation table at render time.
 */
export function stripNavFields(
  html: string,
  fields: Record<string, HtmlBlockEditableField>,
  scope: "header" | "footer",
): { html: string; fields: Record<string, HtmlBlockEditableField> } {
  const regions: Array<[RegExp, number]> = [];
  if (scope === "header") {
    regions.push([STITCH_HEADER_NAV_CONTAINER_RE, 2]);
    regions.push([CLAUDE_HEADER_NAV_CONTAINER_RE, 2]);
  } else {
    regions.push([STITCH_FOOTER_NAV_COLUMN_RE, 2]);
    const socialMatch = html.match(STITCH_FOOTER_SOCIAL_CONTAINER_RE);
    if (socialMatch && (socialMatch[2].includes("<svg") || socialMatch[2].includes("material-symbols"))) {
      regions.push([STITCH_FOOTER_SOCIAL_CONTAINER_RE, 2]);
    }
  }

  const fieldIdsToDrop = new Set<string>();
  for (const [re, captureIndex] of regions) {
    const match = html.match(re);
    if (!match) continue;
    const inner = match[captureIndex];
    const markerRe = /data-cadmus-field="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(inner)) !== null) {
      fieldIdsToDrop.add(m[1]);
    }
  }

  if (fieldIdsToDrop.size === 0) return { html, fields };

  let cleanedHtml = html;
  const cleanedFields: Record<string, HtmlBlockEditableField> = {};
  for (const [id, field] of Object.entries(fields)) {
    if (fieldIdsToDrop.has(id)) {
      cleanedHtml = cleanedHtml.replace(new RegExp(`\\s*data-cadmus-field="${id}"`, "g"), "");
    } else {
      cleanedFields[id] = field;
    }
  }

  return { html: cleanedHtml, fields: cleanedFields };
}

/**
 * Run AI field extraction on an HTML fragment and return the marked-up HTML
 * plus the fields map. Used both during Stitch import and for on-demand
 * extraction of existing header/footer HTML.
 */
export async function extractFieldsFromHtml(
  router: AIRouter,
  html: string,
): Promise<{
  markedHtml: string;
  fields: Record<string, HtmlBlockEditableField>;
  model: string;
  usedFallback: boolean;
}> {
  const extracted = await extractEditableFields(router, html);
  const markedHtml = injectFieldMarkers(html, extracted.fields);
  return {
    markedHtml,
    fields: extracted.fields,
    model: extracted.model,
    usedFallback: extracted.usedFallback,
  };
}

// ---------------------------------------------------------------------------
// Extract theme tokens from a generated HTML document's <head>.
// Today this understands the Stitch convention (tailwind.config script +
// Google Fonts links + Material Symbols link + <style> blocks + header/footer).
// Other PageDesigner adapters can inject their own embeddings before parsing
// or compose their own extractor.
// ---------------------------------------------------------------------------

function normalizeFontSize(raw: unknown): FontSizeToken | null {
  if (typeof raw === "string") return { size: raw };
  if (Array.isArray(raw)) {
    const [size, meta] = raw;
    if (typeof size !== "string") return null;
    const token: FontSizeToken = { size };
    if (meta && typeof meta === "object") {
      const m = meta as Record<string, unknown>;
      if (typeof m.lineHeight === "string") token.lineHeight = m.lineHeight;
      if (typeof m.letterSpacing === "string") token.letterSpacing = m.letterSpacing;
      if (typeof m.fontWeight === "string") token.fontWeight = m.fontWeight;
      else if (typeof m.fontWeight === "number") token.fontWeight = String(m.fontWeight);
    }
    return token;
  }
  return null;
}

function extractThemeFromHtml(html: string): Partial<SiteTheme> {
  const root = parseHtml(html);

  // Extract Tailwind config from <script id="tailwind-config">
  let colors: Record<string, string> = {};
  let fontFamilies: Record<string, string[]> = {};
  let fontSizes: Record<string, FontSizeToken> = {};
  let borderRadius: Record<string, string> = {};
  let spacing: Record<string, string> = {};

  const configScript = root.querySelector('script#tailwind-config') ||
    root.querySelectorAll('script').find((s) =>
      s.text.includes('tailwind.config')
    );

  if (configScript) {
    const configText = configScript.text;
    try {
      // Parse the full tailwind.config object as JS to reliably extract nested properties.
      // The old regex approach broke on quoted property names (e.g. "colors": {...}).
      const configObjMatch = configText.match(/tailwind\.config\s*=\s*(\{[\s\S]*\})/);
      if (configObjMatch) {
        const config = new Function(`return (${configObjMatch[1]})`)() as Record<string, unknown>;
        const extend = (config as any)?.theme?.extend ?? {};
        if (extend.colors && typeof extend.colors === "object") {
          colors = extend.colors as Record<string, string>;
        }
        if (extend.fontFamily && typeof extend.fontFamily === "object") {
          fontFamilies = extend.fontFamily as Record<string, string[]>;
        }
        if (extend.fontSize && typeof extend.fontSize === "object") {
          for (const [name, raw] of Object.entries(extend.fontSize as Record<string, unknown>)) {
            const token = normalizeFontSize(raw);
            if (token) fontSizes[name] = token;
          }
        }
        if (extend.borderRadius && typeof extend.borderRadius === "object") {
          borderRadius = extend.borderRadius as Record<string, string>;
        }
        if (extend.spacing && typeof extend.spacing === "object") {
          spacing = extend.spacing as Record<string, string>;
        }
      }
    } catch (err) {
      console.warn("Failed to parse Stitch Tailwind config:", err);
    }
  }

  // Extract Google Fonts links
  const fonts: string[] = [];
  root.querySelectorAll('link[href*="fonts.googleapis.com/css"]').forEach((link) => {
    const href = link.getAttribute("href");
    if (href) fonts.push(href);
  });

  // Detect Material Symbols
  const materialSymbols = root.querySelectorAll('link[href*="Material+Symbols"]').length > 0;

  // Extract custom <style> content (non-Tailwind)
  let customCss = "";
  root.querySelectorAll("style").forEach((style) => {
    if (!style.getAttribute("id")?.includes("tailwind")) {
      customCss += style.text + "\n";
    }
  });

  // Extract body/html classes (e.g. "bg-surface text-on-surface selection:bg-primary-container")
  const bodyEl = root.querySelector("body");
  const bodyClasses = bodyEl?.getAttribute("class") || "";
  const htmlEl = root.querySelector("html");
  const htmlClasses = htmlEl?.getAttribute("class") || "";
  const combinedBodyClasses = [htmlClasses, bodyClasses].filter(Boolean).join(" ").trim();

  // Extract arbitrary hex colors from class attributes and promote them into
  // the Tailwind config so they're compiled as named tokens rather than lost.
  // Matches bg-[#fff], text-[#abc123], border-[#RRGGBB], etc.
  const arbitraryHexRe = /\b(?:bg|text|border|ring|decoration|shadow|fill|stroke|outline|accent|caret|divide)-\[#([0-9A-Fa-f]{3,8})\]/g;
  const allClassAttrs = html.match(/class\s*=\s*["'][^"']*["']/g) ?? [];
  for (const attr of allClassAttrs) {
    let m: RegExpExecArray | null;
    while ((m = arbitraryHexRe.exec(attr)) !== null) {
      const hex = m[1].toLowerCase();
      const tokenName = `extracted-${hex}`;
      if (!colors[tokenName]) {
        colors[tokenName] = `#${hex}`;
        console.log(`extractThemeFromHtml: promoted arbitrary color #${hex} → ${tokenName}`);
      }
    }
  }

  // Extract header and footer HTML.
  // Try <header> first; if missing, auto-wrap the top-level <nav> so downstream
  // code always gets a <header> element rather than a bare <nav>.
  let headerHtml: string | undefined;
  const headerEl = root.querySelector("header");
  if (headerEl) {
    headerHtml = headerEl.outerHTML;
  } else {
    const topNav = root.querySelector("body > nav");
    if (topNav) {
      console.warn("extractThemeFromHtml: no <header> found — wrapping top-level <nav> as <header>");
      headerHtml = `<header>${topNav.outerHTML}</header>`;
    } else {
      console.warn("extractThemeFromHtml: no <header> or top-level <nav> found");
    }
  }

  const footer = root.querySelector("footer");
  if (!footer) {
    console.warn("extractThemeFromHtml: no <footer> found — top-level tags:", root.childNodes.map((n) => (n as { rawTagName?: string }).rawTagName ?? "#text").filter(Boolean).join(", "));
  }

  return {
    colors,
    fonts,
    fontFamilies,
    fontSizes: Object.keys(fontSizes).length > 0 ? fontSizes : undefined,
    borderRadius,
    spacing: Object.keys(spacing).length > 0 ? spacing : undefined,
    customCss: customCss.trim(),
    materialSymbols,
    headerHtml,
    footerHtml: footer?.outerHTML?.replace(/©\s*\d{4}/g, `© ${new Date().getFullYear()}`),
    bodyClasses: combinedBodyClasses || undefined,
  };
}

// ---------------------------------------------------------------------------
// Split <main> content into top-level <section> elements.
// HTML comments provide naming; <section> tags are the structural boundary.
// ---------------------------------------------------------------------------

interface SectionChunk {
  name: string;
  html: string;
}

function splitIntoSections(html: string): SectionChunk[] {
  // Use node-html-parser to locate <main> — more reliable than a regex on
  // arbitrary Claude output (which may include <style> blocks, comments, etc.
  // that trip up greedy/non-greedy regex matching).
  const root = parseHtml(html);
  const mainEl = root.querySelector("main");

  if (!mainEl) {
    // No <main>: walk the body and strip top-level header/footer/nav before
    // sectioning. Top-level <nav> matters: Stitch sometimes emits a sticky
    // top nav AND a fixed-bottom mobile nav as <nav> siblings of the main
    // content (no <header> wrapper). extractThemeFromHtml's `body > nav`
    // selector promotes the *first* one to themeDelta.headerHtml, but
    // without stripping them here both navs would survive as content blocks
    // (so the rendered page shows a duplicate stretched nav where the hero
    // should be). We only strip *direct* body children — nested <nav> in
    // article TOCs / breadcrumbs stays intact.
    const bodyEl = root.querySelector("body");
    if (!bodyEl) {
      // Bare fragment (no body wrapper) — strip header/footer/nav and section
      // whatever remains. This handles Claude's <header>/<main>/<footer> output
      // when <main> is not found for any reason.
      console.warn("splitIntoSections: no <main> found — first 300 chars:", html.slice(0, 300));
      return [];
    }
    for (const child of [...bodyEl.childNodes]) {
      const tag = (child as { rawTagName?: string }).rawTagName?.toLowerCase();
      if (tag === "header" || tag === "footer" || tag === "nav") {
        bodyEl.removeChild(child);
      }
    }
    return splitMainContent(bodyEl.innerHTML, "", "");
  }

  const mainClass = mainEl.getAttribute("class") ?? "";
  const split = mainClass ? splitMainClasses(mainClass) : { container: "", bottomOffset: "" };
  return splitMainContent(mainEl.innerHTML, split.container, split.bottomOffset);
}

/**
 * Split a <main> classlist into per-block container classes and a
 * bottom-offset that should only apply to the last block.
 *
 * - container (per-block): width constraint + horizontal padding. These wrap
 *   *every* extracted block so they render correctly without the original
 *   parent. Vertical padding/margin is intentionally NOT in this set, because
 *   it would stack between every block.
 * - bottomOffset (last-block only): pb-/mb- classes (and the bottom half of
 *   py-/my-, rewritten to pb-/mb-). Stitch uses `<main class="... pb-20">` to
 *   add a gap before the footer; applying it per-block would balloon spacing,
 *   not applying it at all collapses the last section into the footer.
 * - top-offset (pt-/mt-/py-/my-) is intentionally **dropped**. Stitch sets
 *   `<main class="pt-20">` to clear a *fixed* nav, but every Stitch nav we've
 *   seen is `position: sticky`, which already takes its own space in flow.
 *   Re-applying `pt-20` adds an empty 80px gap above the hero. If a fixed-nav
 *   case appears later, key the offset off the header position instead.
 */
function splitMainClasses(classList: string): { container: string; bottomOffset: string } {
  const tokens = classList.split(/\s+/).filter(Boolean);
  const container: string[] = [];
  const bottomOffset: string[] = [];
  for (const t of tokens) {
    // Pull the responsive/state prefix off so we can match the bare utility,
    // but keep the prefix when we re-emit (e.g. `md:pb-20` stays `md:pb-20`).
    const prefixMatch = t.match(/^([a-z][a-z0-9:-]*:)?(.*)$/);
    const prefix = prefixMatch?.[1] ?? "";
    const bare = prefixMatch?.[2] ?? t;
    if (
      bare.startsWith("max-w-") ||
      bare === "mx-auto" ||
      bare === "container" ||
      bare.startsWith("px-") ||
      bare.startsWith("pl-") ||
      bare.startsWith("pr-") ||
      bare.startsWith("ps-") ||
      bare.startsWith("pe-") ||
      (bare.startsWith("p-") && /^p-\d/.test(bare))
    ) {
      container.push(t);
    } else if (bare.startsWith("pb-") || bare.startsWith("mb-")) {
      bottomOffset.push(t);
    } else if (bare.startsWith("py-")) {
      bottomOffset.push(`${prefix}pb-${bare.slice(3)}`);
    } else if (bare.startsWith("my-")) {
      bottomOffset.push(`${prefix}mb-${bare.slice(3)}`);
    }
    // pt-/mt- (and the top half of py-/my-) intentionally dropped.
  }
  return { container: container.join(" "), bottomOffset: bottomOffset.join(" ") };
}

function splitMainContent(
  mainHtml: string,
  containerClasses: string,
  bottomOffsetClasses: string,
): SectionChunk[] {
  // Walk direct children of <main>. Each top-level element becomes a block —
  // <section>, <header>, <aside>, <div>, etc. This preserves layout
  // structure that Stitch sometimes uses: a hero <header>, a search/filter
  // <div>, a grid wrapper containing nested sections + a sidebar <aside>.
  // An earlier version extracted only <section> tags and silently dropped
  // everything else (sidebars in particular), which broke pages whose
  // layout wasn't a flat stack of sections.
  const root = parseHtml(`<main>${mainHtml}</main>`, { comment: true });
  const main = root.querySelector("main");
  if (!main) return [];

  const sections: SectionChunk[] = [];
  let pendingName = "";

  for (const child of main.childNodes) {
    const tagName = (child as { rawTagName?: string }).rawTagName;
    const nodeType = (child as { nodeType?: number }).nodeType;

    // Comment node — capture its text to name the next sibling element.
    // node-html-parser uses nodeType 8 for comments when comment:true is set.
    if (nodeType === 8) {
      const raw = child.toString();
      const m = raw.match(/<!--\s*([\s\S]*?)\s*-->/);
      if (m) pendingName = m[1].trim();
      continue;
    }

    // Skip text nodes — only structural element children become blocks.
    if (!tagName) continue;
    const html = child.toString();
    if (!html.trim()) continue;

    const name = pendingName || defaultNameForTag(tagName);
    pendingName = "";

    // Every block gets the container constraint (width + horizontal padding).
    // The bottom offset (pb-20 etc.) is added later, only to the last block.
    const wrapperClasses = containerClasses;
    const wrappedHtml = wrapperClasses
      ? `<div class="${wrapperClasses}">${html}</div>`
      : html;
    sections.push({ name, html: wrappedHtml });
  }

  // Fallback: nothing structural found, treat the whole main as one block.
  if (sections.length === 0 && mainHtml.trim()) {
    const wrapperClasses = containerClasses;
    const fallback = wrapperClasses
      ? `<div class="${wrapperClasses}">${mainHtml.trim()}</div>`
      : mainHtml.trim();
    sections.push({ name: "Section", html: fallback });
  }

  // Apply the bottom offset to the last block only, so the page has a gap
  // before the footer matching the original <main class="... pb-20">.
  if (bottomOffsetClasses && sections.length > 0) {
    const last = sections[sections.length - 1];
    last.html = `<div class="${bottomOffsetClasses}">${last.html}</div>`;
  }

  return sections;
}

function defaultNameForTag(tag: string): string {
  switch (tag.toLowerCase()) {
    case "header": return "Hero";
    case "aside": return "Sidebar";
    case "section": return "Section";
    case "div": return "Section";
    default: return "Section";
  }
}

// ---------------------------------------------------------------------------
// Wrap orphan email-capture patterns (input[type=email] + nearby button, no
// enclosing <form>) in a <form> so form detection, formId assignment, and the
// runtime submit handler all pick them up. Stitch frequently emits newsletter
// signups this way on hero / footer-CTA sections.
// ---------------------------------------------------------------------------

export function wrapOrphanEmailInputs(html: string): string {
  if (!/<input[^>]*type\s*=\s*["']?email/i.test(html)) return html;

  const root = parseHtml(html);
  const inputs = root.querySelectorAll('input[type="email"], input[type=email]');
  let mutated = false;

  for (const input of inputs) {
    // Skip if already inside a form
    let inForm = false;
    for (let p = input.parentNode; p; p = p.parentNode) {
      if ((p as { rawTagName?: string }).rawTagName?.toLowerCase() === "form") {
        inForm = true;
        break;
      }
    }
    if (inForm) continue;

    // Walk up looking for the smallest ancestor that ALSO contains a button.
    // That ancestor is the natural form boundary — typically a flex container.
    let target: typeof input | null = input.parentNode as typeof input | null;
    let formBoundary: typeof input | null = null;
    while (target && (target as { rawTagName?: string }).rawTagName) {
      const hasButton =
        (target as { querySelector: (sel: string) => unknown }).querySelector("button") ||
        (target as { querySelector: (sel: string) => unknown }).querySelector('input[type="submit"]');
      if (hasButton) {
        formBoundary = target;
        break;
      }
      target = target.parentNode as typeof input | null;
    }

    // No nearby button: wrap just the input's parent (allow Enter-to-submit).
    if (!formBoundary) {
      formBoundary = input.parentNode as typeof input | null;
    }
    if (!formBoundary || !(formBoundary as { rawTagName?: string }).rawTagName) continue;

    // Rename the boundary element's tag to <form>, preserving classes/attrs.
    // node-html-parser exposes rawTagName as a writable string.
    const el = formBoundary as unknown as { rawTagName: string };
    if (el.rawTagName.toLowerCase() === "form") continue;
    el.rawTagName = "form";
    mutated = true;
  }

  return mutated ? root.toString() : html;
}

// ---------------------------------------------------------------------------
// Assign semantic `name` attributes to form inputs that lack them. Stitch
// forms typically have only `placeholder` (often an example value), so without
// a `name` FormData keys fall back to placeholder text — which looks like the
// field label is the example value. The AI infers the field purpose from the
// input type, placeholder, and surrounding copy, then we inject the name.
// ---------------------------------------------------------------------------

const FORM_FIELD_NAMING_PROMPT = `You are labeling form inputs. Given a section of HTML that contains a <form>, return a JSON array of { "index": number, "name": string } entries — one per form input in document order.

Rules:
- Index is zero-based over the form's <input>, <textarea>, and <select> elements (skip hidden inputs and submit buttons).
- Infer each input's purpose from its type attribute, placeholder, and nearby copy. Placeholders may contain EXAMPLE VALUES (e.g. "Alexander Hamilton") — treat them as hints about the field's purpose, not as labels.
- Use snake_case names. Prefer standard ones where applicable: full_name, first_name, last_name, email, phone, company, website, subject, message, comments.
- If a semantic name can't be inferred, use field_1, field_2, etc.
- Return ONLY a valid JSON array, no markdown fences, no explanation.`;

export async function assignFormFieldNames(
  router: AIRouter,
  html: string,
): Promise<{ html: string; model: string; usedFallback: boolean }> {
  const root = parseHtml(html);
  const form = root.querySelector("form");
  if (!form) return { html, model: "none", usedFallback: false };

  const inputs = form.querySelectorAll("input, textarea, select").filter((el) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    return type !== "hidden" && type !== "submit" && type !== "button";
  });
  if (inputs.length === 0) return { html, model: "none", usedFallback: false };

  const result = await router.generateText({
    task: "copywriting",
    systemPrompt: FORM_FIELD_NAMING_PROMPT,
    prompt: `Name the form inputs in this HTML:\n\n${html}`,
    temperature: 0.1,
    maxTokens: 512,
  });

  const used = new Set<string>();
  try {
    let jsonText = result.text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry.index !== "number" || typeof entry.name !== "string") continue;
        const input = inputs[entry.index];
        if (!input) continue;
        if (input.getAttribute("name")) continue;
        let name = entry.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
        if (!name) continue;
        // Deduplicate: if the AI returns the same name twice, suffix with an index.
        let unique = name;
        let suffix = 2;
        while (used.has(unique)) unique = `${name}_${suffix++}`;
        used.add(unique);
        input.setAttribute("name", unique);
      }
    }
  } catch {
    console.warn("Failed to parse form field names from AI response");
  }

  // Fallback: any still-unnamed inputs get field_N by position.
  inputs.forEach((input, i) => {
    if (input.getAttribute("name")) return;
    let name = `field_${i + 1}`;
    let suffix = 2;
    while (used.has(name)) name = `field_${i + 1}_${suffix++}`;
    used.add(name);
    input.setAttribute("name", name);
  });

  return { html: root.toString(), model: result.model, usedFallback: result.usedFallback };
}

// ---------------------------------------------------------------------------
// Derive a human-friendly form name from a section that contains a <form>.
// Tries nearest heading → section name → content-based classification.
// ---------------------------------------------------------------------------

export function deriveFormName(sectionHtml: string, sectionName?: string): string {
  const root = parseHtml(sectionHtml);
  const form = root.querySelector("form");
  const scope = form?.parentNode ?? root;

  const headingEl = scope.querySelector("h1, h2, h3, h4");
  const headingText = headingEl?.text.replace(/\s+/g, " ").trim();
  if (headingText && headingText.length > 2 && headingText.length <= 60) {
    return headingText;
  }

  if (sectionName && sectionName.toLowerCase() !== "section") {
    return /form|signup/i.test(sectionName) ? sectionName : `${sectionName} Form`;
  }

  // Fallback: classify from field types
  const inputs = form?.querySelectorAll("input, textarea, select") ?? [];
  const types = new Set(inputs.map((el) => (el.getAttribute("type") || el.rawTagName || "").toLowerCase()));
  if (inputs.length <= 2 && types.has("email")) return "Newsletter Signup";
  if (types.has("textarea")) return "Contact Form";
  return "Form";
}

// ---------------------------------------------------------------------------
// Extract editable fields via AI
// ---------------------------------------------------------------------------

interface FieldExtractionResult {
  fields: Record<string, HtmlBlockEditableField>;
  model: string;
  usedFallback: boolean;
}

export async function extractEditableFields(
  router: AIRouter,
  sectionHtml: string,
): Promise<FieldExtractionResult> {
  const result = await router.generateText({
    task: "copywriting",
    systemPrompt: FIELD_EXTRACTION_PROMPT,
    prompt: `Extract editable fields from this HTML section:\n\n${sectionHtml}`,
    temperature: 0.1,
    maxTokens: 2048,
  });

  const fields: Record<string, HtmlBlockEditableField> = {};

  try {
    let jsonText = result.text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      for (const field of parsed) {
        if (field && typeof field.id === "string" && typeof field.type === "string") {
          fields[field.id] = {
            selector: `[data-cadmus-field="${field.id}"]`,
            type: field.type,
            value: field.value ?? "",
            label: field.label ?? field.id,
          };
        }
      }
    }
  } catch {
    console.warn("Failed to parse editable fields from AI response");
  }

  return {
    fields,
    model: result.model,
    usedFallback: result.usedFallback,
  };
}

// ---------------------------------------------------------------------------
// Inject data-cadmus-field markers into HTML
// ---------------------------------------------------------------------------

export function injectFieldMarkers(
  html: string,
  fields: Record<string, HtmlBlockEditableField>,
): string {
  const root = parseHtml(html);

  // Normalize whitespace for comparison
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  for (const [fieldId, field] of Object.entries(fields)) {
    if (field.type === "image") {
      // Find img with matching src
      const img = root.querySelector(`img[src="${field.value}"]`);
      if (img) {
        img.setAttribute("data-cadmus-field", fieldId);
      }
    } else if (field.type === "link") {
      // For link fields, match <a> by href or <button> elements
      const links = root.querySelectorAll("a, button");
      let matched = false;
      for (const el of links) {
        if (el.getAttribute("data-cadmus-field")) continue;
        const href = el.getAttribute("href");
        if (href && href === field.value) {
          el.setAttribute("data-cadmus-field", fieldId);
          matched = true;
          break;
        }
      }
      // Fallback for buttons with no href: find via paired text field
      if (!matched) {
        const textFieldId = fieldId.replace(/-link$/, "-text");
        const textField = fields[textFieldId];
        if (textField) {
          const normalizedText = norm(textField.value);
          for (const el of links) {
            if (el.getAttribute("data-cadmus-field")) continue;
            if (norm(el.text) === normalizedText && el.rawTagName === "button") {
              el.setAttribute("data-cadmus-field", fieldId);
              break;
            }
          }
        }
      }
    } else {
      // Find elements containing this text — prefer the most specific
      // (deepest) element whose text content matches.
      const allElements = root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, span, a, button, li");
      const normalizedValue = norm(field.value);
      let bestMatch: typeof allElements[number] | null = null;

      for (const el of allElements) {
        if (el.getAttribute("data-cadmus-field")) continue;
        const textContent = norm(el.text);
        if (textContent === normalizedValue) {
          // Prefer the deepest matching element (most specific)
          if (!bestMatch || el.text.length <= bestMatch.text.length) {
            bestMatch = el;
          }
        }
      }

      if (bestMatch) {
        bestMatch.setAttribute("data-cadmus-field", fieldId);
      }
    }
  }

  return root.toString();
}

// ---------------------------------------------------------------------------
// Extract navigation links and social links from footer HTML
// ---------------------------------------------------------------------------

export interface FooterNavItem {
  label: string;
  url: string;
}

export interface FooterSocialLink {
  platform: string;
  url: string;
  iconHtml?: string;
}

export interface FooterData {
  navItems: FooterNavItem[];
  socialLinks: FooterSocialLink[];
}

// Common social media domains → platform names
const SOCIAL_PLATFORMS: Record<string, string> = {
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "twitter.com": "twitter",
  "x.com": "twitter",
  "instagram.com": "instagram",
  "linkedin.com": "linkedin",
  "youtube.com": "youtube",
  "tiktok.com": "tiktok",
  "pinterest.com": "pinterest",
  "github.com": "github",
  "threads.net": "threads",
  "mastodon.social": "mastodon",
};

const SOCIAL_ICON_PATTERNS = [
  // SVG icons or Material Symbols with social platform names
  /facebook|fb/i,
  /twitter|x-twitter/i,
  /instagram/i,
  /linkedin/i,
  /youtube/i,
  /tiktok/i,
  /pinterest/i,
  /github/i,
];

export function extractFooterData(footerHtml: string): FooterData {
  const root = parseHtml(footerHtml);
  const navItems: FooterNavItem[] = [];
  const socialLinks: FooterSocialLink[] = [];
  const seenUrls = new Set<string>();

  const allLinks = root.querySelectorAll("a[href]");

  for (const link of allLinks) {
    const href = link.getAttribute("href") || "";
    if (!href || href.startsWith("#") || seenUrls.has(href)) continue;
    seenUrls.add(href);

    const text = link.text.trim();
    const innerHtml = link.innerHTML.trim();

    // Check if this is a social link (by href domain or icon content)
    const socialPlatform = detectSocialPlatform(href, innerHtml);
    if (socialPlatform) {
      socialLinks.push({
        platform: socialPlatform,
        url: href,
        iconHtml: innerHtml,
      });
      continue;
    }

    // Skip links with no readable text (icon-only non-social links)
    if (!text || text.length < 2) continue;

    // Skip "mailto:" and "tel:" links
    if (href.startsWith("mailto:") || href.startsWith("tel:")) continue;

    navItems.push({ label: text, url: href });
  }

  return { navItems, socialLinks };
}

function detectSocialPlatform(href: string, innerHtml: string): string | null {
  // Check href against known social domains
  try {
    const url = new URL(href, "https://placeholder.com");
    const hostname = url.hostname.replace(/^www\./, "");
    for (const [domain, platform] of Object.entries(SOCIAL_PLATFORMS)) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return platform;
      }
    }
  } catch {
    // Not a valid URL
  }

  // Check inner HTML for social icon patterns (SVGs, icon classes, Material Symbols)
  for (const pattern of SOCIAL_ICON_PATTERNS) {
    if (pattern.test(innerHtml) && innerHtml.includes("<")) {
      // Has markup (likely an icon) and matches a social pattern
      const platformName = innerHtml.match(/facebook|instagram|twitter|linkedin|youtube|tiktok|pinterest|github/i);
      if (platformName) return platformName[0].toLowerCase();
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parse a JS object literal string into a plain object
// ---------------------------------------------------------------------------

function parseJsObject(jsStr: string): Record<string, unknown> {
  // Convert JS object syntax to valid JSON:
  // - Add quotes around unquoted keys
  // - Handle trailing commas
  let json = jsStr
    // Quote unquoted keys (word characters before colon)
    .replace(/([{,]\s*)([a-zA-Z_][\w-]*)\s*:/g, '$1"$2":')
    // Remove trailing commas before } or ]
    .replace(/,\s*([}\]])/g, "$1")
    // Replace single quotes with double quotes
    .replace(/'/g, '"');

  try {
    return JSON.parse(json);
  } catch {
    // Fallback: try eval-like approach with Function (safe since we control the input)
    try {
      return new Function(`return (${jsStr})`)() as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
