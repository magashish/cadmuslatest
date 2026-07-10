import crypto from "node:crypto";
import { eq, and, ne } from "drizzle-orm";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { db, content, contentBlocks, navigation, sites } from "@cadmus/db";
import { STITCH_FOOTER_SOCIAL_CONTAINER_RE } from "@cadmus/shared";

export interface Insight {
  id: string;
  title: string;
  rationale: string;
  page: string | null;
  actionLabel?: string;
  prompt?: string;
}

interface NavItem {
  label?: string;
  url?: string;
}

// A url counts as "unwired" when it's clearly a placeholder. Anything else
// (internal slug, external link, anchor target) is left alone to avoid
// false-positives on things like /blog or /shop that don't map 1:1 to a
// content row.
function isUnwired(url: string | undefined): boolean {
  if (!url) return true;
  const trimmed = url.trim();
  return trimmed === "" || trimmed === "#";
}

function signature(parts: unknown): string {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 10);
}

async function detectUnwiredNav(siteId: string): Promise<Insight[]> {
  const rows = await db
    .select({ location: navigation.location, items: navigation.items })
    .from(navigation)
    .where(eq(navigation.siteId, siteId));

  const results: Insight[] = [];
  for (const row of rows) {
    if (row.location !== "header" && row.location !== "footer") continue;
    const items = (row.items as NavItem[] | null) ?? [];
    const broken = items.filter((i) => isUnwired(i.url));
    if (broken.length === 0) continue;

    const labels = broken.map((b) => b.label || "(untitled)");
    const sig = signature({ location: row.location, labels });
    const placement = row.location === "header" ? "header" : "footer";
    const examples = labels.slice(0, 3).join(", ") + (labels.length > 3 ? "…" : "");

    results.push({
      id: `nav-unwired-${row.location}-${sig}`,
      title: `${labels.length} ${placement} link${labels.length === 1 ? "" : "s"} not connected to a page`,
      rationale: `${examples} ${labels.length === 1 ? "points" : "point"} to "#" or nothing, so visitors clicking ${labels.length === 1 ? "it" : "them"} stay on the same page. Connect ${labels.length === 1 ? "it" : "them"} to real pages or external URLs.`,
      page: "/theme",
      prompt: `My ${placement} has ${labels.length} unwired nav link${labels.length === 1 ? "" : "s"} (${examples}). Connect ${labels.length === 1 ? "it" : "them"} to the right pages — create pages if needed, and ask me before creating anything non-obvious.`,
    });
  }
  return results;
}

async function detectFormsMissingEmail(siteId: string): Promise<Insight[]> {
  const rows = await db
    .select({
      blockId: contentBlocks.id,
      blockType: contentBlocks.blockType,
      data: contentBlocks.data,
      contentId: contentBlocks.contentId,
      schemaData: content.schemaData,
    })
    .from(contentBlocks)
    .innerJoin(content, eq(content.id, contentBlocks.contentId))
    .where(and(eq(content.siteId, siteId), ne(content.status, "archived")));

  const byPage = new Map<string, { contentTitle: string; formNames: string[]; formIds: string[] }>();
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    let formName: string | null = null;
    let formId: string | null = null;

    if (row.blockType === "form") {
      const email = typeof data.notificationEmail === "string" ? data.notificationEmail.trim() : "";
      if (email) continue;
      formName = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Untitled form";
      formId = typeof data.formId === "string" ? data.formId : row.blockId;
    } else if (row.blockType === "html") {
      const html = typeof data.html === "string" ? data.html : "";
      if (!/<form[\s>]/i.test(html)) continue;
      const settings = (data.formSettings as Record<string, unknown> | undefined) ?? {};
      const email = typeof settings.notificationEmail === "string" ? settings.notificationEmail.trim() : "";
      if (email) continue;
      formName = typeof settings.name === "string" && settings.name.trim() ? settings.name.trim() : "Untitled form";
      formId = typeof settings.formId === "string" ? settings.formId : row.blockId;
    }

    if (!formName || !formId) continue;

    const pageTitle = String((row.schemaData as Record<string, unknown> | undefined)?.title || "Untitled page");
    if (!byPage.has(row.contentId)) {
      byPage.set(row.contentId, { contentTitle: pageTitle, formNames: [], formIds: [] });
    }
    const entry = byPage.get(row.contentId)!;
    entry.formNames.push(formName);
    entry.formIds.push(formId);
  }

  if (byPage.size === 0) return [];

  return Array.from(byPage.entries()).map(([contentId, { contentTitle, formNames, formIds }]) => {
    const sig = signature(formIds.sort());
    const examples = formNames.slice(0, 2).join(", ") + (formNames.length > 2 ? "…" : "");
    const count = formNames.length;
    return {
      id: `forms-missing-email-${sig}`,
      title: `${count === 1 ? `"${formNames[0]}"` : `${count} forms`} on "${contentTitle}" missing a notification email`,
      rationale: `${count === 1 ? `The form "${formNames[0]}"` : `${examples}`} on the "${contentTitle}" page ${count === 1 ? "doesn't" : "don't"} have an email set, so submissions only land in the Forms dashboard — nobody gets pinged.`,
      page: `/content/${contentId}`,
      actionLabel: "Edit Page",
      prompt: `The form${count === 1 ? ` "${formNames[0]}"` : `s (${examples})`} on the "${contentTitle}" page don't have a notification email set. Ask me which email to use, then configure ${count === 1 ? "it" : "them"}.`,
    };
  });
}

