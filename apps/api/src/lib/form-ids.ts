import { randomUUID } from "node:crypto";

/**
 * Ensure every form-bearing block has a stable `formId` in its data.
 * Mutates the blocks in place so form submissions can reference a form that
 * survives the "delete + reinsert" pattern used on every content save.
 *
 * - FormBlock: `data.formId`
 * - HtmlBlock containing a `<form>`: `data.formSettings.formId`
 */
export function ensureFormIds(
  blocks: Array<{ blockType: string; data?: unknown }>,
): void {
  for (const block of blocks) {
    if (!block.data || typeof block.data !== "object") continue;
    const data = block.data as Record<string, unknown>;

    if (block.blockType === "form") {
      if (typeof data.formId !== "string" || !data.formId) {
        data.formId = randomUUID();
      }
      continue;
    }

    if (block.blockType === "html") {
      const html = typeof data.html === "string" ? data.html : "";
      if (!/<form[\s>]/i.test(html)) continue;
      const fs = (data.formSettings as Record<string, unknown> | undefined) ?? {};
      if (typeof fs.formId !== "string" || !fs.formId) {
        fs.formId = randomUUID();
      }
      data.formSettings = fs;
    }
  }
}
