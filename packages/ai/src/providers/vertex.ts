import { GoogleGenAI } from "@google/genai";
import type {
  AIProvider,
  GenerateTextOptions,
  GenerateTextResult,
  GenerateImageOptions,
  GenerateImageResult,
} from "../types.js";

export interface VertexProviderConfig {
  project: string;
  location?: string;
}

/**
 * Vertex AI provider — uses Imagen via the Vertex AI backend of @google/genai.
 * Authenticates via Application Default Credentials (ADC): automatic on Cloud
 * Run via the attached service account; locally via `gcloud auth application-default login`.
 *
 * Only used for the "image" task. generateText throws if called.
 */
export class VertexProvider implements AIProvider {
  readonly id = "vertex";
  readonly name = "Vertex AI (Google)";

  private ai: GoogleGenAI;

  constructor(config: VertexProviderConfig) {
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location ?? "us-central1",
    });
  }

  generateText(_options: GenerateTextOptions): Promise<GenerateTextResult> {
    throw new Error("VertexProvider does not support text generation — use ClaudeProvider or GeminiProvider");
  }

  async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    const model = "imagen-4.0-generate-001";
    const response = await this.ai.models.generateImages({
      model,
      prompt: options.prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: options.aspectRatio || "16:9",
        outputMimeType: "image/jpeg",
      },
    });

    const image = response.generatedImages?.[0]?.image;
    if (!image?.imageBytes) {
      throw new Error("Vertex AI Imagen returned no image data");
    }

    return {
      imageBytes: typeof image.imageBytes === "string"
        ? image.imageBytes
        : Buffer.from(image.imageBytes as Uint8Array).toString("base64"),
      mimeType: "image/jpeg",
      model,
      usedFallback: false,
    };
  }
}
