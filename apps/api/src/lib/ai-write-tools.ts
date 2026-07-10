import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, content, contentBlocks, contentVersions, media, contentMedia, navigation, collections, contentCollections, sites, auditLog, aiHistory, redirects, siteMembers, users } from "@cadmus/db";
import type { AIRouter, AITool } from "@cadmus/ai";
import type { HtmlBlockEditableField, SiteTheme, SiteRole, DesignIntent } from "@cadmus/shared";
import type { StorageProvider } from "@cadmus/cloud";
import { optimizeImage, IMAGE_PRESETS } from "./image-optimization.js";
import { getEmailProvider } from "./email.js";
import { checkFeatureGate } from "./feature-gates.js";
import { sanitizeHtmlBlock } from "./sanitize-html-block.js";
import { mergeDesignIntent, DESIGN_INTENT_TEXT_FIELDS } from "./design-intent.js";

export interface WriteToolContext {
  siteId: string;
  turnId: string;
  model: string;
  usedFallback: boolean;
  /** The user's chat message — logged on the ai_history row for traceability. */
  message: string;
  /** Used by tools that generate images (create_content, generate_image, design_page). */
  router: AIRouter | null;
  storage: StorageProvider | null;
  /** The caller's role on this site. Gates privileged tools (see minRole). */
  role: SiteRole;
  /**
   * The site's realized design intent, if synthesized. Used to enrich image
   * generation so AI-generated images match the established imagery style and
   * tone rather than reading as generic stock.
   */
  designIntent?: DesignIntent;
}

/**
 * Append the site's imagery direction to an image-generation prompt so edit-time
 * images cohere with the homepage's established look. No-op when there's no
 * design intent yet (e.g. before the homepage is generated).
 */
function enrichImagePrompt(prompt: string, di: DesignIntent | undefined): string {
  if (!di) return prompt;
  const cues = [
    di.imageryStyle && `Imagery style: ${di.imageryStyle}`,
    di.voiceAndTone && `Mood/tone: ${di.voiceAndTone}`,
    di.colorAndType && `Palette guidance: ${di.colorAndType}`,
  ].filter(Boolean);
  if (!cues.length) return prompt;
  return `${prompt}\n\nMatch this site's established visual direction:\n${cues.join("\n")}`;
}

const ROLE_RANK: Record<string, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

/** True if `role` is at least `min` in the owner>admin>editor>viewer hierarchy. */
function roleMeets(role: string | undefined, min: SiteRole): boolean {
  return (ROLE_RANK[role ?? ""] ?? 0) >= ROLE_RANK[min];
}

export interface WriteToolOutcome {
  /** Text returned to the AI as tool_result content. */
  content: string;
  is_error: boolean;
  /** ChatAction to include in the response's actions[] so the UI can render it. */
  action: {
    type: string;
    status: "success" | "error";
    result?: Record<string, unknown>;
    error?: string;
    historyId?: string;
  };
}

type WriteHandler = (ctx: WriteToolContext, input: Record<string, unknown>) => Promise<WriteToolOutcome>;

// Tool inputs come straight from the model's JSON. Most providers send arrays
// as arrays, but a few occasionally serialize them as a JSON string. Coerce
// here so the handlers can rely on Array.isArray, instead of crashing with
// "blocks.map is not a function" mid-transaction.
function coerceBlocks(value: unknown): { blockType: string; data: unknown }[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value as { blockType: string; data: unknown }[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as { blockType: string; data: unknown }[];
    } catch {
      // fall through
    }
  }
  return undefined;
}

// Validate the per-block-type required fields so the AI gets a clear error
// message when it sends, e.g., {blockType:"html",data:{content:"..."}} —
// otherwise the row saves and the editor renders "undefined" silently.
function validateBlockShapes(blocks: { blockType: string; data: unknown }[]): string | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const data = (b.data ?? {}) as Record<string, unknown>;
    if (b.blockType === "html" && typeof data.html !== "string") {
      return `Block ${i} (html): data.html is required and must be a string. Use {"blockType":"html","data":{"html":"<HTML>","sectionName":"..."}}.`;
    }
    if (b.blockType === "text" && typeof data.content !== "string") {
      return `Block ${i} (text): data.content is required and must be a string. Use {"blockType":"text","data":{"content":"<HTML>"}}.`;
    }
  }
  return null;
}

interface WriteTool {
  definition: AITool;
  actionType: string;
  handler: WriteHandler;
  /**
   * Minimum site role required to use this tool. Defaults to "editor" (the
   * /api/ai/* mount already requires editor+). Set higher to mirror the REST
   * ACL for the equivalent action — e.g. team management and navigation are
   * admin/owner-only via REST, so editors must not reach them through chat.
   */
  minRole?: SiteRole;
}

