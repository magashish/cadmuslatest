import { eq } from "drizzle-orm";
import { db, content } from "@cadmus/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ArchivedRow {
  id: string;
  oldSlug: string;
  newSlug: string;
  type: string;
}

/**
 * Rename existing content slugs to `${slug}-old` (or `-old-2`, `-old-3`, ...)
 * and flip status to draft. Skips rows already suffixed with `-old` /
 * `-old-N`. Pass a transaction so this composes with the status flip on
 * the parent site row.
 */
export async function archiveContentForRestart(
  tx: Tx,
  siteId: string,
): Promise<ArchivedRow[]> {
  const rows = await tx
    .select({ id: content.id, slug: content.slug, type: content.type })
    .from(content)
    .where(eq(content.siteId, siteId));

  const taken = new Set(rows.map((r) => `${r.type}:${r.slug}`));
  const archived: ArchivedRow[] = [];

  for (const row of rows) {
    if (row.slug.endsWith("-old") || /-old-\d+$/.test(row.slug)) continue;
    let candidate = `${row.slug}-old`;
    let n = 2;
    while (taken.has(`${row.type}:${candidate}`)) {
      candidate = `${row.slug}-old-${n++}`;
    }
    taken.delete(`${row.type}:${row.slug}`);
    taken.add(`${row.type}:${candidate}`);

    await tx
      .update(content)
      .set({ slug: candidate, status: "draft", updatedAt: new Date() })
      .where(eq(content.id, row.id));
    archived.push({ id: row.id, oldSlug: row.slug, newSlug: candidate, type: row.type });
  }

  return archived;
}