async function detectMissingMetaDescriptions(siteId: string): Promise<Insight[]> {
  const rows = await db
    .select({
      id: content.id,
      type: content.type,
      slug: content.slug,
      schemaData: content.schemaData,
    })
    .from(content)
    .where(and(eq(content.siteId, siteId), eq(content.status, "published")));

  const offending = rows.filter((r) => {
    if (r.type !== "page" && r.type !== "post") return false;
    const data = (r.schemaData ?? {}) as Record<string, unknown>;
    const meta = typeof data.metaDescription === "string" ? data.metaDescription.trim() : "";
    return !meta;
  });

  if (offending.length === 0) return [];

  const slugs = offending.map((o) => o.slug);
  const sig = signature(offending.map((o) => o.id).sort());
  const examples = slugs.slice(0, 3).join(", ") + (slugs.length > 3 ? "…" : "");

  return [
    {
      id: `content-missing-meta-${sig}`,
      title: `${slugs.length} published page${slugs.length === 1 ? "" : "s"} missing a meta description`,
      rationale: `${examples} ${slugs.length === 1 ? "doesn't" : "don't"} have a meta description, which hurts SEO and the snippet Google shows in search results.`,
      page: "/content",
      prompt: `Write meta descriptions for my published pages that don't have one (${examples}). Keep them under 160 characters and match each page's topic and audience.`,
    },
  ];
}

// A link field on a form's submit button is functional even though it points
// to "#" or nothing — clicking it submits the form. Resolve the field's
// element in the block html (by the data-cadmus-field marker, falling back to
// the paired -text field's label the same way injectFieldMarkers matches) and
// skip it when it's a submit control inside a <form>.
function isFormSubmitField(
  root: HTMLElement,
  fieldId: string,
  fields: Record<string, { type?: string; value?: string; label?: string }>,
): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  let el = root.querySelector(`[data-cadmus-field="${fieldId}"]`);
  if (!el) {
    const textField = fields[fieldId.replace(/-link$/, "-text")];
    if (textField?.value) {
      el =
        root
          .querySelectorAll("button")
          .find((b) => norm(b.text) === norm(textField.value ?? "")) ?? null;
    }
  }
  if (!el) return false;

  const tag = el.rawTagName?.toLowerCase();
  const typeAttr = (el.getAttribute("type") ?? "").toLowerCase();
  const isSubmitControl =
    (tag === "button" && typeAttr !== "button" && typeAttr !== "reset") ||
    (tag === "input" && typeAttr === "submit");
  if (!isSubmitControl) return false;

  // Associated with a form either by ancestry or an explicit form="id" attr.
  if (el.getAttribute("form")) return true;
  let parent = el.parentNode;
  while (parent) {
    if (parent.rawTagName?.toLowerCase() === "form") return true;
    parent = parent.parentNode;
  }
  return false;
}