const tools: Record<string, WriteTool> = {
  update_navigation: {
    actionType: "UPDATE_NAVIGATION",
    minRole: "admin", // mirrors navigation REST (requireRole admin/owner)
    definition: {
      name: "update_navigation",
      description: "Replace the complete menu for a navigation location (typically 'header' or 'footer'). Pass the full items array, not a diff — items omitted are removed. Call list_navigation first to see the current items.",
      input_schema: {
        type: "object",
        properties: {
          location: { type: "string", description: "Menu location, e.g. 'header' or 'footer'" },
          items: {
            type: "array",
            description: "Complete ordered list of menu items for this location",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Display text" },
                url: { type: "string", description: "Link target (e.g. '/about', '/blog')" },
              },
              required: ["label", "url"],
            },
          },
        },
        required: ["location", "items"],
      },
    },
    handler: async (ctx, input) => {
      const { location, items } = input as { location?: string; items?: { label: string; url: string }[] };
      if (!location || !Array.isArray(items)) {
        return errorOutcome("UPDATE_NAVIGATION", "location and items are required");
      }

      const allNavs = await db.select().from(navigation).where(eq(navigation.siteId, ctx.siteId));
      const navForLoc = allNavs.find((n) => n.location === location);

      let entityId: string;
      let prevState: Record<string, unknown>;
      let resultItems = items;

      if (navForLoc) {
        entityId = navForLoc.id;
        prevState = { items: navForLoc.items, location, created: false };
        await db.update(navigation).set({ items, updatedAt: new Date() }).where(eq(navigation.id, navForLoc.id));
        await db.insert(auditLog).values({
          siteId: ctx.siteId,
          actorType: "ai",
          action: "navigation.updated",
          entityType: "navigation",
          entityId,
          details: { location, itemCount: items.length },
        });
      } else {
        const [created] = await db.insert(navigation).values({ siteId: ctx.siteId, location, items }).returning();
        entityId = created.id;
        prevState = { location, created: true };
        resultItems = (created.items as typeof items) ?? items;
        await db.insert(auditLog).values({
          siteId: ctx.siteId,
          actorType: "ai",
          action: "navigation.created",
          entityType: "navigation",
          entityId,
          details: { location, itemCount: items.length },
        });
      }

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `UPDATE_NAVIGATION on navigation:${entityId}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "UPDATE_NAVIGATION",
          entityType: "navigation",
          entityId,
          previousState: prevState,
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Updated ${location} menu — ${items.length} item${items.length === 1 ? "" : "s"}.`,
        is_error: false,
        action: {
          type: "UPDATE_NAVIGATION",
          status: "success",
          result: { id: entityId, location, items: resultItems },
          historyId: historyRow.id,
        },
      };
    },
  },

  create_collection: {
    actionType: "CREATE_COLLECTION",
    definition: {
      name: "create_collection",
      description: "Create a new collection (category, tag, or series) for organizing content. Call list_collections first to avoid duplicates.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Collection type: 'category', 'tag', or 'series'" },
          name: { type: "string", description: "Display name" },
          slug: { type: "string", description: "URL-friendly slug (lowercase, hyphens, no spaces)" },
          parentId: { type: "string", description: "Optional parent collection id for nesting" },
        },
        required: ["type", "name", "slug"],
      },
    },
    handler: async (ctx, input) => {
      const { type, name, slug, parentId } = input as {
        type?: string;
        name?: string;
        slug?: string;
        parentId?: string;
      };
      if (!type || !name || !slug) {
        return errorOutcome("CREATE_COLLECTION", "type, name, and slug are required");
      }

      const [created] = await db
        .insert(collections)
        .values({ siteId: ctx.siteId, type, name, slug, parentId: parentId ?? null })
        .returning();

      await db.insert(auditLog).values({
        siteId: ctx.siteId,
        actorType: "ai",
        action: "collection.created",
        entityType: "collection",
        entityId: created.id,
        details: { type, name, slug },
      });

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `CREATE_COLLECTION on collection:${created.id}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "CREATE_COLLECTION",
          entityType: "collection",
          entityId: created.id,
          previousState: null,
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Created ${type} "${name}" (id: ${created.id}).`,
        is_error: false,
        action: {
          type: "CREATE_COLLECTION",
          status: "success",
          result: { id: created.id, type, name, slug },
          historyId: historyRow.id,
        },
      };
    },
  },

  update_collection: {
    actionType: "UPDATE_COLLECTION",
    definition: {
      name: "update_collection",
      description: "Rename or reparent an existing collection. Call list_collections first to find the id.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Collection id (UUID)" },
          name: { type: "string", description: "New display name" },
          slug: { type: "string", description: "New URL-friendly slug" },
          parentId: { type: ["string", "null"], description: "New parent collection id, or null to make it top-level" },
        },
        required: ["id"],
      },
    },
    handler: async (ctx, input) => {
      const { id, name, slug, parentId } = input as {
        id?: string;
        name?: string;
        slug?: string;
        parentId?: string | null;
      };
      if (!id) {
        return errorOutcome("UPDATE_COLLECTION", "id is required");
      }

      const [existing] = await db.select().from(collections).where(eq(collections.id, id));
      if (!existing || existing.siteId !== ctx.siteId) {
        return errorOutcome("UPDATE_COLLECTION", "Collection not found");
      }

      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (slug !== undefined) updates.slug = slug;
      if (parentId !== undefined) updates.parentId = parentId;

      if (Object.keys(updates).length === 0) {
        return errorOutcome("UPDATE_COLLECTION", "No fields to update");
      }

      const [updated] = await db
        .update(collections)
        .set(updates)
        .where(eq(collections.id, id))
        .returning();

      await db.insert(auditLog).values({
        siteId: ctx.siteId,
        actorType: "ai",
        action: "collection.updated",
        entityType: "collection",
        entityId: id,
        details: updates,
      });

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `UPDATE_COLLECTION on collection:${id}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "UPDATE_COLLECTION",
          entityType: "collection",
          entityId: id,
          previousState: {
            name: existing.name,
            slug: existing.slug,
            parentId: existing.parentId,
          },
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Updated collection ${id}: ${Object.keys(updates).join(", ")}.`,
        is_error: false,
        action: {
          type: "UPDATE_COLLECTION",
          status: "success",
          result: { id: updated.id, type: updated.type, name: updated.name, slug: updated.slug },
          historyId: historyRow.id,
        },
      };
    },
  },

  add_to_collection: {
    actionType: "ADD_TO_COLLECTION",
    definition: {
      name: "add_to_collection",
      description: "Assign a content item (page or post) to a collection. Idempotent — no-op if already linked.",
      input_schema: {
        type: "object",
        properties: {
          collectionId: { type: "string", description: "Collection id (UUID)" },
          contentId: { type: "string", description: "Content id (UUID) of the page or post" },
        },
        required: ["collectionId", "contentId"],
      },
    },
    handler: async (ctx, input) => {
      const { collectionId, contentId } = input as {
        collectionId?: string;
        contentId?: string;
      };
      if (!collectionId || !contentId) {
        return errorOutcome("ADD_TO_COLLECTION", "collectionId and contentId are required");
      }

      const [coll] = await db.select().from(collections).where(eq(collections.id, collectionId));
      if (!coll || coll.siteId !== ctx.siteId) {
        return errorOutcome("ADD_TO_COLLECTION", "Collection not found");
      }

      const existingJoin = await db
        .select()
        .from(contentCollections)
        .where(
          and(
            eq(contentCollections.contentId, contentId),
            eq(contentCollections.collectionId, collectionId),
          ),
        );
      const alreadyLinked = existingJoin.length > 0;

      await db
        .insert(contentCollections)
        .values({ contentId, collectionId })
        .onConflictDoNothing();

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `ADD_TO_COLLECTION link collection:${collectionId} → content:${contentId}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "ADD_TO_COLLECTION",
          entityType: "collection",
          entityId: collectionId,
          previousState: { contentId, alreadyLinked },
        })
        .returning({ id: aiHistory.id });

      return {
        content: alreadyLinked
          ? `Content ${contentId} was already in collection ${collectionId} — no change.`
          : `Added content ${contentId} to collection ${collectionId}.`,
        is_error: false,
        action: {
          type: "ADD_TO_COLLECTION",
          status: "success",
          result: { collectionId, contentId },
          historyId: historyRow.id,
        },
      };
    },
  },

  remove_from_collection: {
    actionType: "REMOVE_FROM_COLLECTION",
    definition: {
      name: "remove_from_collection",
      description: "Unlink a content item from a collection. Does not delete the content or the collection.",
      input_schema: {
        type: "object",
        properties: {
          collectionId: { type: "string", description: "Collection id (UUID)" },
          contentId: { type: "string", description: "Content id (UUID)" },
        },
        required: ["collectionId", "contentId"],
      },
    },
    handler: async (ctx, input) => {
      const { collectionId, contentId } = input as {
        collectionId?: string;
        contentId?: string;
      };
      if (!collectionId || !contentId) {
        return errorOutcome("REMOVE_FROM_COLLECTION", "collectionId and contentId are required");
      }

      const [coll] = await db.select().from(collections).where(eq(collections.id, collectionId));
      if (!coll || coll.siteId !== ctx.siteId) {
        return errorOutcome("REMOVE_FROM_COLLECTION", "Collection not found");
      }

      const existingJoin = await db
        .select()
        .from(contentCollections)
        .where(
          and(
            eq(contentCollections.contentId, contentId),
            eq(contentCollections.collectionId, collectionId),
          ),
        );
      if (existingJoin.length === 0) {
        return errorOutcome("REMOVE_FROM_COLLECTION", "Content is not in that collection");
      }

      await db
        .delete(contentCollections)
        .where(
          and(
            eq(contentCollections.contentId, contentId),
            eq(contentCollections.collectionId, collectionId),
          ),
        );

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `REMOVE_FROM_COLLECTION unlink collection:${collectionId} ↮ content:${contentId}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "REMOVE_FROM_COLLECTION",
          entityType: "collection",
          entityId: collectionId,
          previousState: { contentId },
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Removed content ${contentId} from collection ${collectionId}.`,
        is_error: false,
        action: {
          type: "REMOVE_FROM_COLLECTION",
          status: "success",
          result: { collectionId, contentId },
          historyId: historyRow.id,
        },
      };
    },
  },

  delete_collection: {
    actionType: "DELETE_COLLECTION",
    definition: {
      name: "delete_collection",
      description: "Delete a collection. Content items linked to it are automatically unlinked (the content itself is not deleted). Call list_collections first to find the id. Undo restores the collection and its links.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Collection id (UUID)" },
        },
        required: ["id"],
      },
    },
    handler: async (ctx, input) => {
      const { id } = input as { id?: string };
      if (!id) {
        return errorOutcome("DELETE_COLLECTION", "id is required");
      }

      const [existing] = await db.select().from(collections).where(eq(collections.id, id));
      if (!existing || existing.siteId !== ctx.siteId) {
        return errorOutcome("DELETE_COLLECTION", "Collection not found");
      }

      const links = await db
        .select({ contentId: contentCollections.contentId })
        .from(contentCollections)
        .where(eq(contentCollections.collectionId, id));
      const linkedContentIds = links.map((l) => l.contentId);

      // Cascade FK on content_collections removes links automatically.
      await db.delete(collections).where(eq(collections.id, id));

      await db.insert(auditLog).values({
        siteId: ctx.siteId,
        actorType: "ai",
        action: "collection.deleted",
        entityType: "collection",
        entityId: id,
        details: { name: existing.name, slug: existing.slug, linkedContentCount: linkedContentIds.length },
      });

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `DELETE_COLLECTION on collection:${id}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "DELETE_COLLECTION",
          entityType: "collection",
          entityId: id,
          previousState: {
            type: existing.type,
            name: existing.name,
            slug: existing.slug,
            parentId: existing.parentId,
            createdAt: existing.createdAt.toISOString(),
            linkedContentIds,
          },
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Deleted ${existing.type} "${existing.name}" (${linkedContentIds.length} content link${linkedContentIds.length === 1 ? "" : "s"} removed).`,
        is_error: false,
        action: {
          type: "DELETE_COLLECTION",
          status: "success",
          result: { id, name: existing.name, linkedContentCount: linkedContentIds.length },
          historyId: historyRow.id,
        },
      };
    },
  },

  update_media: {
    actionType: "UPDATE_MEDIA",
    definition: {
      name: "update_media",
      description: "Update a media item's metadata: alt text (for accessibility + SEO), display filename, or tags. Call list_media first if you need to find the id.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Media id (UUID)" },
          altText: { type: "string", description: "Descriptive alt text for screen readers and SEO" },
          filename: { type: "string", description: "Display filename" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for organization" },
        },
        required: ["id"],
      },
    },
    handler: async (ctx, input) => {
      const { id, altText, filename, tags } = input as {
        id?: string;
        altText?: string;
        filename?: string;
        tags?: string[];
      };

      if (!id) {
        return errorOutcome("UPDATE_MEDIA", "id is required");
      }

      const [existing] = await db.select().from(media).where(eq(media.id, id));
      if (!existing || existing.siteId !== ctx.siteId) {
        return errorOutcome("UPDATE_MEDIA", "Media not found");
      }

      const updates: Record<string, unknown> = {};
      if (altText !== undefined) updates.aiAltText = altText;
      if (filename !== undefined) updates.filename = filename;
      if (tags !== undefined) updates.aiTags = tags;

      if (Object.keys(updates).length === 0) {
        return errorOutcome("UPDATE_MEDIA", "No fields to update");
      }

      const [updated] = await db.update(media).set(updates).where(eq(media.id, id)).returning();

      await db.insert(auditLog).values({
        siteId: ctx.siteId,
        actorType: "ai",
        action: "media.updated",
        entityType: "media",
        entityId: id,
        details: { changes: Object.keys(updates) },
      });

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `UPDATE_MEDIA on media:${id}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "UPDATE_MEDIA",
          entityType: "media",
          entityId: id,
          previousState: {
            filename: existing.filename,
            aiAltText: existing.aiAltText,
            aiTags: existing.aiTags,
          },
        })
        .returning({ id: aiHistory.id });

      const changed = Object.keys(updates).join(", ");
      return {
        content: `Updated media ${id}: ${changed}.`,
        is_error: false,
        action: {
          type: "UPDATE_MEDIA",
          status: "success",
          result: { id: updated.id, filename: updated.filename, altText: updated.aiAltText },
          historyId: historyRow.id,
        },
      };
    },
  },

  generate_image: {
    actionType: "GENERATE_IMAGE",
    definition: {
      name: "generate_image",
      description: "Generate an AI image and save it to the media library. Optionally set it as the featured image on a page or post. Uses 16:9 by default — pick an aspect ratio that matches the use case.",
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed image description (style, mood, subject, colors)" },
          contentId: { type: "string", description: "Optional content id — if provided, the image is set as that content's featured image" },
          aspectRatio: { type: "string", description: "'1:1', '3:4', '4:3', '9:16', or '16:9' (default)" },
        },
        required: ["prompt"],
      },
    },
    handler: async (ctx, input) => {
      const { prompt, contentId, aspectRatio } = input as {
        prompt?: string;
        contentId?: string;
        aspectRatio?: string;
      };

      if (!prompt) {
        return errorOutcome("GENERATE_IMAGE", "prompt is required");
      }
      if (!ctx.router) {
        return errorOutcome("GENERATE_IMAGE", "AI providers not configured");
      }
      if (!ctx.storage) {
        return errorOutcome("GENERATE_IMAGE", "Storage provider not configured");
      }

      const imgResult = await ctx.router.generateImage({ prompt: enrichImagePrompt(prompt, ctx.designIntent), aspectRatio });
      const rawImgBuf = Buffer.from(imgResult.imageBytes, "base64");
      const optImg = await optimizeImage(rawImgBuf, imgResult.mimeType, { maxWidth: IMAGE_PRESETS.featured });
      const imgExt = optImg.mimeType === "image/webp" ? "webp" : optImg.mimeType === "image/png" ? "png" : "jpg";
      const imgFilename = promptToFilename(prompt, imgExt);
      const imgPath = `sites/${ctx.siteId}/media/${imgFilename}`;
      const imgUpload = await ctx.storage.upload(optImg.buffer, imgPath, optImg.mimeType, "public, max-age=604800");

      const imgAltText = prompt.length > 300 ? prompt.slice(0, 297) + "..." : prompt;
      const [mediaItem] = await db
        .insert(media)
        .values({
          siteId: ctx.siteId,
          filename: imgFilename,
          storageUrl: imgUpload.url,
          mimeType: optImg.mimeType,
          aiAltText: imgAltText,
          uploadedBy: null,
        })
        .returning();

      let prevContentSchema: Record<string, unknown> | null = null;
      if (contentId) {
        const [target] = await db.select().from(content).where(eq(content.id, contentId));
        if (target && target.siteId === ctx.siteId) {
          prevContentSchema = (target.schemaData ?? {}) as Record<string, unknown>;
          const schema = { ...prevContentSchema, featuredImage: imgUpload.url };
          await db.update(content).set({ schemaData: schema, updatedAt: new Date() }).where(eq(content.id, contentId));
        }
      }

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "image",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `GENERATE_IMAGE: ${prompt.slice(0, 100)}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "GENERATE_IMAGE",
          entityType: "media",
          entityId: mediaItem.id,
          previousState: {
            storagePath: imgPath,
            storageUrl: imgUpload.url,
            featuredImageContentId: contentId ?? null,
            prevContentSchema,
          },
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Generated image and saved to media library${contentId ? " — set as featured image" : ""}. URL: ${imgUpload.url}`,
        is_error: false,
        action: {
          type: "GENERATE_IMAGE",
          status: "success",
          result: { url: imgUpload.url, mediaId: mediaItem.id, contentId },
          historyId: historyRow.id,
        },
      };
    },
  },

  delete_media: {
    actionType: "DELETE_MEDIA",
    definition: {
      name: "delete_media",
      description: "Delete a media item from the library. Refused if the image is still referenced by content (use list_media or search first to check). Undo restores the row — the underlying file is preserved in storage.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Media id (UUID)" },
        },
        required: ["id"],
      },
    },
    handler: async (ctx, input) => {
      const { id } = input as { id?: string };
      if (!id) {
        return errorOutcome("DELETE_MEDIA", "id is required");
      }

      const [existing] = await db.select().from(media).where(eq(media.id, id));
      if (!existing || existing.siteId !== ctx.siteId) {
        return errorOutcome("DELETE_MEDIA", "Media not found");
      }

      const refs = await db
        .select({ contentId: contentMedia.contentId })
        .from(contentMedia)
        .where(eq(contentMedia.mediaId, id));
      if (refs.length > 0) {
        return errorOutcome(
          "DELETE_MEDIA",
          `Media is in use by ${refs.length} content item${refs.length === 1 ? "" : "s"} — remove it from content first`,
        );
      }

      await db.delete(media).where(eq(media.id, id));

      await db.insert(auditLog).values({
        siteId: ctx.siteId,
        actorType: "ai",
        action: "media.deleted",
        entityType: "media",
        entityId: id,
        details: { filename: existing.filename },
      });

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `DELETE_MEDIA on media:${id}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "DELETE_MEDIA",
          entityType: "media",
          entityId: id,
          previousState: {
            filename: existing.filename,
            storageUrl: existing.storageUrl,
            mimeType: existing.mimeType,
            variants: existing.variants,
            aiAltText: existing.aiAltText,
            aiTags: existing.aiTags,
            uploadedBy: existing.uploadedBy,
            createdAt: existing.createdAt.toISOString(),
          },
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Deleted media "${existing.filename}".`,
        is_error: false,
        action: {
          type: "DELETE_MEDIA",
          status: "success",
          result: { id, filename: existing.filename },
          historyId: historyRow.id,
        },
      };
    },
  },

  update_header: {
    actionType: "UPDATE_HEADER",
    minRole: "admin", // site-wide layout; mirrors sites-settings REST (admin/owner)
    definition: {
      name: "update_header",
      description: "Edit the site header's HTML and/or its editable field values. Call read_header_footer first to see wired fields and current HTML. To change header menu items (nav links), use update_navigation with location 'header' — not this tool.",
      input_schema: headerFooterInputSchema("header"),
    },
    handler: async (ctx, input) => applyHeaderFooterUpdate(ctx, input, "header"),
  },

  update_footer: {
    actionType: "UPDATE_FOOTER",
    minRole: "admin", // site-wide layout; mirrors sites-settings REST (admin/owner)
    definition: {
      name: "update_footer",
      description: "Edit the site footer's HTML and/or its editable field values. Call read_header_footer first to see wired fields and current HTML. To change footer menu items (nav links), use update_navigation with location 'footer' — not this tool.",
      input_schema: headerFooterInputSchema("footer"),
    },
    handler: async (ctx, input) => applyHeaderFooterUpdate(ctx, input, "footer"),
  },

  create_content: {
    actionType: "CREATE_CONTENT",
    definition: {
      name: "create_content",
      description: "Create a new page or post. For blog posts, always include metaDescription and featuredImagePrompt in the same call — an AI image will be generated and set as the featured image. For designed pages (marketing pages with real visual polish), use design_page instead.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", description: "'page' or 'post'" },
          slug: { type: "string", description: "URL-friendly slug (lowercase, hyphens, no spaces)" },
          title: { type: "string", description: "Display title" },
          status: { type: "string", description: "'draft' (default) or 'published'" },
          metaDescription: { type: "string", description: "SEO meta description (150-160 chars recommended)" },
          featuredImagePrompt: { type: "string", description: "Detailed prompt for the AI-generated featured image. Omit if no featured image is wanted." },
          blocks: {
            type: "array",
            description: "Content blocks. Break long content into multiple blocks (one per section). Supported shapes: text — [{\"blockType\":\"text\",\"data\":{\"content\":\"<HTML>\"}}] for prose with headings, lists, paragraphs (no tables); html — [{\"blockType\":\"html\",\"data\":{\"html\":\"<HTML>\",\"sectionName\":\"...\"}}] for any markup the text block can't represent (tables, custom layouts). The 'html' field is required on html blocks; do not use 'content' for html blocks.",
            items: {
              type: "object",
              properties: {
                blockType: { type: "string" },
                data: { type: "object" },
              },
              required: ["blockType", "data"],
            },
          },
        },
        required: ["type", "slug", "title"],
      },
    },
    handler: async (ctx, input) => {
      const { type, slug, title, status, metaDescription, featuredImagePrompt } = input as {
        type?: string;
        slug?: string;
        title?: string;
        status?: string;
        metaDescription?: string;
        featuredImagePrompt?: string;
      };
      const blocks = coerceBlocks((input as Record<string, unknown>).blocks);
      if (!type || !slug || !title) {
        return errorOutcome("CREATE_CONTENT", "type, slug, and title are required");
      }
      if (blocks) {
        const shapeError = validateBlockShapes(blocks);
        if (shapeError) return errorOutcome("CREATE_CONTENT", shapeError);
      }

      // Feature gate: free-tier content count limits
      if (type === "page" || type === "post") {
        const gate = await checkFeatureGate(ctx.siteId, type === "page" ? "page_count" : "post_count");
        if (!gate.allowed) return errorOutcome("CREATE_CONTENT", gate.reason ?? `${type} limit reached on the free plan`);
      }

      const schemaDataObj: Record<string, unknown> = { title };
      if (metaDescription) schemaDataObj.metaDescription = metaDescription;

      const item = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(content)
          .values({
            siteId: ctx.siteId,
            type,
            slug,
            status: status || "draft",
            schemaData: schemaDataObj,
            createdBy: null,
            publishedAt: status === "published" ? new Date() : null,
          })
          .returning();

        if (blocks && blocks.length) {
          await tx.insert(contentBlocks).values(
            blocks.map((block, i) => ({
              contentId: created.id,
              position: i,
              blockType: block.blockType,
              data: (block.data ?? {}) as Record<string, unknown>,
            })),
          );
        }

        await tx.insert(contentVersions).values({
          contentId: created.id,
          version: 1,
          schemaData: created.schemaData,
          blocksSnapshot: blocks ?? [],
        });

        await tx.insert(auditLog).values({
          siteId: ctx.siteId,
          actorType: "ai",
          action: "content.created",
          entityType: "content",
          entityId: created.id,
          details: { type, slug, status: created.status },
        });

        return created;
      });

      let featuredImageUrl: string | undefined;
      if (featuredImagePrompt && ctx.router && ctx.storage) {
        try {
          const imgResult = await ctx.router.generateImage({ prompt: enrichImagePrompt(featuredImagePrompt, ctx.designIntent), aspectRatio: "16:9" });
          const rawImgBuffer = Buffer.from(imgResult.imageBytes, "base64");
          const optImg = await optimizeImage(rawImgBuffer, imgResult.mimeType, { maxWidth: IMAGE_PRESETS.featured });
          const imgExt = optImg.mimeType === "image/webp" ? "webp" : optImg.mimeType === "image/png" ? "png" : "jpg";
          const imgFilename = promptToFilename(featuredImagePrompt, imgExt);
          const imgPath = `sites/${ctx.siteId}/media/${imgFilename}`;
          const imgUpload = await ctx.storage.upload(optImg.buffer, imgPath, optImg.mimeType, "public, max-age=604800");
          featuredImageUrl = imgUpload.url;

          const imgAlt = featuredImagePrompt.length > 300 ? featuredImagePrompt.slice(0, 297) + "..." : featuredImagePrompt;
          await db.insert(media).values({
            siteId: ctx.siteId,
            filename: imgFilename,
            storageUrl: imgUpload.url,
            mimeType: optImg.mimeType,
            aiAltText: imgAlt,
            uploadedBy: null,
          });

          const updatedSchema = { ...schemaDataObj, featuredImage: featuredImageUrl };
          await db.update(content).set({ schemaData: updatedSchema, updatedAt: new Date() }).where(eq(content.id, item.id));
        } catch (imgErr) {
          console.warn("Failed to generate featured image for new content:", imgErr);
        }
      }

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `CREATE_CONTENT ${type}:${slug}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "CREATE_CONTENT",
          entityType: "content",
          entityId: item.id,
          previousState: null,
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Created ${type} "${title}" (status: ${item.status}, id: ${item.id})${featuredImageUrl ? " with generated featured image" : ""}.`,
        is_error: false,
        action: {
          type: "CREATE_CONTENT",
          status: "success",
          result: { id: item.id, type: item.type, slug: item.slug, title, status: item.status, featuredImage: featuredImageUrl, metaDescription },
          historyId: historyRow.id,
        },
      };
    },
  },

  update_content: {
    actionType: "UPDATE_CONTENT",
    definition: {
      name: "update_content",
      description: "Update an existing page or post. Provide the content id plus any of title, status, metaDescription, or blocks. Blocks replace all existing blocks — call read_content first to see the current structure.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Content id (UUID) of the page or post to update" },
          title: { type: "string", description: "New display title" },
          status: { type: "string", description: "New status: 'draft', 'published', or 'archived'" },
          metaDescription: { type: "string", description: "SEO meta description (150-160 chars recommended)" },
          blocks: {
            type: "array",
            description: "Complete ordered list of blocks to replace current blocks. Omit to leave blocks unchanged. Supported shapes: text — {\"blockType\":\"text\",\"data\":{\"content\":\"<HTML>\"}} for prose; html — {\"blockType\":\"html\",\"data\":{\"html\":\"<HTML>\",\"sectionName\":\"...\"}} for tables or custom markup. The 'html' field is required on html blocks; do not use 'content' for html blocks.",
            items: {
              type: "object",
              properties: {
                blockType: { type: "string", description: "Block type: 'text' or 'html'" },
                data: { type: "object", description: "Block data. text: {content}; html: {html, sectionName?}" },
              },
              required: ["blockType", "data"],
            },
          },
        },
        required: ["id"],
      },
    },
    handler: async (ctx, input) => {
      const { id, title, status, metaDescription } = input as {
        id?: string;
        title?: string;
        status?: string;
        metaDescription?: string;
      };
      const rawBlocks = (input as Record<string, unknown>).blocks;
      const blocks = coerceBlocks(rawBlocks);
      if (!id) {
        return errorOutcome("UPDATE_CONTENT", "id is required");
      }
      if (title === undefined && status === undefined && metaDescription === undefined && rawBlocks === undefined) {
        return errorOutcome("UPDATE_CONTENT", "Provide at least one of title, status, metaDescription, or blocks");
      }
      if (blocks) {
        const shapeError = validateBlockShapes(blocks);
        if (shapeError) return errorOutcome("UPDATE_CONTENT", shapeError);
      }

      const [existing] = await db.select().from(content).where(eq(content.id, id));
      if (!existing || existing.siteId !== ctx.siteId) {
        return errorOutcome("UPDATE_CONTENT", "Content not found");
      }

      const prevBlocks = await db
        .select({ position: contentBlocks.position, blockType: contentBlocks.blockType, data: contentBlocks.data })
        .from(contentBlocks)
        .where(eq(contentBlocks.contentId, id))
        .orderBy(contentBlocks.position);
      const prevSchemaData = (existing.schemaData ?? {}) as Record<string, unknown>;
      const prevStatus = existing.status;
      const blocksReplaced = Array.isArray(blocks) && blocks.length > 0;

      const nextSchema: Record<string, unknown> = { ...prevSchemaData };
      if (title !== undefined) nextSchema.title = title;
      if (metaDescription !== undefined) nextSchema.metaDescription = metaDescription;

      await db.transaction(async (tx) => {
        const updates: Record<string, unknown> = { schemaData: nextSchema, updatedAt: new Date() };
        if (status !== undefined) updates.status = status;
        await tx.update(content).set(updates).where(eq(content.id, id));

        if (blocksReplaced) {
          await tx.delete(contentBlocks).where(eq(contentBlocks.contentId, id));
          await tx.insert(contentBlocks).values(
            blocks!.map((block, i) => ({
              contentId: id,
              position: i,
              blockType: block.blockType,
              data: (block.data ?? {}) as Record<string, unknown>,
            })),
          );
        }

        await tx.insert(auditLog).values({
          siteId: ctx.siteId,
          actorType: "ai",
          action: "content.updated",
          entityType: "content",
          entityId: id,
          details: {
            titleChanged: title !== undefined,
            statusChanged: status !== undefined,
            metaDescriptionChanged: metaDescription !== undefined,
            blocksReplaced,
          },
        });
      });

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `UPDATE_CONTENT on content:${id}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "UPDATE_CONTENT",
          entityType: "content",
          entityId: id,
          previousState: {
            schemaData: prevSchemaData,
            status: prevStatus,
            blocks: prevBlocks,
            blocksReplaced,
          },
        })
        .returning({ id: aiHistory.id });

      const changed: string[] = [];
      if (title !== undefined) changed.push("title");
      if (status !== undefined) changed.push("status");
      if (metaDescription !== undefined) changed.push("metaDescription");
      if (blocksReplaced) changed.push(`${blocks!.length} blocks`);

      return {
        content: `Updated ${existing.type} "${(nextSchema.title ?? existing.slug) as string}" (${changed.join(", ")}).`,
        is_error: false,
        action: {
          type: "UPDATE_CONTENT",
          status: "success",
          result: {
            id,
            type: existing.type,
            slug: existing.slug,
            title: nextSchema.title ?? prevSchemaData.title,
            status: status ?? prevStatus,
            metaDescription: nextSchema.metaDescription,
          },
          historyId: historyRow.id,
        },
      };
    },
  },

  delete_content: {
    actionType: "DELETE_CONTENT",
    definition: {
      name: "delete_content",
      description: "Delete a page or post. Use list_content first to find the id. Undo restores the content, its blocks, and its collection/media links.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Content id (UUID)" },
        },
        required: ["id"],
      },
    },
    handler: async (ctx, input) => {
      const { id } = input as { id?: string };
      if (!id) {
        return errorOutcome("DELETE_CONTENT", "id is required");
      }

      const [existing] = await db.select().from(content).where(eq(content.id, id));
      if (!existing || existing.siteId !== ctx.siteId) {
        return errorOutcome("DELETE_CONTENT", "Content not found");
      }

      const blocks = await db
        .select({ position: contentBlocks.position, blockType: contentBlocks.blockType, data: contentBlocks.data })
        .from(contentBlocks)
        .where(eq(contentBlocks.contentId, id));
      const collectionLinks = await db
        .select({ collectionId: contentCollections.collectionId })
        .from(contentCollections)
        .where(eq(contentCollections.contentId, id));
      const mediaLinks = await db
        .select({ mediaId: contentMedia.mediaId, context: contentMedia.context })
        .from(contentMedia)
        .where(eq(contentMedia.contentId, id));

      // Cascade FKs remove blocks, versions, content_collections, content_media.
      await db.delete(content).where(eq(content.id, id));

      await db.insert(auditLog).values({
        siteId: ctx.siteId,
        actorType: "ai",
        action: "content.deleted",
        entityType: "content",
        entityId: id,
        details: { type: existing.type, slug: existing.slug },
      });

      const title = (existing.schemaData as Record<string, unknown> | null)?.title as string | undefined;
      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `DELETE_CONTENT on content:${id}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "DELETE_CONTENT",
          entityType: "content",
          entityId: id,
          previousState: {
            type: existing.type,
            slug: existing.slug,
            status: existing.status,
            schemaData: existing.schemaData,
            createdBy: existing.createdBy,
            publishedAt: existing.publishedAt?.toISOString() ?? null,
            createdAt: existing.createdAt.toISOString(),
            blocks,
            collectionIds: collectionLinks.map((l) => l.collectionId),
            mediaLinks,
          },
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Deleted ${existing.type} "${title ?? existing.slug}".`,
        is_error: false,
        action: {
          type: "DELETE_CONTENT",
          status: "success",
          result: { id, type: existing.type, slug: existing.slug, title },
          historyId: historyRow.id,
        },
      };
    },
  },

  set_metadata: {
    actionType: "SET_METADATA",
    definition: {
      name: "set_metadata",
      description: "Set the meta description (for search engines) and/or featured image URL on a page or post. Meta descriptions should be 150-160 characters, compelling, and include relevant keywords.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Content id (UUID) of the page or post" },
          metaDescription: { type: "string", description: "SEO meta description (150-160 chars recommended)" },
          featuredImage: { type: "string", description: "Featured image URL (absolute URL to a media item)" },
        },
        required: ["id"],
      },
    },
    handler: async (ctx, input) => {
      const { id, metaDescription, featuredImage } = input as {
        id?: string;
        metaDescription?: string;
        featuredImage?: string;
      };

      if (!id) {
        return errorOutcome("SET_METADATA", "id is required");
      }
      if (metaDescription === undefined && featuredImage === undefined) {
        return errorOutcome("SET_METADATA", "Provide metaDescription and/or featuredImage");
      }

      const [item] = await db.select().from(content).where(eq(content.id, id));
      if (!item || item.siteId !== ctx.siteId) {
        return errorOutcome("SET_METADATA", "Content not found");
      }

      const prevSchema = (item.schemaData ?? {}) as Record<string, unknown>;
      const updatedSchema: Record<string, unknown> = { ...prevSchema };
      if (metaDescription !== undefined) updatedSchema.metaDescription = metaDescription;
      if (featuredImage !== undefined) updatedSchema.featuredImage = featuredImage;

      await db
        .update(content)
        .set({ schemaData: updatedSchema, updatedAt: new Date() })
        .where(eq(content.id, id));

      await db.insert(auditLog).values({
        siteId: ctx.siteId,
        actorType: "ai",
        action: "content.metadata_updated",
        entityType: "content",
        entityId: id,
        details: {
          metaDescriptionChanged: metaDescription !== undefined,
          featuredImageChanged: featuredImage !== undefined,
        },
      });

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "seo",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `SET_METADATA on content:${id}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "SET_METADATA",
          entityType: "content",
          entityId: id,
          previousState: { schemaData: prevSchema },
        })
        .returning({ id: aiHistory.id });

      return {
        content: `Updated metadata on content ${id}.`,
        is_error: false,
        action: {
          type: "SET_METADATA",
          status: "success",
          result: {
            id,
            title: updatedSchema.title,
            metaDescription,
            featuredImage,
          },
          historyId: historyRow.id,
        },
      };
    },
  },

  update_html_block: {
    actionType: "UPDATE_HTML_BLOCK",
    definition: {
      name: "update_html_block",
      description: "Surgically replace the HTML of a single existing block on a page. Use this for targeted edits — wiring up a search bar, swapping a CTA, fixing a heading — instead of update_content (which replaces every block on the page and can lose other sections). Get the blockId from read_content. Only works on blocks with blockType=\"html\".",
      input_schema: {
        type: "object",
        properties: {
          blockId: { type: "string", description: "Block id (UUID) from read_content. Must be an html block." },
          html: { type: "string", description: "Replacement HTML for the block." },
          sectionName: { type: "string", description: "Optional human-readable section label, e.g. 'Search Bar'. Omit to keep existing." },
        },
        required: ["blockId", "html"],
      },
    },
    handler: async (ctx, input) => {
      const { blockId, html, sectionName } = input as { blockId?: string; html?: string; sectionName?: string };
      if (!blockId || typeof html !== "string") {
        return errorOutcome("UPDATE_HTML_BLOCK", "blockId and html are required");
      }

      const [block] = await db.select().from(contentBlocks).where(eq(contentBlocks.id, blockId));
      if (!block) {
        return errorOutcome("UPDATE_HTML_BLOCK", "Block not found");
      }
      if (block.blockType !== "html") {
        return errorOutcome("UPDATE_HTML_BLOCK", `Block ${blockId} is type "${block.blockType}", not "html". Use update_content to change block types.`);
      }

      const [parent] = await db.select().from(content).where(eq(content.id, block.contentId));
      if (!parent || parent.siteId !== ctx.siteId) {
        return errorOutcome("UPDATE_HTML_BLOCK", "Block does not belong to this site");
      }

      const prevData = (block.data ?? {}) as Record<string, unknown>;
      // Strip script/event-handler/javascript: payloads before storing — the AI
      // is editor-reachable, so an editor could otherwise prompt it to inject XSS.
      const nextData: Record<string, unknown> = { ...prevData, html: sanitizeHtmlBlock(html) };
      if (sectionName !== undefined) nextData.sectionName = sectionName;

      await db.transaction(async (tx) => {
        await tx.update(contentBlocks).set({ data: nextData }).where(eq(contentBlocks.id, blockId));
        await tx.update(content).set({ updatedAt: new Date() }).where(eq(content.id, block.contentId));
        await tx.insert(auditLog).values({
          siteId: ctx.siteId,
          actorType: "ai",
          action: "content.block.updated",
          entityType: "content_block",
          entityId: blockId,
          details: { contentId: block.contentId, blockType: "html", sectionNameChanged: sectionName !== undefined },
        });
      });

      const [historyRow] = await db
        .insert(aiHistory)
        .values({
          siteId: ctx.siteId,
          turnId: ctx.turnId,
          taskType: "copywriting",
          action: `chat: ${ctx.message.slice(0, 200)}`,
          suggestion: `UPDATE_HTML_BLOCK on content_block:${blockId}`,
          model: ctx.model,
          usedFallback: ctx.usedFallback ? 1 : 0,
          actionType: "UPDATE_HTML_BLOCK",
          entityType: "content_block",
          entityId: blockId,
          previousState: {
            contentId: block.contentId,
            html: prevData.html ?? "",
            sectionName: prevData.sectionName ?? null,
          },
        })
        .returning({ id: aiHistory.id });

      const label = (nextData.sectionName as string | undefined) ?? `block ${blockId.slice(0, 8)}`;
      return {
        content: `Updated html block "${label}" on ${parent.type} "${(parent.schemaData as Record<string, unknown> | null)?.title ?? parent.slug}".`,
        is_error: false,
        action: {
          type: "UPDATE_HTML_BLOCK",
          status: "success",
          result: {
            blockId,
            contentId: block.contentId,
            sectionName: nextData.sectionName ?? null,
          },
          historyId: historyRow.id,
        },
      };
    },
  },

  update_design_intent: {
    actionType: "UPDATE_DESIGN_INTENT",
    minRole: "admin", // changes the whole site's design direction; mirrors theme/header/footer
    definition: {
      name: "update_design_intent",
      description:
        "Update the site's persistent design intent — the global design direction every future page and edit must follow. Call this ONLY when the user expresses a GLOBAL direction change that should stick site-wide (e.g. 'make the whole site bolder and darker', 'shift our tone to playful', 'we're repositioning as premium'). Do NOT call it for a one-off edit to a single section — just make that edit. Pass only the fields that change; omitted fields are preserved. After updating the intent, also apply the change to the current page so the user sees it immediately.",
      input_schema: {
        type: "object",
        properties: {
          aestheticDirection: { type: "string", description: "Overall executed look, 1–2 sentences." },
          voiceAndTone: { type: "string", description: "Copy voice and tone, as a phrase." },
          layoutPrinciples: { type: "string", description: "Section rhythm, composition, spacing, dark/light usage." },
          imageryStyle: { type: "string", description: "Photographic vs illustrated, mood, subject, treatment." },
          colorAndType: { type: "string", description: "How color and type are used (accent usage, heading treatment)." },
          positioning: { type: "string", description: "Differentiators/positioning to reinforce in copy. Empty string to clear." },
          constraints: { type: "array", items: { type: "string" }, description: "Hard requirements/prohibitions that every edit must obey. Replaces the existing list." },
        },
      },
    },
    handler: async (ctx, input) => {
      const patch = input as Partial<DesignIntent>;
      const hasField =
        DESIGN_INTENT_TEXT_FIELDS.some((f) => typeof patch[f] === "string" && (patch[f] as string).trim()) ||
        typeof patch.positioning === "string" ||
        Array.isArray(patch.constraints);
      if (!hasField) {
        return errorOutcome("UPDATE_DESIGN_INTENT", "Provide at least one design-intent field to update.");
      }

      const [siteRow] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, ctx.siteId));
      if (!siteRow) {
        return errorOutcome("UPDATE_DESIGN_INTENT", "Site not found");
      }
      const siteSettings = (siteRow.settings ?? {}) as Record<string, unknown>;
      const existing = siteSettings.designIntent as DesignIntent | undefined;
      const next = mergeDesignIntent(existing, patch, "refined");

      await db.transaction(async (tx) => {
        await tx
          .update(sites)
          .set({ settings: { ...siteSettings, designIntent: next }, updatedAt: new Date() })
          .where(eq(sites.id, ctx.siteId));
        await tx.insert(auditLog).values({
          siteId: ctx.siteId,
          actorType: "ai",
          action: "site.design_intent_updated",
          entityType: "site",
          entityId: ctx.siteId,
          details: {
            source: "refined",
            version: next.version,
            fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined),
          },
        });
      });

      const historyId = await (async () => {
        const [historyRow] = await db
          .insert(aiHistory)
          .values({
            siteId: ctx.siteId,
            turnId: ctx.turnId,
            taskType: "copywriting",
            action: `chat: ${ctx.message.slice(0, 200)}`,
            suggestion: `UPDATE_DESIGN_INTENT (v${next.version})`,
            model: ctx.model,
            usedFallback: ctx.usedFallback ? 1 : 0,
            actionType: "UPDATE_DESIGN_INTENT",
            entityType: "site",
            entityId: ctx.siteId,
            previousState: existing ? (existing as unknown as Record<string, unknown>) : null,
          })
          .returning({ id: aiHistory.id });
        return historyRow.id;
      })();

      return {
        content: `Updated the site's design intent (now v${next.version}). Future pages and edits will follow this direction. Apply the change to the current page now so the user sees it.`,
        is_error: false,
        action: {
          type: "UPDATE_DESIGN_INTENT",
          status: "success",
          result: { version: next.version, source: next.source },
          historyId,
        },
      };
    },
  },
};

