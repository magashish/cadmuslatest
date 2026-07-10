import type { HtmlBlockEditableField } from "../types/design.js";

export interface NavItem {
  label: string;
  url: string;
  children?: { label: string; url: string }[];
}

export interface SocialLink {
  platform: string;
  url: string;
  iconHtml?: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// Tiny entity decoder — covers the cases that actually show up in extracted
// headlines/body copy. The AI extractor returns decoded plaintext, so the
// stored field value won't include `&amp;` etc., while the raw HTML will.
const decodeBasicEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

const innerTextEquals = (innerHtml: string, fieldValue: string): boolean => {
  const stripped = innerHtml.replace(/<[^>]*>/g, "");
  return norm(decodeBasicEntities(stripped)) === norm(decodeBasicEntities(fieldValue));
};

// User-controlled values (editable field values, nav labels/urls, site name)
// are interpolated into HTML that's rendered via set:html. Escape them so they
// can't break out of their context and inject script.
const escapeHtml = (s: string): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, "&quot;");
// For href/src: drop dangerous URL schemes (javascript:, vbscript:, data:
// non-image), then attribute-escape. Relative/anchor URLs pass through.
const safeUrlAttr = (url: string): string => {
  const v = String(url ?? "").replace(/[\u0000-\u0020]+/g, "");
  const scheme = v.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    const ok = s === "http" || s === "https" || s === "mailto" || s === "tel" || (s === "data" && /^data:image\//i.test(v));
    if (!ok) return "#";
  }
  return escapeAttr(url);
};

/**
 * Replace content in HTML elements marked with data-cadmus-field attributes
 * with the stored editable field values.
 */
export function applyEditableFields(
  html: string,
  fields?: Record<string, HtmlBlockEditableField>,
): string {
  if (!fields || Object.keys(fields).length === 0) return html;

  let result = html;
  for (const [fieldId, field] of Object.entries(fields)) {
    const attrPattern = `data-cadmus-field="${fieldId}"`;

    if (result.includes(attrPattern)) {
      if (field.type === "image") {
        const imgRegex = new RegExp(
          `(<[^>]*${attrPattern}[^>]*\\ssrc=")([^"]*)(")`,
          "i",
        );
        result = result.replace(imgRegex, (_m, g1, _g2, g3) => `${g1}${escapeAttr(field.value)}${g3}`);
      } else if (field.type === "link") {
        const tagNameMatch = result.match(new RegExp(`<(\\w+)[^>]*${attrPattern}`));
        if (tagNameMatch) {
          const tagName = tagNameMatch[1];
          if (tagName === "a") {
            const hrefRegex = new RegExp(
              `(<a[^>]*${attrPattern}[^>]*\\shref=")([^"]*)(")`,
              "i",
            );
            result = result.replace(hrefRegex, (_m, g1, _g2, g3) => `${g1}${safeUrlAttr(field.value)}${g3}`);
          } else if (field.value && field.value !== "#") {
            const btnRegex = new RegExp(
              `(<${tagName}[^>]*${attrPattern}[^>]*>[\\s\\S]*?<\\/${tagName}>)`,
              "i",
            );
            result = result.replace(btnRegex, (_m, g1) => `<a href="${safeUrlAttr(field.value)}">${g1}</a>`);
          }
        }
      } else {
        const tagNameMatch = result.match(new RegExp(`<(\\w+)[^>]*${attrPattern}`));
        if (tagNameMatch) {
          const tagName = tagNameMatch[1];
          const tagRegex = new RegExp(
            `(<${tagName}[^>]*${attrPattern}[^>]*>)([\\s\\S]*?)(<\\/${tagName}>)`,
            "i",
          );
          // Preserve inline markup (e.g. <span class="text-primary">) until
          // the field is actually edited. If the stored value still matches the
          // original stripped text, leave the inner HTML intact.
          result = result.replace(tagRegex, (m, g1, g2, g3) =>
            innerTextEquals(g2, field.value) ? m : `${g1}${escapeHtml(field.value)}${g3}`,
          );
        }
      }
    } else if (field.type !== "image" && field.type !== "link") {
      // Fallback: marker missing (older blocks). Match by text content.
      const normalizedValue = norm(field.value);
      const tagPattern = /<(h[1-6]|p|span|a|button|li)(\s[^>]*)?>([^]*?)<\/\1>/gi;
      let match;
      while ((match = tagPattern.exec(result)) !== null) {
        const tagName = match[1];
        const attrs = match[2] || "";
        const innerContent = match[3];
        if (attrs.includes("data-cadmus-field")) continue;
        if (norm(innerContent.replace(/<[^>]*>/g, "")) === normalizedValue) {
          const original = match[0];
          const replaced = `<${tagName}${attrs} data-cadmus-field="${fieldId}">${escapeHtml(field.value)}</${tagName}>`;
          result = result.replace(original, replaced);
          break;
        }
      }
    }
  }

  return result;
}

