import sanitizeHtml from "sanitize-html";

// Rich text: TextSection body, FAQ answer, Map hours. Allows formatting,
// lists, links, headings, blockquotes. No scripts, no iframes, no style
// attributes, no event handlers.
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "span", "strong", "em", "b", "i", "u", "s", "mark", "small",
    "sub", "sup", "code", "pre", "blockquote",
    "ul", "ol", "li",
    "h2", "h3", "h4", "h5", "h6",
    "a", "hr",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    "*": ["class"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesAppliedToAttributes: ["href"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
  },
};

// Embeds: YouTube, Vimeo, Twitter/X, Instagram, Spotify, etc. Allowlist of
// iframe hosts chosen for common embed providers; anything else becomes text.
const EMBED_IFRAME_HOSTS = new Set([
  "www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com",
  "player.vimeo.com",
  "www.tiktok.com", "tiktok.com",
  "open.spotify.com",
  "w.soundcloud.com",
  "platform.twitter.com",
  "www.instagram.com", "instagram.com",
  "www.google.com", "maps.google.com",
  "calendar.google.com",
]);

const EMBED_OPTIONS: sanitizeHtml.IOptions = {
  ...RICH_TEXT_OPTIONS,
  allowedTags: [...((RICH_TEXT_OPTIONS.allowedTags || []) as string[]), "iframe", "img"],
  allowedAttributes: {
    ...RICH_TEXT_OPTIONS.allowedAttributes,
    iframe: [
      "src", "title", "width", "height", "frameborder", "allow",
      "allowfullscreen", "loading", "referrerpolicy",
    ],
    img: ["src", "alt", "width", "height", "loading"],
  },
  allowedIframeHostnames: Array.from(EMBED_IFRAME_HOSTS),
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
  },
};

export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html ?? "", RICH_TEXT_OPTIONS);
}

export function sanitizeEmbed(html: string): string {
  return sanitizeHtml(html ?? "", EMBED_OPTIONS);
}