/** Derive a short, filesystem-safe filename from an image generation prompt. */
function promptToFilename(prompt: string, ext: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
  return `${slug || "ai-image"}-${Date.now()}.${ext}`;
}

function errorOutcome(type: string, error: string): WriteToolOutcome {
  return {
    content: `Error: ${error}`,
    is_error: true,
    action: { type, status: "error", error },
  };
}

function headerFooterInputSchema(which: "header" | "footer"): AITool["input_schema"] {
  return {
    type: "object",
    properties: {
      html: {
        type: "string",
        description: `Replacement HTML for the ${which}. Preserve existing classes, structure, and data-cadmus-field markers — they are what makes fields editable. Removing a data-cadmus-field marker from the HTML prunes its editableFields entry automatically.`,
      },
      editableFields: {
        type: "object",
        description: `Patches to existing wired field VALUES (keyed by field id). CANNOT add, remove, hide, or reorder elements. Only ids marked wired in read_header_footer can be patched — unwired ids are rejected. Each value is an object like {"value": "new value"} where value's type depends on the field (text, image url, or link href).`,
        additionalProperties: {
          type: "object",
          properties: {
            value: {},
          },
        },
      },
    },
  };
}

async function applyHeaderFooterUpdate(
  ctx: WriteToolContext,
  input: Record<string, unknown>,
  which: "header" | "footer",
): Promise<WriteToolOutcome> {
  const actionType = which === "header" ? "UPDATE_HEADER" : "UPDATE_FOOTER";
  const { html: rawHtml, editableFields } = input as {
    html?: string;
    editableFields?: Record<string, Partial<HtmlBlockEditableField>>;
  };

  // Sanitize once up front so the stored value and all marker checks below use
  // the cleaned HTML (data-cadmus-field markers are preserved by the sanitizer).
  const html = rawHtml === undefined ? undefined : sanitizeHtmlBlock(rawHtml);

  if (html === undefined && !editableFields) {
    return errorOutcome(actionType, "html or editableFields is required");
  }

  const [siteRow] = await db.select().from(sites).where(eq(sites.id, ctx.siteId));
  if (!siteRow) {
    return errorOutcome(actionType, "Site not found");
  }

  const siteSettings = (siteRow.settings ?? {}) as Record<string, unknown>;
  const currentTheme = (siteSettings.theme ?? {}) as SiteTheme;
  const htmlKey = which === "header" ? "headerHtml" : "footerHtml";
  const fieldsKey = which === "header" ? "headerEditableFields" : "footerEditableFields";
  const prevHtml = currentTheme[htmlKey];
  const prevFields = currentTheme[fieldsKey];

  const nextTheme: SiteTheme = { ...currentTheme };
  const nextFields: Record<string, HtmlBlockEditableField> = {
    ...(currentTheme[fieldsKey] ?? {}),
  };

  let appliedFieldCount = 0;
  const unknownFieldIds: string[] = [];
  const unwiredFieldIds: string[] = [];

  const effectiveHtml = html ?? currentTheme[htmlKey] ?? "";

  if (editableFields) {
    for (const [id, patch] of Object.entries(editableFields)) {
      const existing = nextFields[id];
      if (!existing) {
        unknownFieldIds.push(id);
        continue;
      }
      if (!effectiveHtml.includes(`data-cadmus-field="${id}"`)) {
        unwiredFieldIds.push(id);
        continue;
      }
      nextFields[id] = { ...existing, ...patch };
      appliedFieldCount++;
    }
  }

  if (html === undefined && appliedFieldCount === 0) {
    const currentHtml = currentTheme[htmlKey] ?? "";
    const wiredIds = Object.keys(currentTheme[fieldsKey] ?? {})
      .filter((id) => currentHtml.includes(`data-cadmus-field="${id}"`));
    const problems: string[] = [];
    if (unknownFieldIds.length) {
      problems.push(`unknown id${unknownFieldIds.length > 1 ? "s" : ""}: ${unknownFieldIds.map((i) => `"${i}"`).join(", ")}`);
    }
    if (unwiredFieldIds.length) {
      problems.push(`unwired id${unwiredFieldIds.length > 1 ? "s" : ""} (no data-cadmus-field marker in HTML — editableFields cannot change these; edit html instead): ${unwiredFieldIds.map((i) => `"${i}"`).join(", ")}`);
    }
    const hint = wiredIds.length
      ? ` Wired ${which} field IDs (editableFields works on these): ${wiredIds.map((i) => `"${i}"`).join(", ")}. To add/remove/restructure elements (including deleting a link), edit "html" instead.`
      : ` This ${which} has no wired editable fields. To change it, edit "html".`;
    const base = problems.length
      ? `No changes applied — ${problems.join("; ")}.`
      : `No changes provided. Include "html" or "editableFields" with at least one valid wired field.`;
    return errorOutcome(actionType, `${base}${hint}`);
  }

  if (html !== undefined) {
    nextTheme[htmlKey] = html;
    for (const id of Object.keys(nextFields)) {
      if (!html.includes(`data-cadmus-field="${id}"`)) {
        delete nextFields[id];
      }
    }
  }

  nextTheme[fieldsKey] = nextFields;

  await db
    .update(sites)
    .set({
      settings: { ...siteSettings, theme: nextTheme },
      updatedAt: new Date(),
    })
    .where(eq(sites.id, ctx.siteId));

  await db.insert(auditLog).values({
    siteId: ctx.siteId,
    actorType: "ai",
    action: `${which}.updated`,
    entityType: "site",
    entityId: ctx.siteId,
    details: {
      htmlChanged: html !== undefined,
      fieldsChanged: appliedFieldCount,
      unknownFieldIds,
      unwiredFieldIds,
      fieldCount: Object.keys(nextFields).length,
    },
  });

  const [historyRow] = await db
    .insert(aiHistory)
    .values({
      siteId: ctx.siteId,
      turnId: ctx.turnId,
      taskType: "copywriting",
      action: `chat: ${ctx.message.slice(0, 200)}`,
      suggestion: `${actionType} on site:${ctx.siteId}`,
      model: ctx.model,
      usedFallback: ctx.usedFallback ? 1 : 0,
      actionType,
      entityType: "site",
      entityId: ctx.siteId,
      previousState: { which, html: prevHtml ?? null, editableFields: prevFields ?? null },
    })
    .returning({ id: aiHistory.id });

  return {
    content: `Updated ${which}: ${html !== undefined ? "html replaced" : ""}${html !== undefined && appliedFieldCount ? "; " : ""}${appliedFieldCount ? `${appliedFieldCount} field${appliedFieldCount === 1 ? "" : "s"} patched` : ""}.${unknownFieldIds.length ? ` Unknown ids skipped: ${unknownFieldIds.join(", ")}.` : ""}${unwiredFieldIds.length ? ` Unwired ids skipped (edit html instead): ${unwiredFieldIds.join(", ")}.` : ""}`,
    is_error: false,
    action: {
      type: actionType,
      status: "success",
      result: {
        which,
        htmlChanged: html !== undefined,
        fieldsChanged: appliedFieldCount,
        ...(unknownFieldIds.length ? { unknownFieldIds } : {}),
        ...(unwiredFieldIds.length ? { unwiredFieldIds } : {}),
      },
      historyId: historyRow.id,
    },
  };
}