// Regex identifying the header nav-links container that gets replaced with
// real nav items. Matches the Stitch pattern: a <div> OR <nav> with
// `hidden md:flex` or `md:flex` classes. Stitch sometimes wraps the link
// list in a <div>, sometimes directly in a <nav> — both must be wired.
export const STITCH_HEADER_NAV_CONTAINER_RE =
  /(<(?:div|nav)[^>]*class="[^"]*(?:hidden\s+md:flex|md:flex)[^"]*"[^>]*>)([\s\S]*?)(<\/(?:div|nav)>)/i;

// Regex identifying Claude-generated header nav containers, which use a
// data-cadmus-nav="links" attribute instead of the Stitch md:flex pattern.
export const CLAUDE_HEADER_NAV_CONTAINER_RE =
  /(<(?:div|nav|ul)[^>]*\bdata-cadmus-nav="links"[^>]*>)([\s\S]*?)(<\/(?:div|nav|ul)>)/i;

// Regex identifying a Stitch search "button" — a leaf <div> containing a
// material-symbols search icon span. No nested divs allowed inside the match.
const buildStitchHeaderSearchRe = (): RegExp =>
  /<div([^>]*)>((?:(?!<\/?div\b)[\s\S])*?<span[^>]*material-symbols-outlined[^>]*>\s*search\s*<\/span>(?:(?!<\/?div\b)[\s\S])*?)<\/div>/gi;

// Regex identifying the footer Navigation column.
export const STITCH_FOOTER_NAV_COLUMN_RE =
  /(<div[^>]*class="[^"]*flex[^"]*flex-col[^"]*space-y[^"]*"[^>]*>)\s*<span[^>]*>[^<]*Navigation[^<]*<\/span>([\s\S]*?)(<\/div>)/i;

