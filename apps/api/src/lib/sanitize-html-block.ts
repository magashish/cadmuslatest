import { parse } from "node-html-parser";

// Sanitizer for design HTML — the raw markup stored in `html` blocks and in
// theme header/footer. Unlike the typed-block rich-text sanitizer (which uses a
// strict tag allowlist), design HTML must preserve arbitrary structural markup,
// inline SVG, Tailwind classes, forms, and embeds. So this is a DENY-list on the
// few constructs that can execute script, while keeping everything else intact:
//
//   - removes <script>/<object>/<embed>/<applet>/<base>/<meta>/<link> subtrees
//   - strips on* event-handler attributes
//   - strips iframe srcdoc (would run script in our origin)
//   - on URL-bearing attributes, ALLOW-lists schemes (http/https/mailto/tel,
//     relative/anchor, and data:image/*) and drops anything else
//     (javascript:, vbscript:, data:text/html, file:, …)
//
// node-html-parser decodes HTML entities for getAttribute(), so entity-encoded
// payloads like `&#106;avascript:` and `java&#9;script:` are caught after we
// strip control/whitespace characters from the decoded value.

const REMOVE_TAGS = ["script", "object", "embed", "applet", "base", "meta", "link"];

// Attributes that carry a URL and could smuggle a javascript: payload.
const URL_ATTRS = ["href", "src", "xlink:href", "action", "formaction", "poster", "background", "cite"];

const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

// Control chars + whitespace; stripped before scheme matching so `java\tscript:`
// and leading-whitespace tricks can't slip past the allowlist.
const CONTROL_WS = /[\u0000-\u0020]+/g;

function isSafeUrl(raw: string): boolean {
  const v = raw.replace(CONTROL_WS, "");
  if (v === "") return true;
  // Relative paths and same-page anchors have no scheme — always safe.
  if (v.startsWith("#") || v.startsWith("/") || v.startsWith(".")) return true;
  const m = v.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) return true; // no scheme component → relative reference
  const scheme = m[1].toLowerCase();
  if (SAFE_SCHEMES.has(scheme)) return true;
  if (scheme === "data") return /^data:image\//i.test(v); // inline images only
  return false;
}

/**
 * Sanitize a design-HTML fragment, removing script-execution vectors while
 * preserving layout markup. Safe to run on already-clean HTML (idempotent).
 */
export function sanitizeHtmlBlock(html: string): string {
  if (!html || typeof html !== "string") return html ?? "";

  let root;
  try {
    root = parse(html);
  } catch {
    // If it won't parse, fail closed: strip the most dangerous bits with a
    // coarse regex rather than storing it raw.
    return html
      .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  }

  for (const tag of REMOVE_TAGS) {
    root.querySelectorAll(tag).forEach((el) => el.remove());
  }

  for (const el of root.querySelectorAll("*")) {
    for (const attr of Object.keys(el.attributes)) {
      const lower = attr.toLowerCase();
      if (lower.startsWith("on")) {
        el.removeAttribute(attr);
        continue;
      }
      if (lower === "srcdoc") {
        el.removeAttribute(attr);
        continue;
      }
      if (URL_ATTRS.includes(lower)) {
        const val = el.getAttribute(attr);
        if (val && !isSafeUrl(val)) el.removeAttribute(attr);
      }
    }
  }

  return root.toString();
}

// SVG can execute script when loaded as a top-level document (direct navigation
// to the file URL or via <iframe>/<object>) — and our media bucket is public, so
// an uploaded .svg is reachable directly. Strip the script-bearing constructs:
//   - <script> / <foreignObject> (the latter embeds arbitrary HTML)
//   - on* handlers, javascript: in href/xlink:href
//   - animation elements that animate href to a javascript: payload
const SVG_REMOVE_TAGS = new Set([...REMOVE_TAGS, "foreignobject"]);
const SVG_ANIM_TAGS = new Set(["animate", "set", "animatetransform", "animatemotion"]);

export function sanitizeSvg(svg: string): string {
  if (!svg || typeof svg !== "string") return svg ?? "";

  let root;
  try {
    root = parse(svg);
  } catch {
    return ""; // fail closed: an SVG we can't parse is not worth serving
  }

  for (const el of root.querySelectorAll("*")) {
    const tag = (el.rawTagName || "").toLowerCase();
    if (SVG_REMOVE_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    if (SVG_ANIM_TAGS.has(tag)) {
      const target = (el.getAttribute("attributeName") || "").toLowerCase();
      if (target === "href" || target === "xlink:href") {
        el.remove();
        continue;
      }
    }
    for (const attr of Object.keys(el.attributes)) {
      const lower = attr.toLowerCase();
      if (lower.startsWith("on")) {
        el.removeAttribute(attr);
        continue;
      }
      if (URL_ATTRS.includes(lower)) {
        const val = el.getAttribute(attr);
        if (val && !isSafeUrl(val)) el.removeAttribute(attr);
      }
    }
  }

  return root.toString();
}