tools.invite_team_member = {
  actionType: "INVITE_TEAM_MEMBER",
  minRole: "admin", // mirrors team REST (requireRole admin/owner) — blocks editor self-escalation
  definition: {
    name: "invite_team_member",
    description: "Invite someone to the site team by email. They'll receive an email with an accept link. Call list_team first to avoid duplicate invites. Roles: editor (can create/edit content), viewer (read-only), admin (full site management).",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email address of the person to invite" },
        role: { type: "string", enum: ["admin", "editor", "viewer"], description: "Role to assign (editor is the default for contributors)" },
      },
      required: ["email", "role"],
    },
  },
  handler: async (ctx, input) => {
    const { email, role } = input as { email?: string; role?: string };
    if (!email || !role) return errorOutcome("INVITE_TEAM_MEMBER", "email and role are required");
    if (!["admin", "editor", "viewer"].includes(role)) return errorOutcome("INVITE_TEAM_MEMBER", "role must be admin, editor, or viewer");

    const [existingUser] = await db.select().from(users).where(eq(users.email, email));
    let targetUserId: string;
    let membershipId: string;
    let wasNewUser = false;

    if (existingUser) {
      targetUserId = existingUser.id;
      const [existingMember] = await db.select().from(siteMembers)
        .where(and(eq(siteMembers.userId, existingUser.id), eq(siteMembers.siteId, ctx.siteId)));
      if (existingMember?.status === "active") return errorOutcome("INVITE_TEAM_MEMBER", `${email} is already an active member`);
      if (existingMember?.status === "invited") return errorOutcome("INVITE_TEAM_MEMBER", `${email} has already been invited`);
      if (existingMember?.status === "removed") {
        const [updated] = await db.update(siteMembers)
          .set({ role, status: "invited", invitedAt: new Date(), joinedAt: null })
          .where(eq(siteMembers.id, existingMember.id)).returning();
        membershipId = updated.id;
      } else {
        const [created] = await db.insert(siteMembers)
          .values({ siteId: ctx.siteId, userId: targetUserId, role, status: "invited" }).returning();
        membershipId = created.id;
      }
    } else {
      const [newUser] = await db.insert(users).values({ email, role: "editor" }).returning();
      targetUserId = newUser.id;
      wasNewUser = true;
      const [created] = await db.insert(siteMembers)
        .values({ siteId: ctx.siteId, userId: targetUserId, role, status: "invited" }).returning();
      membershipId = created.id;
    }

    const inviteToken = randomBytes(32).toString("hex");
    await db.update(users).set({
      resetToken: inviteToken,
      resetTokenExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).where(eq(users.id, targetUserId));

    const [site] = await db.select({ name: sites.name }).from(sites).where(eq(sites.id, ctx.siteId));
    const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
    const acceptUrl = `https://${baseDomain}/admin/accept-invite?token=${inviteToken}`;
    const emailProvider = getEmailProvider();
    if (emailProvider) {
      emailProvider.send({
        to: email,
        from: `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`,
        subject: `You've been invited to ${site?.name || "a Cadmus site"}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem"><h2>You've been invited!</h2><p>You've been invited to join <strong>${site?.name || "a site"}</strong> on Cadmus as ${role === "admin" ? "an" : "a"} <strong>${role}</strong>.</p><p style="margin:1.5rem 0"><a href="${acceptUrl}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Accept Invitation</a></p><p style="color:#666;font-size:0.875rem">This invitation expires in 7 days.</p></div>`,
        text: `You've been invited to join ${site?.name || "a site"} on Cadmus as a ${role}.\n\nAccept your invitation: ${acceptUrl}\n\nThis invitation expires in 7 days.`,
      }).catch((err) => console.error("AI invite email failed:", err));
    }

    await db.insert(auditLog).values({
      siteId: ctx.siteId, actorType: "ai", action: "team.invited",
      entityType: "user", entityId: targetUserId, details: { email, role },
    });

    const [historyRow] = await db.insert(aiHistory).values({
      siteId: ctx.siteId, turnId: ctx.turnId, taskType: "copywriting",
      action: `chat: ${ctx.message.slice(0, 200)}`,
      suggestion: `INVITE_TEAM_MEMBER ${email} as ${role}`,
      model: ctx.model, usedFallback: ctx.usedFallback ? 1 : 0,
      actionType: "INVITE_TEAM_MEMBER", entityType: "site_member", entityId: membershipId,
      previousState: { email, role, wasNewUser, userId: targetUserId },
    }).returning({ id: aiHistory.id });

    return {
      content: `Invited ${email} as ${role}. Invite email sent.`,
      is_error: false,
      action: { type: "INVITE_TEAM_MEMBER", status: "success", result: { email, role, memberId: membershipId }, historyId: historyRow.id },
    };
  },
};