async function detectUnwiredBodyLinks(siteId: string): Promise<Insight[]> {
  const rows = await db
    .select({
      contentId: content.id,
      slug: content.slug,
      type: content.type,
      data: contentBlocks.data,
    })
    .from(contentBlocks)
    .innerJoin(content, eq(content.id, contentBlocks.contentId))
    .where(and(eq(content.siteId, siteId), ne(content.status, "archived")));

  // Group placeholder link counts by content row so each affected page gets
  // its own actionable insight (deep-linking to the editor).
  const byContent = new Map<string, { slug: string; count: number; labels: string[] }>();
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const fields = (data.editableFields as Record<string, { type?: string; value?: string; label?: string }> | undefined) ?? {};
    const html = typeof data.html === "string" ? data.html : "";
    let root: HTMLElement | null = null;
    for (const [fieldId, f] of Object.entries(fields)) {
      if (f.type !== "link") continue;
      if (!isUnwired(f.value)) continue;
      if (html) {
        root ??= parseHtml(html);
        if (isFormSubmitField(root, fieldId, fields)) continue;
      }
      const entry = byContent.get(row.contentId) ?? { slug: row.slug, count: 0, labels: [] };
      entry.count += 1;
      if (f.label && entry.labels.length < 3) entry.labels.push(f.label);
      byContent.set(row.contentId, entry);
    }
  }

  const results: Insight[] = [];
  for (const [contentId, info] of byContent) {
    const examples = info.labels.length
      ? info.labels.join(", ") + (info.count > info.labels.length ? "…" : "")
      : `${info.count} link${info.count === 1 ? "" : "s"}`;
    const sig = signature({ contentId, count: info.count });
    results.push({
      id: `body-unwired-${contentId}-${sig}`,
      title: `${info.count} placeholder link${info.count === 1 ? "" : "s"} on ${info.slug}`,
      rationale: `${examples} on the ${info.slug} page point to "#" or nothing. Visitors clicking ${info.count === 1 ? "it" : "them"} stay put. Wire ${info.count === 1 ? "it" : "them"} to a real page or external URL.`,
      page: `/content/${contentId}`,
      prompt: `The "${info.slug}" page has ${info.count} placeholder link${info.count === 1 ? "" : "s"} (${examples}). Connect ${info.count === 1 ? "it" : "them"} to the right destination — link to existing pages where they fit, create new pages if I confirm, and ask before guessing.`,
    });
  }
  return results;
}

async function detectUnwiredThemeLinks(siteId: string): Promise<Insight[]> {
  const [siteRow] = await db
    .select({ settings: sites.settings })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!siteRow) return [];

  const settings = (siteRow.settings ?? {}) as Record<string, unknown>;
  const theme = (settings.theme ?? {}) as Record<string, unknown>;

  const results: Insight[] = [];
  for (const placement of ["header", "footer"] as const) {
    const key = placement === "header" ? "headerEditableFields" : "footerEditableFields";
    const fields = (theme[key] as Record<string, { type?: string; value?: string; label?: string }> | undefined) ?? {};
    const broken = Object.values(fields).filter((f) => f.type === "link" && isUnwired(f.value));
    if (broken.length === 0) continue;

    const labels = broken.map((b) => b.label || "(untitled)");
    const sig = signature({ placement, labels });
    const examples = labels.slice(0, 3).join(", ") + (labels.length > 3 ? "…" : "");

    results.push({
      id: `theme-unwired-${placement}-${sig}`,
      title: `${labels.length} placeholder ${placement} link${labels.length === 1 ? "" : "s"}`,
      rationale: `${examples} in your ${placement} ${labels.length === 1 ? "points" : "point"} to "#" or nothing. Visitors clicking ${labels.length === 1 ? "it" : "them"} stay on the same page. Wire ${labels.length === 1 ? "it" : "them"} to a real page or external URL.`,
      page: "/theme",
      prompt: `My ${placement} has ${labels.length} placeholder link${labels.length === 1 ? "" : "s"} (${examples}). Connect ${labels.length === 1 ? "it" : "them"} to the right destination — link to existing pages where they fit, create new pages if I confirm, and ask before guessing.`,
    });
  }
  return results;
}

