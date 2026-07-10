import type { AIRouter } from "../router.js";
import type { ContentBlock } from "@cadmus/shared";

const VALID_BLOCK_TYPES = new Set([
  "hero", "text", "heading", "image", "cta", "testimonial",
  "faq", "pricing", "gallery", "form", "video", "embed", "map",
]);

const SYSTEM_PROMPT = `You are a design-to-code converter. You receive HTML from a page design tool and must decompose it into a JSON array of content blocks matching our block schema.

Available block types and their variants:
- hero: centered, split, video-bg, image-bg — data: { headline, subheadline?, ctaText?, ctaUrl?, imageUrl?, videoUrl? }
- text: single-col, two-col, with-image — data: { content (HTML string), imageUrl?, imagePosition? ("left"|"right") }
- heading: default, with-subtitle, centered — data: { text, level (1-4), subtitle? }
- image: full-width, contained, rounded — data: { url, alt, caption? }
- cta: banner, inline, card — data: { headline, description?, buttonText, buttonUrl, secondaryButtonText?, secondaryButtonUrl? }
- testimonial: carousel, grid, single-feature — data: { items: [{ quote, name, title?, imageUrl?, rating? (1-5) }] }
- faq: accordion, two-col, simple — data: { items: [{ question, answer }] }
- pricing: cards, table, simple — data: { items: [{ name, price, period?, description?, features: string[], ctaText?, ctaUrl?, highlighted? }] }
- gallery: grid, masonry, carousel — data: { items: [{ url, alt, caption? }], columns? }
- form: contact, newsletter, custom — data: { fields: [{ name, type, label, required?, options? }], submitText, successMessage? }
- video: embed, full-width, contained — data: { url, title?, autoplay? }
- embed: default — data: { html }
- map: default, with-info, full-width — data: { address, lat?, lng?, zoom?, businessName?, phone?, hours? }

Rules:
1. Analyze the visual structure and content of the HTML to determine which blocks best represent each section
2. Choose the most appropriate variant for each block
3. Extract real text content from the HTML — do not use lorem ipsum
4. For images, use the src URLs from the HTML or descriptive placeholder URLs like "/images/hero.jpg"
5. Return ONLY a valid JSON array of block objects. No markdown fences, no explanation.
6. Order blocks top-to-bottom as they appear in the design
7. Every block must have blockType, variant, and data fields`;

export interface HtmlToBlocksOptions {
  html: string;
  pageType?: string;
}

export interface HtmlToBlocksResult {
  blocks: ContentBlock[];
  model: string;
  usedFallback: boolean;
}

export async function convertHtmlToBlocks(
  router: AIRouter,
  options: HtmlToBlocksOptions,
): Promise<HtmlToBlocksResult> {
  const { html, pageType } = options;

  let prompt = "Convert this HTML page design into our block schema:\n\n";
  prompt += html;
  if (pageType) {
    prompt += `\n\nThis is a ${pageType} page — choose blocks and variants appropriate for that page type.`;
  }

  const result = await router.generateText({
    task: "copywriting",
    systemPrompt: SYSTEM_PROMPT,
    prompt,
    temperature: 0.2,
    maxTokens: 4096,
  });

  const blocks = parseBlocksResponse(result.text);

  return {
    blocks,
    model: result.model,
    usedFallback: result.usedFallback,
  };
}

function parseBlocksResponse(text: string): ContentBlock[] {
  let jsonText = text.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${jsonText.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AI response is not an array of blocks");
  }

  // Validate and filter to known block types
  const blocks: ContentBlock[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.blockType === "string" &&
      VALID_BLOCK_TYPES.has(item.blockType) &&
      typeof item.variant === "string" &&
      item.data &&
      typeof item.data === "object"
    ) {
      blocks.push(item as ContentBlock);
    }
  }

  if (blocks.length === 0) {
    throw new Error("No valid blocks found in AI response");
  }

  return blocks;
}