tools.change_team_role = {
  actionType: "CHANGE_TEAM_ROLE",
  minRole: "admin", // mirrors team REST (requireRole admin/owner) — blocks editor self-escalation
  definition: {
    name: "change_team_role",
    description: "Change the role of an existing team member. Call list_team first to get the memberId. Cannot change the owner's role.",
    input_schema: {
      type: "object",
      properties: {
        memberId: { type: "string", description: "The memberId from list_team" },
        role: { type: "string", enum: ["admin", "editor", "viewer"], description: "New role to assign" },
      },
      required: ["memberId", "role"],
    },
  },
  handler: async (ctx, input) => {
    const { memberId, role } = input as { memberId?: string; role?: string };
    if (!memberId || !role) return errorOutcome("CHANGE_TEAM_ROLE", "memberId and role are required");
    if (!["admin", "editor", "viewer"].includes(role)) return errorOutcome("CHANGE_TEAM_ROLE", "role must be admin, editor, or viewer");

    const [member] = await db.select().from(siteMembers)
      .where(and(eq(siteMembers.id, memberId), eq(siteMembers.siteId, ctx.siteId)));
    if (!member) return errorOutcome("CHANGE_TEAM_ROLE", "Member not found");
    if (member.role === "owner") return errorOutcome("CHANGE_TEAM_ROLE", "Cannot change the owner's role");

    const [memberUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, member.userId));
    const oldRole = member.role;

    await db.update(siteMembers).set({ role }).where(eq(siteMembers.id, memberId));

    await db.insert(auditLog).values({
      siteId: ctx.siteId, actorType: "ai", action: "team.role_changed",
      entityType: "user", entityId: member.userId, details: { oldRole, newRole: role },
    });

    const [historyRow] = await db.insert(aiHistory).values({
      siteId: ctx.siteId, turnId: ctx.turnId, taskType: "copywriting",
      action: `chat: ${ctx.message.slice(0, 200)}`,
      suggestion: `CHANGE_TEAM_ROLE ${memberUser?.email ?? memberId} from ${oldRole} to ${role}`,
      model: ctx.model, usedFallback: ctx.usedFallback ? 1 : 0,
      actionType: "CHANGE_TEAM_ROLE", entityType: "site_member", entityId: memberId,
      previousState: { oldRole, email: memberUser?.email },
    }).returning({ id: aiHistory.id });

    return {
      content: `Changed ${memberUser?.email ?? memberId}'s role from ${oldRole} to ${role}.`,
      is_error: false,
      action: { type: "CHANGE_TEAM_ROLE", status: "success", result: { memberId, email: memberUser?.email, oldRole, newRole: role }, historyId: historyRow.id },
    };
  },
};