async function detectMissingOrgInfo(siteId: string): Promise<Insight[]> {
  const [siteRow] = await db
    .select({ settings: sites.settings })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!siteRow) return [];

  const settings = (siteRow.settings ?? {}) as Record<string, unknown>;
  const bi = (settings.businessInfo ?? {}) as Record<string, unknown>;
  const email = typeof bi.contactEmail === "string" ? bi.contactEmail.trim() : "";
  const phone = typeof bi.contactPhone === "string" ? bi.contactPhone.trim() : "";
  if (email || phone) return [];

  return [
    {
      id: "org-missing-contact",
      title: "Business contact info isn't set",
      rationale:
        "No contact email or phone is configured. Cadmus uses these in your site's Organization schema for SEO and structured search results, and they're a quick win for visitor trust.",
      page: "/settings",
      prompt:
        "Help me fill in the Business Info section in Settings. Walk me through which fields matter most for SEO and trust signals, then ask me for the values.",
    },
  ];
}

async function detectMissingFormDefaults(siteId: string): Promise<Insight[]> {
  const [siteRow] = await db
    .select({ settings: sites.settings })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!siteRow) return [];

  const settings = (siteRow.settings ?? {}) as Record<string, unknown>;
  const fd = (settings.formDefaults ?? {}) as Record<string, unknown>;
  const defaultEmail = typeof fd.notificationEmail === "string" ? fd.notificationEmail.trim() : "";
  if (defaultEmail) return [];

  // Only fire when the site actually has forms — otherwise there's nothing
  // for a default to fall back from.
  const rows = await db
    .select({ blockType: contentBlocks.blockType, data: contentBlocks.data })
    .from(contentBlocks)
    .innerJoin(content, eq(content.id, contentBlocks.contentId))
    .where(eq(content.siteId, siteId));

  const hasForm = rows.some((row) => {
    if (row.blockType === "form") return true;
    if (row.blockType !== "html") return false;
    const data = (row.data ?? {}) as Record<string, unknown>;
    const html = typeof data.html === "string" ? data.html : "";
    return /<form[\s>]/i.test(html);
  });
  if (!hasForm) return [];

  return [
    {
      id: "form-defaults-missing-email",
      title: "Site-wide form notification email isn't set",
      rationale:
        "Form Defaults has no notification email, so any form without its own configured email sends submissions into the Forms dashboard without pinging anyone. Set a default in Settings → Form Defaults so nothing slips through.",
      page: "/settings",
      prompt:
        "Help me set a site-wide default notification email for forms in Settings → Form Defaults. Ask me which email I want, and confirm before saving.",
    },
  ];
}

