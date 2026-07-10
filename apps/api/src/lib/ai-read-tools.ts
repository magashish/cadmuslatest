import { eq, and, desc, sql } from "drizzle-orm";
import { db, content, contentBlocks, media, navigation, collections, sites, redirects, siteMembers, users } from "@cadmus/db";
import type { AITool, AIMessageContent } from "@cadmus/ai";
import type { SiteTheme, HtmlBlockEditableField } from "@cadmus/shared";

export interface ReadToolContext {
  siteId: string;
  currentPath?: string;
}

type ToolHandler = (ctx: ReadToolContext, input: Record<string, unknown>) => Promise<string>;

interface ReadTool {
  definition: AITool;
  handler: ToolHandler;
}

const tools: Record<string, ReadTool> = {
  list_content: {
    definition: {
      name: "list_content",
      description: "List pages and posts on the site. Returns id, type, slug, title, and status for each. Use before making edits so you know what exists.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["page", "post", "product"], description: "Filter by content type (optional)" },
          status: { type: "string", enum: ["draft", "published", "archived"], description: "Filter by status (optional)" },
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
    handler: async (ctx, input) => {
      const { type, status, limit } = input as { type?: string; status?: string; limit?: number };
      const conds = [eq(content.siteId, ctx.siteId)];
      if (type) conds.push(eq(content.type, type));
      if (status) conds.push(eq(content.status, status));
      const rows = await db
        .select({ id: content.id, type: content.type, slug: content.slug, status: content.status, schemaData: content.schemaData })
        .from(content)
        .where(and(...conds))
        .orderBy(desc(content.updatedAt))
        .limit(Math.min(limit ?? 50, 200));
      if (rows.length === 0) return "(no content matches)";
      return rows
        .map((r) => {
          const title = String((r.schemaData as Record<string, unknown> | null)?.title ?? r.slug);
          return `- id=${r.id} ${r.type} slug="${r.slug}" status=${r.status} title="${title}"`;
        })
        .join("\n");
    },
  },

  read_content: {
    definition: {
      name: "read_content",
      description: "Read a page or post by id. Returns the metadata and a summary of each block. Use this before editing to see what's on the page.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Content id" } },
        required: ["id"],
      },
    },
    handler: async (ctx, input) => {
      const id = String(input.id);
      const [row] = await db.select().from(content).where(eq(content.id, id));
      if (!row || row.siteId !== ctx.siteId) return "Not found";
      const schema = (row.schemaData ?? {}) as Record<string, unknown>;
      const blocks = await db
        .select({ id: contentBlocks.id, position: contentBlocks.position, blockType: contentBlocks.blockType, data: contentBlocks.data })
        .from(contentBlocks)
        .where(eq(contentBlocks.contentId, id))
        .orderBy(contentBlocks.position);
      const lines: string[] = [
        `id: ${row.id}`,
        `type: ${row.type}`,
        `slug: ${row.slug}`,
        `status: ${row.status}`,
        `title: ${schema.title ?? row.slug}`,
      ];
      if (schema.metaDescription) lines.push(`metaDescription: ${schema.metaDescription}`);
      if (schema.featuredImage) lines.push(`featuredImage: ${schema.featuredImage}`);
      lines.push(`blocks (${blocks.length}):`);
      for (const b of blocks) {
        const data = (b.data ?? {}) as Record<string, unknown>;
        const prefix = `  blockId=${b.id} position=${b.position}`;
        if (b.blockType === "html" && typeof data.html === "string") {
          const section = data.sectionName ? ` (${data.sectionName})` : "";
          const text = data.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          lines.push(`${prefix} [html${section}]: ${text.slice(0, 400)}`);
        } else if (b.blockType === "heading" && data.text) {
          lines.push(`${prefix} [heading]: ${data.text}`);
        } else if (b.blockType === "paragraph" && data.text) {
          lines.push(`${prefix} [paragraph]: ${String(data.text).slice(0, 300)}`);
        } else if (b.blockType === "text" && data.content) {
          lines.push(`${prefix} [text]: ${String(data.content).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`);
        } else if (b.blockType === "hero") {
          lines.push(`${prefix} [hero]: ${data.headline ?? ""}${data.subheadline ? " — " + data.subheadline : ""}`);
        } else if (b.blockType === "cta") {
          lines.push(`${prefix} [cta]: ${data.headline ?? ""} — ${data.buttonText ?? ""}`);
        } else if (b.blockType === "faq" && Array.isArray(data.items)) {
          lines.push(`${prefix} [faq]: ${(data.items as { question: string }[]).map((i) => i.question).join(", ")}`);
        } else {
          lines.push(`${prefix} [${b.blockType}]`);
        }
      }
      return lines.join("\n");
    },
  },

  get_html_block: {
    definition: {
      name: "get_html_block",
      description: "Read the FULL raw HTML of a single html block by id. read_content only shows a truncated, tag-stripped preview — always call this to get the complete markup before editing an html block with update_html_block, so you can resubmit the full HTML without losing anything.",
      input_schema: {
        type: "object",
        properties: { blockId: { type: "string", description: "Block id (UUID) from read_content. Must be an html block." } },
        required: ["blockId"],
      },
    },
    handler: async (ctx, input) => {
      const MAX_HTML_CHARS = 20000;
      const blockId = String(input.blockId);
      // Join to content to enforce site isolation — blocks don't carry siteId directly.
      const [row] = await db
        .select({ blockType: contentBlocks.blockType, data: contentBlocks.data, position: contentBlocks.position, siteId: content.siteId, contentId: contentBlocks.contentId })
        .from(contentBlocks)
        .innerJoin(content, eq(contentBlocks.contentId, content.id))
        .where(eq(contentBlocks.id, blockId));
      if (!row || row.siteId !== ctx.siteId) return "Not found";
      if (row.blockType !== "html") return `Block ${blockId} is a "${row.blockType}" block, not html. get_html_block only works on html blocks.`;
      const data = (row.data ?? {}) as Record<string, unknown>;
      const html = typeof data.html === "string" ? data.html : "";
      const section = data.sectionName ? String(data.sectionName) : "";
      const lines: string[] = [`blockId: ${blockId}`, `position: ${row.position}`];
      if (section) lines.push(`sectionName: ${section}`);
      if (!html) {
        lines.push("html: (empty)");
        return lines.join("\n");
      }
      const truncated = html.length > MAX_HTML_CHARS
        ? `${html.slice(0, MAX_HTML_CHARS)}\n<!-- ...truncated, total ${html.length} chars -->`
        : html;
      lines.push(`html (${html.length} chars — this is the COMPLETE block markup; preserve all structure when editing):`);
      lines.push("```html");
      lines.push(truncated);
      lines.push("```");

      // Surface the immediate neighbor blocks so the edit matches its
      // surroundings — section rhythm, dark/light alternation, heading
      // treatment, button style. This is where single-block myopia bites:
      // without it, a re-styled block drifts from the page's design language.
      const siblings = await db
        .select({ position: contentBlocks.position, blockType: contentBlocks.blockType, data: contentBlocks.data })
        .from(contentBlocks)
        .where(eq(contentBlocks.contentId, row.contentId))
        .orderBy(contentBlocks.position);
      const idx = siblings.findIndex((s) => s.position === row.position);
      const neighbors = [siblings[idx - 1], siblings[idx + 1]].filter(Boolean);
      if (neighbors.length) {
        lines.push("");
        lines.push("Neighboring sections (for style/voice consistency — do NOT edit these, match their design language):");
        for (const n of neighbors) {
          const nd = (n.data ?? {}) as Record<string, unknown>;
          const rel = n.position < row.position ? "above" : "below";
          const nSection = nd.sectionName ? ` (${nd.sectionName})` : "";
          if (n.blockType === "html" && typeof nd.html === "string") {
            const preview = nd.html.length > 1200 ? `${nd.html.slice(0, 1200)}\n<!-- ...truncated -->` : nd.html;
            lines.push(`--- ${rel}: html block${nSection} ---`);
            lines.push("```html");
            lines.push(preview);
            lines.push("```");
          } else {
            const text = JSON.stringify(nd).slice(0, 300);
            lines.push(`--- ${rel}: ${n.blockType} block${nSection} --- ${text}`);
          }
        }
      }
      return lines.join("\n");
    },
  },

  search_content: {
    definition: {
      name: "search_content",
      description: "Search pages and posts by keyword across title and slug. Use when the user references content by name rather than id.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
        required: ["query"],
      },
    },
    handler: async (ctx, input) => {
      const query = String(input.query ?? "").trim();
      const limit = Math.min(Number(input.limit ?? 20), 50);
      if (!query) return "(empty query)";
      const rows = await db
        .select({ id: content.id, type: content.type, slug: content.slug, schemaData: content.schemaData })
        .from(content)
        .where(
          and(
            eq(content.siteId, ctx.siteId),
            sql`${content.slug} ILIKE ${"%" + query + "%"} OR (${content.schemaData}->>'title') ILIKE ${"%" + query + "%"}`,
          ),
        )
        .limit(limit);
      if (rows.length === 0) return `(no matches for "${query}")`;
      return rows
        .map((r) => {
          const title = String((r.schemaData as Record<string, unknown> | null)?.title ?? r.slug);
          return `- id=${r.id} ${r.type} slug="${r.slug}" title="${title}"`;
        })
        .join("\n");
    },
  },

  list_media: {
    definition: {
      name: "list_media",
      description: "List media library items. Returns id, filename, mime type, and alt text. Use when the user references uploaded images or wants to manage alt text.",
      input_schema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max results (default 50)" } },
      },
    },
    handler: async (ctx, input) => {
      const limit = Math.min(Number(input.limit ?? 50), 200);
      const rows = await db
        .select({ id: media.id, filename: media.filename, mimeType: media.mimeType, aiAltText: media.aiAltText })
        .from(media)
        .where(eq(media.siteId, ctx.siteId))
        .orderBy(desc(media.createdAt))
        .limit(limit);
      if (rows.length === 0) return "(no media uploaded)";
      return rows
        .map((m) => {
          const alt = m.aiAltText ? ` alt="${m.aiAltText}"` : " (no alt)";
          return `- id=${m.id} "${m.filename}" ${m.mimeType}${alt}`;
        })
        .join("\n");
    },
  },

  list_navigation: {
    definition: {
      name: "list_navigation",
      description: "List navigation menus (typically 'header' and 'footer') with their current items.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (ctx) => {
      const rows = await db
        .select({ location: navigation.location, items: navigation.items })
        .from(navigation)
        .where(eq(navigation.siteId, ctx.siteId));
      if (rows.length === 0) return "(no menus defined)";
      return rows
        .map((r) => {
          const items = (r.items ?? []) as Array<{ label: string; url: string }>;
          const list = items.length ? items.map((i) => `"${i.label}" → ${i.url}`).join(", ") : "(empty)";
          return `${r.location}: ${list}`;
        })
        .join("\n");
    },
  },

  list_collections: {
    definition: {
      name: "list_collections",
      description: "List taxonomy collections (categories, tags, etc.) on the site.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (ctx) => {
      const rows = await db
        .select({ id: collections.id, type: collections.type, name: collections.name, slug: collections.slug })
        .from(collections)
        .where(eq(collections.siteId, ctx.siteId));
      if (rows.length === 0) return "(no collections defined)";
      return rows.map((c) => `- id=${c.id} ${c.type}: "${c.name}" (slug: ${c.slug})`).join("\n");
    },
  },

  read_header_footer: {
    definition: {
      name: "read_header_footer",
      description: "Read the site's current header and footer HTML plus editable field definitions. Required before any UPDATE_HEADER or UPDATE_FOOTER edit so you preserve structure, classes, and data-cadmus-field markers.",
      input_schema: {
        type: "object",
        properties: {
          which: { type: "string", enum: ["header", "footer", "both"], description: "Which to read (default 'both')" },
        },
      },
    },
    handler: async (ctx, input) => {
      const which = (input.which as "header" | "footer" | "both") ?? "both";
      const [site] = await db.select().from(sites).where(eq(sites.id, ctx.siteId));
      if (!site) return "Site not found";
      const settings = (site.settings ?? {}) as Record<string, unknown>;
      const theme = settings.theme as SiteTheme | undefined;
      if (!theme) return "No theme configured";
      const navMenus = (await db
        .select({ location: navigation.location, items: navigation.items })
        .from(navigation)
        .where(eq(navigation.siteId, ctx.siteId))) as { location: string; items: unknown[] }[];
      const parts: string[] = [];
      if (which === "header" || which === "both") parts.push(summarizeHeaderFooter("header", theme, navMenus));
      if (which === "footer" || which === "both") parts.push(summarizeHeaderFooter("footer", theme, navMenus));
      return parts.join("\n\n");
    },
  },

  get_page_context: {
    definition: {
      name: "get_page_context",
      description: "Get info about what page the user is currently viewing in the admin. Use when they say 'this page', 'this post', or ask without specifying which content.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (ctx) => {
      const path = ctx.currentPath;
      if (!path) return "User's current location is unknown.";
      const contentMatch = path.match(/^\/content\/([a-zA-Z0-9-]+)$/);
      if (contentMatch) {
        const id = contentMatch[1];
        const [row] = await db.select().from(content).where(eq(content.id, id));
        if (!row || row.siteId !== ctx.siteId) return `User is at ${path} but that content is not in this site.`;
        const schema = (row.schemaData ?? {}) as Record<string, unknown>;
        return `User is editing content id=${row.id} (${row.type}, slug: ${row.slug}, title: "${schema.title ?? row.slug}"). "This page/post" refers to this one. Call read_content to see the blocks.`;
      }
      const pageMap: Record<string, string> = {
        "/content": "User is on the content list page.",
        "/media": "User is on the media library page.",
        "/settings": "User is on the site settings page.",
        "/navigation": "User is on the navigation/menu management page.",
        "/collections": "User is on the collections page.",
        "/theme": "User is on the theme/header-footer editor page.",
      };
      return pageMap[path] ?? `User is at ${path}.`;
    },
  },
};

