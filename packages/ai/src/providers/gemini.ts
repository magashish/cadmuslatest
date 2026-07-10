import { GoogleGenAI } from "@google/genai";
import type {
  AIProvider,
  GenerateTextOptions,
  GenerateTextResult,
  GenerateImageOptions,
  GenerateImageResult,
  AnalyzeImageOptions,
  AnalyzeImageResult,
  EmbedOptions,
  EmbedResult,
} from "../types.js";

export interface GeminiProviderConfig {
  apiKey: string;
  defaultModel?: string;
}

export class GeminiProvider implements AIProvider {
  readonly id = "gemini";
  readonly name = "Gemini (Google)";

  private ai: GoogleGenAI;
  private defaultModel: string;

  constructor(config: GeminiProviderConfig) {
    this.ai = new GoogleGenAI({ apiKey: config.apiKey });
    this.defaultModel = config.defaultModel ?? "gemini-2.5-flash";
  }

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const response = await this.ai.models.generateContent({
      model: this.defaultModel,
      contents: options.prompt,
      config: {
        systemInstruction: options.systemPrompt,
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens ?? 2048,
      },
    });

    return {
      text: response.text ?? "",
      model: this.defaultModel,
      usedFallback: false,
    };
  }

  async analyzeImage(options: AnalyzeImageOptions): Promise<AnalyzeImageResult> {
    const response = await this.ai.models.generateContent({
      model: this.defaultModel,
      contents: [
        {
          role: "user",
          parts: [
            { text: options.prompt },
            {
              fileData: {
                fileUri: options.imageUrl,
                mimeType: "image/jpeg",
              },
            },
          ],
        },
      ],
    });

    return {
      text: response.text ?? "",
      model: this.defaultModel,
      usedFallback: false,
    };
  }

  async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    const model = "imagen-4.0-generate-001";
    const response = await this.ai.models.generateImages({
      model,
      prompt: options.prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: options.aspectRatio || "16:9",
        outputMimeType: "image/png",
      },
    });

    const image = response.generatedImages?.[0]?.image;
    if (!image?.imageBytes) {
      throw new Error("Image generation returned no image data");
    }

    return {
      imageBytes: image.imageBytes,
      mimeType: image.mimeType || "image/png",
      model,
      usedFallback: false,
    };
  }

  async embed(options: EmbedOptions): Promise<EmbedResult> {
    const inputs = Array.isArray(options.input) ? options.input : [options.input];
    const embeddings: number[][] = [];

    for (const text of inputs) {
      const response = await this.ai.models.embedContent({
        model: "text-embedding-004",
        contents: text,
      });
      if (response.embeddings?.[0]?.values) {
        embeddings.push(response.embeddings[0].values);
      }
    }

    return {
      embeddings,
      model: "text-embedding-004",
    };
  }
}