// Regex identifying a footer social icon row (flex container with icons/SVGs).
export const STITCH_FOOTER_SOCIAL_CONTAINER_RE =
  /(<div[^>]*class="[^"]*flex[^"]*(?:gap|space-x)[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/i;

// Inline SVG icons for common social platforms (24×24 viewBox, currentColor fill).
const SOCIAL_ICONS: Record<string, string> = {
  facebook: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
  instagram: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`,
  twitter: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.845L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  x: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.845L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  linkedin: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
  youtube: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.495 6.205a3.007 3.007 0 00-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 00.527 6.205a31.247 31.247 0 00-.522 5.805 31.247 31.247 0 00.522 5.783 3.007 3.007 0 002.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 002.088-2.088 31.247 31.247 0 00.5-5.783 31.247 31.247 0 00-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`,
  tiktok: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>`,
  pinterest: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>`,
};

export function buildSocialLinksRow(links: SocialLink[]): string {
  const items = links
    .map((link) => {
      const icon = link.iconHtml || SOCIAL_ICONS[link.platform.toLowerCase()] || escapeHtml(link.platform);
      return `<a href="${safeUrlAttr(link.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(link.platform)}" style="display:inline-flex;opacity:0.65;transition:opacity 0.2s" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.65'">${icon}</a>`;
    })
    .join("\n");
  return `<div style="display:flex;gap:1rem;align-items:center;justify-content:center">${items}</div>`;
}

/**
 * Wrap brand content (logo img or wordmark text) in a link to the homepage.
 * If the outer tag is already an <a>, update its href to "/" instead of
 * nesting anchors.
 */
function wrapBrandInHomeLink(
  openTag: string,
  closeTag: string,
  brandInner: string,
  siteName: string,
): string {
  if (/^<a\b/i.test(openTag)) {
    const withHref = /\shref\s*=/i.test(openTag)
      ? openTag.replace(/(\shref\s*=\s*")[^"]*(")/i, `$1/$2`)
      : openTag.replace(/^<a/i, `<a href="/"`);
    return `${withHref}${brandInner}${closeTag}`;
  }
  return `${openTag}<a href="/" aria-label="${escapeAttr(siteName)}" style="color:inherit;text-decoration:none;display:inline-flex;align-items:center;">${brandInner}</a>${closeTag}`;
}

/**
 * Wire real navigation items into a Stitch-designed header.
 * Replaces placeholder links with actual nav items while preserving the design.
 */
export function applyNavToStitchHeader(
  headerHtml: string,
  navItems: NavItem[],
  siteName: string,
  currentPath: string,
  logoUrl?: string,
  navConfigured = false,
): string {
  let result = headerHtml;

  // Stitch sometimes generates `<nav class="fixed top-0 ...">` for the header,
  // which pulls it out of document flow and causes body content to render
  // behind it. Swap `fixed` → `sticky` on the first nav/header element so it
  // sticks during scroll while still occupying space in the layout.
  // Also add `relative` so the absolute-positioned mobile menu panel anchors
  // to the header instead of the viewport.
  result = result.replace(
    /^(\s*<(?:nav|header)[^>]*\sclass=")([^"]*)(")/i,
    (_m, pre: string, classes: string, post: string) => {
      let next = classes.replace(/(?<![\w-])fixed(?![\w-])/g, "sticky");
      if (!next.split(/\s+/).includes("relative")) next = `${next} relative`;
      return `${pre}${next}${post}`;
    },
  );

  const brandRegex = /(<(?:div|a|span)[^>]*class="[^"]*(?:font-bold|font-black|tracking-tighter)[^"]*"[^>]*>)([^<]*(?:<[^>]*>[^<]*)*?)(<\/(?:div|a|span)>)/i;

  // Find the brand image in the header. Try in order:
  //   1. <img> with class/alt/src containing "logo" or "brand" (Stitch is asked
  //      to use class="site-logo", but it doesn't always comply)
  //   2. The first <img> in the header (Stitch typically puts the brand image
  //      at the top of the navbar, so the first img is almost always the logo)
  // If we find a candidate, swap its src to the user's logoUrl. Otherwise fall
  // back to text-branding replacement.
  const taggedImgMatch = logoUrl
    ? result.match(/<img[^>]*(?:class|alt|src)="[^"]*(?:logo|brand)[^"]*"[^>]*\/?>/i)
    : null;
  const firstImgMatch = logoUrl && !taggedImgMatch
    ? result.match(/<img[^>]*src="[^"]*"[^>]*\/?>/i)
    : null;
  const brandImgMatch = taggedImgMatch ?? firstImgMatch;

  if (logoUrl && brandImgMatch) {
    const oldImg = brandImgMatch[0];
    const newImg = oldImg.replace(/src="[^"]*"/i, `src="${logoUrl}"`);
    result = result.replace(oldImg, newImg);
    const newImgIdx = result.indexOf(newImg);
    const before = result.slice(Math.max(0, newImgIdx - 200), newImgIdx);
    const alreadyLinked = /<a\b[^>]*>\s*$/i.test(before);
    if (!alreadyLinked) {
      result = result.replace(
        newImg,
        `<a href="/" aria-label="${escapeAttr(siteName)}">${newImg}</a>`,
      );
    }
  } else {
    const brandInner = logoUrl
      ? `<img src="${logoUrl}" alt="${escapeAttr(siteName)}" style="height:40px;width:auto;" />`
      : escapeHtml(siteName);
    result = result.replace(brandRegex, (_m, openTag: string, _content: string, closeTag: string) =>
      wrapBrandInHomeLink(openTag, closeTag, brandInner, siteName),
    );
  }

  result = result.replace(buildStitchHeaderSearchRe(), (_m, attrs: string, inner: string) =>
    `<a href="/search"${attrs} style="text-decoration:none;color:inherit;">${inner}</a>`,
  );

  if (navItems.length > 0 || navConfigured) {
    const navRe = result.match(CLAUDE_HEADER_NAV_CONTAINER_RE)
      ? CLAUDE_HEADER_NAV_CONTAINER_RE
      : STITCH_HEADER_NAV_CONTAINER_RE;
    const match = result.match(navRe);
    if (match) {
      if (navItems.length === 0) {
        result = result.replace(navRe, (_m, g1, _g2, g3) => `${g1}${g3}`);
      } else {
      const allLinkClasses = [...match[2].matchAll(/<a[^>]*class="([^"]*)"[^>]*>/g)].map(
        (m) => m[1],
      );
      const firstClass = allLinkClasses[0] || "";
      const secondClass = allLinkClasses.length > 1 ? allLinkClasses[1] : "";

      const activeLinkClass =
        firstClass || "text-slate-900 font-bold border-b-2 border-slate-900 pb-1";
      const baseLinkClass =
        secondClass ||
        firstClass
          .replace(/font-bold\s*/g, "")
          .replace(/border-b-2\s+border-\S+\s*/g, "")
          .trim() ||
        "text-slate-600 hover:text-slate-900 transition-colors";

      // Preserve the inline style (colour, font) the designer set on the
      // template's links. Rebuilding from the class alone dropped it, leaving
      // links colourless so they inherited the wrong colour — e.g. light text
      // on a light header bar.
      const allLinkStyles = [...match[2].matchAll(/<a[^>]*\sstyle="([^"]*)"[^>]*>/g)].map((m) => m[1]);
      const activeLinkStyle = allLinkStyles[0] ?? "";
      const baseLinkStyle = allLinkStyles[1] ?? allLinkStyles[0] ?? "";
      const styleAttr = (s: string) => (s ? ` style="${s}"` : "");

      const caretSvg = `<svg class="cadmus-dropdown-caret" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>`;

      const hasDropdowns = navItems.some((item) => item.children && item.children.length > 0);

      const dropdownStyles = hasDropdowns
        ? `<style>.cadmus-dropdown{position:relative;list-style:none}.cadmus-dropdown>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:0.25rem}.cadmus-dropdown>summary::-webkit-details-marker{display:none}.cadmus-dropdown-caret{width:0.75rem;height:0.75rem;transition:transform 0.2s}.cadmus-dropdown[open] .cadmus-dropdown-caret{transform:rotate(180deg)}.cadmus-dropdown-menu{position:absolute;top:100%;left:0;z-index:50;min-width:10rem;background:white;border:1px solid #e5e7eb;border-radius:0.375rem;box-shadow:0 4px 12px rgba(0,0,0,0.1);padding:0.25rem;list-style:none;margin:0}.cadmus-dropdown-menu li{list-style:none}.cadmus-dropdown-menu a{display:block;padding:0.5rem 0.75rem;border-radius:0.25rem;text-decoration:none;white-space:nowrap;color:#1a1a1a}.cadmus-dropdown-menu a:hover{background:#f3f4f6}</style>`
        : "";

      const newLinks = navItems
        .map((item) => {
          const isActive = currentPath === item.url;
          const cls = isActive ? activeLinkClass : baseLinkClass;
          const stl = isActive ? activeLinkStyle : baseLinkStyle;
          if (item.children && item.children.length > 0) {
            const childLinks = item.children
              .map((child) => `<li><a href="${safeUrlAttr(child.url)}" class="${baseLinkClass}"${styleAttr(baseLinkStyle)}>${escapeHtml(child.label)}</a></li>`)
              .join("\n");
            const summaryContent = item.url
              ? `<a class="${cls}"${styleAttr(stl)} href="${safeUrlAttr(item.url)}" onclick="event.stopPropagation()">${escapeHtml(item.label)}</a>${caretSvg}`
              : `${escapeHtml(item.label)}${caretSvg}`;
            return `<details class="cadmus-dropdown"><summary class="${cls}"${styleAttr(stl)}>${summaryContent}</summary><ul class="cadmus-dropdown-menu">${childLinks}</ul></details>`;
          }
          return `<a class="${cls}"${styleAttr(stl)} href="${safeUrlAttr(item.url)}">${escapeHtml(item.label)}</a>`;
        })
        .join("\n");

      // The hamburger icon (stroke=currentColor) must match the nav links'
      // colour — inheriting left it the wrong colour (e.g. light on a light bar).
      const navColor =
        baseLinkStyle.match(/color:\s*([^;]+)/i)?.[1]?.trim() ||
        activeLinkStyle.match(/color:\s*([^;]+)/i)?.[1]?.trim();
      const hamburgerColor = navColor ? `color:${navColor};` : "color:inherit;";

      // Hamburger button + styles — visible on mobile only, sits alongside the hidden
      // desktop nav. Uses inline styles + an injected <style> block instead of Tailwind
      // responsive classes (md:hidden) because those classes may not be compiled into the
      // site's Tailwind bundle if Stitch didn't use them in the generated HTML.
      // The panel anchors to its NAV-BAR ancestor (see injection below); a
      // position:fixed nav bar is itself the positioning context, while a static
      // bar falls back to the position:relative header.
      const hamburger = `${dropdownStyles}<style>header{position:relative}#cadmus-menu-btn{display:none}#cadmus-menu{display:none;position:absolute;left:0;right:0;top:100%;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.1);border-top:1px solid #f1f5f9;flex-direction:column;z-index:50}#cadmus-menu.cadmus-menu-open{display:flex}@media(max-width:767px){#cadmus-menu-btn{display:flex}header a[href="/"]{flex-shrink:1;min-width:0;max-width:calc(100% - 88px);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}header a[href="/"] img{max-height:28px;height:28px;width:auto}}</style><button id="cadmus-menu-btn" style="align-items:center;justify-content:center;padding:4px;background:none;border:none;cursor:pointer;${hamburgerColor}" aria-label="Toggle navigation menu" aria-expanded="false" onclick="(function(b){var m=document.getElementById('cadmus-menu');var open=m.classList.toggle('cadmus-menu-open');b.setAttribute('aria-expanded',open?'true':'false')})(this)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>`;

      // Mobile nav panel — absolutely positioned below the header, toggled by hamburger.
      // Uses inline styles to avoid dependency on compiled Tailwind classes.
      const mobileLinks = navItems
        .flatMap((item) => {
          const isActive = currentPath === item.url;
          const style = isActive
            ? "display:block;padding:12px 16px;color:#0f172a;font-weight:600;background:#f8fafc;border-bottom:1px solid #f1f5f9;text-decoration:none;"
            : "display:block;padding:12px 16px;color:#334155;border-bottom:1px solid #f1f5f9;text-decoration:none;";
          const parentLink = item.url
            ? `<a style="${style}" href="${safeUrlAttr(item.url)}">${escapeHtml(item.label)}</a>`
            : `<span style="display:block;padding:12px 16px;color:#334155;border-bottom:1px solid #f1f5f9;font-weight:600;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(item.label)}</span>`;
          const childLinks = (item.children ?? []).map(
            (child) =>
              `<a style="display:block;padding:10px 16px 10px 28px;color:#475569;border-bottom:1px solid #f1f5f9;text-decoration:none;" href="${safeUrlAttr(child.url)}">${escapeHtml(child.label)}</a>`,
          );
          return [parentLink, ...childLinks];
        })
        .join("\n");
      const mobilePanel = `<div id="cadmus-menu">\n${mobileLinks}\n</div>`;

      // Inject links + hamburger + the mobile panel together so the panel sits
      // INSIDE the nav bar (a sibling of the links container), not in the outer
      // <header>. Its top:100% then anchors to the bar itself — including a
      // position:fixed bar, where the <header> collapses to zero height and the
      // panel would otherwise render at the top, overlapping the nav.
      result = result.replace(
        navRe,
        (_m, g1, _g2, g3) => `${g1}${newLinks}${g3}${hamburger}${mobilePanel}`,
      );
      }
    }
  }

  return result;
}

/**
 * Wire real navigation items and social links into a Stitch-designed footer.
 */
export function applyNavToStitchFooter(
  footerHtml: string,
  navItems: NavItem[],
  siteName: string,
  year: number,
  socialLinks?: SocialLink[],
  logoUrl?: string,
): string {
  let result = footerHtml;

  // Text-only wordmark match. When there's no logo we keep this stricter form
  // so a multi-span (e.g. two-colour) wordmark is left exactly as the designer
  // built it — only a plain-text brand gets its text swapped for the site name.
  const footerBrandRegex =
    /(<(?:div|a|span)[^>]*class="[^"]*(?:font-black|font-bold)[^"]*"[^>]*>)([^<]+)(<\/(?:div|a|span)>)/i;
  // When a logo IS set we need to replace the whole brand — including wordmarks
  // split across nested spans — with the image, so the footer matches the
  // header (which already swaps in the logo). Mirrors the header's brand regex.
  const footerBrandRegexNested =
    /(<(?:div|a|span)[^>]*class="[^"]*(?:font-black|font-bold)[^"]*"[^>]*>)([^<]*(?:<[^>]*>[^<]*)*?)(<\/(?:div|a|span)>)/i;
  const brandInner = logoUrl
    ? `<img src="${logoUrl}" alt="${escapeAttr(siteName)}" style="height:32px;width:auto;" />`
    : escapeHtml(siteName);
  result = result.replace(
    logoUrl ? footerBrandRegexNested : footerBrandRegex,
    (_m, openTag: string, _content: string, closeTag: string) =>
      wrapBrandInHomeLink(openTag, closeTag, brandInner, siteName),
  );

  result = result.replace(/©\s*\d{4}/, `© ${year}`);

  if (navItems.length > 0) {
    const match = result.match(STITCH_FOOTER_NAV_COLUMN_RE);
    if (match) {
      const linkClassMatch = match[2].match(/<a[^>]*class="([^"]*)"/);
      const linkClass = linkClassMatch?.[1] || "text-slate-500 hover:text-slate-900 transition-colors";

      const hasDropdowns = navItems.some((item) => item.children && item.children.length > 0);
      const caretSvg = `<svg class="cadmus-dropdown-caret" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>`;

      const dropdownStyles = hasDropdowns
        ? `<style>.cadmus-dropdown{position:relative;list-style:none}.cadmus-dropdown>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:0.25rem}.cadmus-dropdown>summary::-webkit-details-marker{display:none}.cadmus-dropdown-caret{width:0.75rem;height:0.75rem;transition:transform 0.2s}.cadmus-dropdown[open] .cadmus-dropdown-caret{transform:rotate(180deg)}.cadmus-dropdown-menu{position:absolute;bottom:100%;left:0;z-index:50;min-width:10rem;background:white;border:1px solid #e5e7eb;border-radius:0.375rem;box-shadow:0 4px 12px rgba(0,0,0,0.1);padding:0.25rem;list-style:none;margin:0}.cadmus-dropdown-menu li{list-style:none}.cadmus-dropdown-menu a{display:block;padding:0.5rem 0.75rem;border-radius:0.25rem;text-decoration:none;white-space:nowrap;color:#1a1a1a}.cadmus-dropdown-menu a:hover{background:#f3f4f6}</style>`
        : "";

      const newLinks = navItems
        .map((item) => {
          if (item.children && item.children.length > 0) {
            const childLinks = item.children
              .map((child) => `<li><a href="${safeUrlAttr(child.url)}" class="${linkClass}">${escapeHtml(child.label)}</a></li>`)
              .join("\n");
            const summaryContent = item.url
              ? `<a class="${linkClass}" href="${safeUrlAttr(item.url)}" onclick="event.stopPropagation()">${escapeHtml(item.label)}</a>${caretSvg}`
              : `${escapeHtml(item.label)}${caretSvg}`;
            return `${dropdownStyles}<details class="cadmus-dropdown"><summary class="${linkClass}">${summaryContent}</summary><ul class="cadmus-dropdown-menu">${childLinks}</ul></details>`;
          }
          return `<a class="${linkClass}" href="${safeUrlAttr(item.url)}">${escapeHtml(item.label)}</a>`;
        })
        .join("\n");

      result = result.replace(
        STITCH_FOOTER_NAV_COLUMN_RE,
        (_m, g1, _g2, g3) =>
          `${g1}<span class="font-sans Manrope text-sm font-bold uppercase tracking-widest text-slate-900 dark:text-slate-50 mb-2">Navigation</span>\n${newLinks}${g3}`,
      );
    }
  }

  if (socialLinks && socialLinks.length > 0) {
    const socialMatch = result.match(STITCH_FOOTER_SOCIAL_CONTAINER_RE);
    if (socialMatch) {
      const hasIcons =
        socialMatch[2].includes("<svg") || socialMatch[2].includes("material-symbols");
      if (hasIcons) {
        const socialLinkClassMatch = socialMatch[2].match(/<a[^>]*class="([^"]*)"/);
        const socialLinkClass =
          socialLinkClassMatch?.[1] || "text-slate-400 hover:text-slate-600 transition-colors";

        const newSocialLinks = socialLinks
          .map((link) => {
            const icon = link.iconHtml || escapeHtml(link.platform);
            return `<a class="${socialLinkClass}" href="${safeUrlAttr(link.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(link.platform)}">${icon}</a>`;
          })
          .join("\n");

        result = result.replace(
          STITCH_FOOTER_SOCIAL_CONTAINER_RE,
          (_m, g1, _g2, g3) => `${g1}${newSocialLinks}${g3}`,
        );
      }
    }
  }

  return result;
}