tools.create_redirect = {
  actionType: "CREATE_REDIRECT",
  definition: {
    name: "create_redirect",
    description: "Create a URL redirect. Use this when the user renames a page or moves content to a new URL so the old URL doesn't break. Call list_redirects first to avoid duplicates.",
    input_schema: {
      type: "object",
      properties: {
        fromPath: { type: "string", description: "Source path that should redirect (must start with /)" },
        toUrl: { type: "string", description: "Destination URL or path (e.g. /new-page or https://example.com)" },
        statusCode: { type: "number", enum: [301, 302, 307, 308], description: "HTTP status code — 301 for permanent (default), 302 for temporary" },
      },
      required: ["fromPath", "toUrl"],
    },
  },
  handler: async (ctx, input) => {
    const { fromPath, toUrl, statusCode } = input as { fromPath?: string; toUrl?: string; statusCode?: number };
    if (!fromPath || !toUrl) return errorOutcome("CREATE_REDIRECT", "fromPath and toUrl are required");
    if (!fromPath.startsWith("/")) return errorOutcome("CREATE_REDIRECT", "fromPath must start with /");
    const code = [301, 302, 307, 308].includes(statusCode ?? 0) ? statusCode! : 301;

    const [existing] = await db.select({ id: redirects.id }).from(redirects)
      .where(and(eq(redirects.siteId, ctx.siteId), eq(redirects.fromPath, fromPath))).limit(1);
    if (existing) return errorOutcome("CREATE_REDIRECT", `A redirect for "${fromPath}" already exists`);

    const [row] = await db.insert(redirects).values({
      siteId: ctx.siteId, fromPath, toUrl, statusCode: code,
    }).returning();

    await db.insert(auditLog).values({
      siteId: ctx.siteId, actorType: "ai", action: "redirect.created",
      entityType: "redirect", entityId: row.id,
      details: { fromPath, toUrl, statusCode: code },
    });

    const [historyRow] = await db.insert(aiHistory).values({
      siteId: ctx.siteId, turnId: ctx.turnId, taskType: "copywriting",
      action: `chat: ${ctx.message.slice(0, 200)}`,
      suggestion: `CREATE_REDIRECT ${fromPath} → ${toUrl}`,
      model: ctx.model, usedFallback: ctx.usedFallback ? 1 : 0,
      actionType: "CREATE_REDIRECT", entityType: "redirect", entityId: row.id,
      previousState: null,
    }).returning({ id: aiHistory.id });

    return {
      content: `Created redirect: ${fromPath} → ${toUrl} [${code}]`,
      is_error: false,
      action: { type: "CREATE_REDIRECT", status: "success", result: { id: row.id, fromPath, toUrl, statusCode: code }, historyId: historyRow.id },
    };
  },
};