function summarizeHeaderFooter(
  which: "header" | "footer",
  theme: SiteTheme,
  navMenus: { location: string; items: unknown[] }[],
): string {
  const MAX_HTML_CHARS = 20000;
  const html = which === "header" ? theme.headerHtml : theme.footerHtml;
  const fields = which === "header" ? theme.headerEditableFields : theme.footerEditableFields;
  const menu = navMenus.find((n) => n.location === which);
  const menuItems = (menu?.items ?? []) as Array<{ label: string; url: string }>;

  const block: string[] = [`${which.toUpperCase()}:`];
  block.push(`  Menu items (${menuItems.length}): ${menuItems.length ? menuItems.map((i: { label: string; url: string }) => `"${i.label}" → ${i.url}`).join(", ") : "(none)"}`);

  const fieldEntries = Object.entries(fields ?? {}) as Array<[string, HtmlBlockEditableField]>;
  if (fieldEntries.length > 0) {
    block.push(`  Editable fields (${fieldEntries.length}):`);
    for (const [id, f] of fieldEntries) {
      const wired = html ? html.includes(`data-cadmus-field="${id}"`) : false;
      const shortVal = f.value.length > 80 ? `${f.value.slice(0, 80)}...` : f.value;
      const suffix = wired
        ? ""
        : " [UNWIRED — no data-cadmus-field marker in HTML; editableFields patches on this id will NOT change the rendered output. Edit html to affect this element.]";
      block.push(`    - id: "${id}" (${f.type}, label: "${f.label}"): ${JSON.stringify(shortVal)}${suffix}`);
    }
  } else {
    block.push(`  Editable fields: (none)`);
  }

  if (html) {
    const truncated = html.length > MAX_HTML_CHARS
      ? `${html.slice(0, MAX_HTML_CHARS)}\n<!-- ...truncated, total ${html.length} chars -->`
      : html;
    block.push(`  Current HTML (${html.length} chars — preserve all classes, structure, and data-cadmus-field markers when editing):`);
    block.push("  \`\`\`html");
    block.push(truncated.split("\n").map((l) => `  ${l}`).join("\n"));
    block.push("  \`\`\`");
  } else {
    block.push(`  Current HTML: (not set)`);
  }

  return block.join("\n");
}

