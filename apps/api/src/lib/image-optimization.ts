import sharp from "sharp";

export interface OptimizeOptions {
  /** Max width in pixels. Image is scaled down proportionally if wider. Default: 1920 */
  maxWidth?: number;
  /** Encoder quality 1-100. Default: 82 */
  quality?: number;
  /** Force output format. Default: "webp" (smaller than jpeg, supported everywhere we care about). */
  format?: "jpeg" | "png" | "webp";
}

export interface OptimizeResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

const FORMAT_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Optimize an image buffer: resize to max width and convert to JPEG (or specified format).
 * Skips non-image buffers and SVGs. Returns original buffer unchanged if processing fails.
 */
export async function optimizeImage(
  input: Buffer,
  inputMimeType: string,
  opts: OptimizeOptions = {},
): Promise<OptimizeResult> {
  const maxWidth = opts.maxWidth ?? 1920;
  const quality = opts.quality ?? 82;
  const format = opts.format ?? "webp";

  // Don't process SVGs or non-images
  if (!inputMimeType.startsWith("image/") || inputMimeType === "image/svg+xml") {
    return { buffer: input, mimeType: inputMimeType, width: 0, height: 0 };
  }

  const image = sharp(input);
  const metadata = await image.metadata();
  const origWidth = metadata.width ?? 0;
  const origHeight = metadata.height ?? 0;

  let pipeline = image;

  // Only resize if wider than max
  if (origWidth > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  }

  // Convert format
  if (format === "jpeg") {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  } else if (format === "webp") {
    pipeline = pipeline.webp({ quality });
  } else {
    pipeline = pipeline.png({ quality });
  }

  const outputBuffer = await pipeline.toBuffer();
  const outputMeta = await sharp(outputBuffer).metadata();

  return {
    buffer: outputBuffer,
    mimeType: FORMAT_MIME[format] || inputMimeType,
    width: outputMeta.width ?? (origWidth > maxWidth ? maxWidth : origWidth),
    height: outputMeta.height ?? origHeight,
  };
}

/** Preset max widths for common image contexts. */
export const IMAGE_PRESETS = {
  hero: 1920,
  featured: 1200,
  content: 1200,
  thumbnail: 400,
  og: 1200,
} as const;