tools.delete_redirect = {
  actionType: "DELETE_REDIRECT",
  definition: {
    name: "delete_redirect",
    description: "Delete an existing URL redirect. Call list_redirects first to get the fromPath of the rule to remove.",
    input_schema: {
      type: "object",
      properties: {
        fromPath: { type: "string", description: "The source path of the redirect to delete (must match exactly)" },
      },
      required: ["fromPath"],
    },
  },
  handler: async (ctx, input) => {
    const { fromPath } = input as { fromPath?: string };
    if (!fromPath) return errorOutcome("DELETE_REDIRECT", "fromPath is required");

    const [existing] = await db.select().from(redirects)
      .where(and(eq(redirects.siteId, ctx.siteId), eq(redirects.fromPath, fromPath))).limit(1);
    if (!existing) return errorOutcome("DELETE_REDIRECT", `No redirect found for "${fromPath}"`);

    await db.delete(redirects).where(eq(redirects.id, existing.id));

    await db.insert(auditLog).values({
      siteId: ctx.siteId, actorType: "ai", action: "redirect.deleted",
      entityType: "redirect", entityId: existing.id,
      details: { fromPath, toUrl: existing.toUrl, statusCode: existing.statusCode },
    });

    const [historyRow] = await db.insert(aiHistory).values({
      siteId: ctx.siteId, turnId: ctx.turnId, taskType: "copywriting",
      action: `chat: ${ctx.message.slice(0, 200)}`,
      suggestion: `DELETE_REDIRECT ${fromPath}`,
      model: ctx.model, usedFallback: ctx.usedFallback ? 1 : 0,
      actionType: "DELETE_REDIRECT", entityType: "redirect", entityId: existing.id,
      previousState: { fromPath, toUrl: existing.toUrl, statusCode: existing.statusCode, enabled: existing.enabled },
    }).returning({ id: aiHistory.id });

    return {
      content: `Deleted redirect: ${fromPath} → ${existing.toUrl}`,
      is_error: false,
      action: { type: "DELETE_REDIRECT", status: "success", result: { fromPath, toUrl: existing.toUrl }, historyId: historyRow.id },
    };
  },
};