/**
 * Create field map entries for any data-cadmus-field markers in HTML that
 * don't already have a matching entry. Lets the editor surface fields whose
 * markers were injected (e.g. by Stitch import or a manual HTML edit) but
 * never reached the fields map — common with header/search placeholders.
 *
 * Returns the original map untouched if no orphan markers were found.
 */
export function backfillFieldsFromMarkers(
  html: string,
  fields: Record<string, HtmlBlockEditableField>,
): Record<string, HtmlBlockEditableField> {
  const markerRe = /data-cadmus-field="([^"]+)"/g;
  const seenIds = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(html)) !== null) {
    seenIds.add(m[1]);
  }

  const orphanIds = [...seenIds].filter((id) => !fields[id]);
  if (orphanIds.length === 0) return fields;

  const next = { ...fields };
  for (const id of orphanIds) {
    const tagMatch = html.match(
      new RegExp(`<(\\w+)([^>]*?)\\sdata-cadmus-field="${id}"([^>]*)>`, "i"),
    );
    if (!tagMatch) continue;
    const tagName = tagMatch[1].toLowerCase();
    const allAttrs = `${tagMatch[2]} ${tagMatch[3]}`;

    let type: HtmlBlockEditableField["type"] = "text";
    let value = "";

    if (tagName === "img") {
      type = "image";
      value = allAttrs.match(/\bsrc="([^"]*)"/)?.[1] ?? "";
    } else if ((tagName === "a" || tagName === "button") && id.endsWith("-link")) {
      type = "link";
      value = allAttrs.match(/\bhref="([^"]*)"/)?.[1] ?? "";
    } else {
      const innerRe = new RegExp(
        `<${tagName}[^>]*data-cadmus-field="${id}"[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
        "i",
      );
      const innerMatch = html.match(innerRe);
      value = innerMatch ? innerMatch[1].replace(/<[^>]*>/g, "").trim() : "";
    }

    next[id] = {
      selector: `[data-cadmus-field="${id}"]`,
      type,
      value,
      label: id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    };
  }

  return next;
}

/**
 * Generate CSS custom property declarations from a SiteTheme colors object.
 */
export function buildStitchCssVars(colors: Record<string, string>): string {
  return Object.entries(colors)
    .map(([key, value]) => `--stitch-${key}: ${value};`)
    .join("\n  ");
}
