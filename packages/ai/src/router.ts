import type {
  AIProvider,
  AIRouterConfig,
  AITaskType,
  GenerateTextOptions,
  GenerateTextResult,
  GenerateWithToolsOptions,
  GenerateWithToolsResult,
  GenerateImageOptions,
  GenerateImageResult,
  EmbedOptions,
  EmbedResult,
  AnalyzeImageOptions,
  AnalyzeImageResult,
} from "./types.js";

export class ToolUseNotSupportedByFallbackError extends Error {
  constructor(providerId: string) {
    super(`Fallback provider "${providerId}" does not implement generateWithTools — tool use cannot be safely retried.`);
    this.name = "ToolUseNotSupportedByFallbackError";
  }
}

export class AIRouter {
  private providers = new Map<string, AIProvider>();
  private config: AIRouterConfig;

  constructor(config: AIRouterConfig) {
    this.config = config;
  }

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  private resolve(task: AITaskType): { primary: AIProvider; fallback: AIProvider } {
    const overrides = this.config.overrides?.[task];
    const primaryConfig = overrides ?? this.config.defaults[task];
    const fallbackConfig = this.config.fallbacks[task];

    const primary = this.providers.get(primaryConfig.providerId);
    const fallback = this.providers.get(fallbackConfig.providerId);

    if (!primary) throw new Error(`Primary provider "${primaryConfig.providerId}" not registered for task "${task}"`);
    if (!fallback) throw new Error(`Fallback provider "${fallbackConfig.providerId}" not registered for task "${task}"`);

    return { primary, fallback };
  }

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const { primary, fallback } = this.resolve(options.task);

    try {
      return await primary.generateText(options);
    } catch (error) {
      console.warn(`Primary provider failed for task "${options.task}", using fallback:`, error);
      const result = await fallback.generateText(options);
      return { ...result, usedFallback: true };
    }
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<GenerateWithToolsResult> {
    const { primary, fallback } = this.resolve(options.task);

    if (!primary.generateWithTools) {
      throw new Error(`Primary provider "${primary.id}" does not support tool use for task "${options.task}"`);
    }

    try {
      return await primary.generateWithTools(options);
    } catch (error) {
      if (!fallback.generateWithTools) {
        throw new ToolUseNotSupportedByFallbackError(fallback.id);
      }
      console.warn(`Primary tool-use provider failed for task "${options.task}", using fallback:`, error);
      const result = await fallback.generateWithTools(options);
      return { ...result, usedFallback: true };
    }
  }

  async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    const { primary, fallback } = this.resolve("image");

    const tryProvider = async (provider: AIProvider): Promise<GenerateImageResult> => {
      if (!provider.generateImage) throw new Error(`Provider "${provider.id}" does not support image generation`);
      return provider.generateImage(options);
    };

    try {
      return await tryProvider(primary);
    } catch (error) {
      console.warn(`Primary image provider failed, using fallback:`, error);
      const result = await tryProvider(fallback);
      return { ...result, usedFallback: true };
    }
  }

  async embed(options: EmbedOptions): Promise<EmbedResult> {
    const { primary, fallback } = this.resolve("embedding");

    const tryProvider = async (provider: AIProvider): Promise<EmbedResult> => {
      if (!provider.embed) throw new Error(`Provider "${provider.id}" does not support embeddings`);
      return provider.embed(options);
    };

    try {
      return await tryProvider(primary);
    } catch (error) {
      console.warn(`Primary embedding provider failed, using fallback:`, error);
      return tryProvider(fallback);
    }
  }

  async analyzeImage(options: AnalyzeImageOptions): Promise<AnalyzeImageResult> {
    const { primary, fallback } = this.resolve("alt-text");

    const tryProvider = async (provider: AIProvider): Promise<AnalyzeImageResult> => {
      if (!provider.analyzeImage) throw new Error(`Provider "${provider.id}" does not support image analysis`);
      return provider.analyzeImage(options);
    };

    try {
      return await tryProvider(primary);
    } catch (error) {
      console.warn(`Primary image analysis provider failed, using fallback:`, error);
      const result = await tryProvider(fallback);
      return { ...result, usedFallback: true };
    }
  }
}