tools.list_team = {
  definition: {
    name: "list_team",
    description: "List all team members for this site — their name, email, role, and status (active or invited pending acceptance).",
    input_schema: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    const rows = await db
      .select({
        memberId: siteMembers.id,
        role: siteMembers.role,
        status: siteMembers.status,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(siteMembers)
      .innerJoin(users, eq(siteMembers.userId, users.id))
      .where(and(eq(siteMembers.siteId, ctx.siteId), eq(siteMembers.status, "active")));
    const invited = await db
      .select({ role: siteMembers.role, email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(siteMembers)
      .innerJoin(users, eq(siteMembers.userId, users.id))
      .where(and(eq(siteMembers.siteId, ctx.siteId), eq(siteMembers.status, "invited")));
    if (rows.length === 0 && invited.length === 0) return "(no team members)";
    const lines = [
      ...rows.map((r) => {
        const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email;
        return `- ${name} <${r.email}> — ${r.role} (active, memberId: ${r.memberId})`;
      }),
      ...invited.map((r) => {
        const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email;
        return `- ${name} <${r.email}> — ${r.role} (invited, pending acceptance)`;
      }),
    ];
    return lines.join("\n");
  },
};

tools.list_redirects = {
  definition: {
    name: "list_redirects",
    description: "List all URL redirects configured for this site. Returns fromPath, toUrl, statusCode, and enabled for each rule.",
    input_schema: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    const rows = await db
      .select({ fromPath: redirects.fromPath, toUrl: redirects.toUrl, statusCode: redirects.statusCode, enabled: redirects.enabled })
      .from(redirects)
      .where(eq(redirects.siteId, ctx.siteId));
    if (rows.length === 0) return "(no redirects configured)";
    return rows.map((r) => `- ${r.fromPath} → ${r.toUrl} [${r.statusCode}]${r.enabled ? "" : " (disabled)"}`).join("\n");
  },
};

export const readToolDefinitions: AITool[] = Object.values(tools).map((t) => t.definition);

export async function executeReadTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ReadToolContext,
): Promise<{ content: string; is_error: boolean }> {
  const tool = tools[name];
  if (!tool) {
    return { content: `Unknown tool: ${name}`, is_error: true };
  }
  try {
    const result = await tool.handler(ctx, input);
    return { content: result, is_error: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Tool "${name}" failed: ${msg}`, is_error: true };
  }
}

/** Convenience: run a tool_use content block and return the matching tool_result block. */
export async function runToolUse(
  block: Extract<AIMessageContent, { type: "tool_use" }>,
  ctx: ReadToolContext,
): Promise<Extract<AIMessageContent, { type: "tool_result" }>> {
  const { content, is_error } = await executeReadTool(block.name, block.input, ctx);
  return { type: "tool_result", tool_use_id: block.id, content, is_error };
}