async function detectImagesMissingAlt(siteId: string): Promise<Insight[]> {
  const rows = await db
    .select({
      contentId: content.id,
      slug: content.slug,
      blockType: contentBlocks.blockType,
      data: contentBlocks.data,
    })
    .from(contentBlocks)
    .innerJoin(content, eq(content.id, contentBlocks.contentId))
    .where(and(eq(content.siteId, siteId), ne(content.status, "archived")));

  // Per-page grouping so each affected page surfaces as its own actionable
  // insight (deep-link to the editor). An explicit empty alt="" is treated as
  // intentional decorative-image markup and not flagged — only fully missing
  // alt attributes count.
  const byContent = new Map<string, { slug: string; count: number }>();
  const bump = (contentId: string, slug: string, n = 1) => {
    const entry = byContent.get(contentId) ?? { slug, count: 0 };
    entry.count += n;
    byContent.set(contentId, entry);
  };

  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    if (row.blockType === "image") {
      const alt = data.alt;
      if (alt === undefined || alt === null) bump(row.contentId, row.slug);
    } else if (row.blockType === "gallery") {
      const items = (data.items as Array<{ alt?: unknown }> | undefined) ?? [];
      const missing = items.filter((i) => i?.alt === undefined || i?.alt === null).length;
      if (missing > 0) bump(row.contentId, row.slug, missing);
    } else if (row.blockType === "html") {
      const html = typeof data.html === "string" ? data.html : "";
      if (!html) continue;
      let missing = 0;
      for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
        if (!/\balt\s*=/i.test(m[1])) missing += 1;
      }
      if (missing > 0) bump(row.contentId, row.slug, missing);
    }
  }

  const results: Insight[] = [];
  for (const [contentId, info] of byContent) {
    const sig = signature({ contentId, count: info.count });
    const noun = `image${info.count === 1 ? "" : "s"}`;
    results.push({
      id: `images-missing-alt-${contentId}-${sig}`,
      title: `${info.count} ${noun} missing alt text on ${info.slug}`,
      rationale: `${info.count} ${noun} on the ${info.slug} page ${info.count === 1 ? "has" : "have"} no alt attribute. Alt text is what screen readers announce, what search engines index, and what shows when an image fails to load — leaving it off hurts accessibility and SEO.`,
      page: `/content/${contentId}`,
      prompt: `The "${info.slug}" page has ${info.count} ${noun} without alt text. Write descriptive alt text for each based on the surrounding content and what each image is conveying — keep it concise (under ~125 chars) and skip "image of" / "picture of" filler. Confirm with me before saving.`,
    });
  }
  return results;
}

async function detectFooterSocialIconsUnwired(siteId: string): Promise<Insight[]> {
  const [siteRow] = await db
    .select({ settings: sites.settings })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!siteRow) return [];

  const settings = (siteRow.settings ?? {}) as Record<string, unknown>;
  const theme = (settings.theme ?? {}) as Record<string, unknown>;
  const footerHtml = typeof theme.footerHtml === "string" ? theme.footerHtml : "";
  if (!footerHtml) return [];

  // Only flag when the footer actually has a social-icon container (svg or
  // material-symbols glyphs in a flex row). Without icons there's nothing to
  // unwire — the user simply hasn't been offered social links yet.
  const socialMatch = footerHtml.match(STITCH_FOOTER_SOCIAL_CONTAINER_RE);
  if (!socialMatch) return [];
  const inner = socialMatch[2];
  const hasIcons = inner.includes("<svg") || inner.includes("material-symbols");
  if (!hasIcons) return [];

  const links = (settings.socialLinks ?? []) as Array<{ platform?: string; url?: string }>;
  const wired = Array.isArray(links) && links.some((l) => typeof l?.url === "string" && l.url.trim() !== "");
  if (wired) return [];

  return [
    {
      id: "footer-social-unwired",
      title: "Footer social icons aren't pointing anywhere",
      rationale:
        "Your footer shows social icons, but no social profile URLs are configured. Visitors clicking them won't reach your accounts. Add the URLs in Settings — or remove the icons if you don't use those platforms.",
      page: "/settings",
      prompt:
        "My footer has social icons but I haven't filled in the URLs. Ask me which platforms I actually use, then save those URLs in Settings.",
    },
  ];
}

export async function getInsightsForSite(siteId: string, page?: string): Promise<Insight[]> {
  const all = (
    await Promise.all([
      detectUnwiredNav(siteId),
      detectFormsMissingEmail(siteId),
      detectMissingMetaDescriptions(siteId),
      detectUnwiredBodyLinks(siteId),
      detectUnwiredThemeLinks(siteId),
      detectMissingOrgInfo(siteId),
      detectMissingFormDefaults(siteId),
      detectFooterSocialIconsUnwired(siteId),
      detectImagesMissingAlt(siteId),
    ])
  ).flat();

  if (!page) return all;
  return all.filter((i) => !i.page || page === i.page || page.startsWith(`${i.page}/`));
}