// All write-tool definitions, unfiltered. Prefer writeToolDefinitionsForRole()
// when handing tools to the model so privileged tools aren't even offered to
// lower roles.
export const writeToolDefinitions: AITool[] = Object.values(tools).map((t) => t.definition);

/** Tool definitions the given site role is permitted to use. */
export function writeToolDefinitionsForRole(role: SiteRole | undefined): AITool[] {
  return Object.values(tools)
    .filter((t) => roleMeets(role, t.minRole ?? "editor"))
    .map((t) => t.definition);
}

export function isWriteTool(name: string): boolean {
  return name in tools;
}

export async function executeWriteTool(
  name: string,
  input: Record<string, unknown>,
  ctx: WriteToolContext,
): Promise<WriteToolOutcome> {
  const tool = tools[name];
  if (!tool) {
    return errorOutcome(name, `Unknown write tool: ${name}`);
  }
  // Defense in depth: enforce the role gate even if the model somehow invokes a
  // tool it wasn't offered (e.g. a hallucinated/echoed name).
  const minRole = tool.minRole ?? "editor";
  if (!roleMeets(ctx.role, minRole)) {
    return errorOutcome(
      tool.actionType,
      `This action requires the "${minRole}" role or higher. Ask a site ${minRole} to do it.`,
    );
  }
  try {
    return await tool.handler(ctx, input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorOutcome(tool.actionType, `Tool "${name}" failed: ${msg}`);
  }
}
