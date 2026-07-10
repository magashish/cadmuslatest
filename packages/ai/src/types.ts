export type AITaskType =
  | "copywriting"
  | "seo"
  | "image"
  | "interview"
  | "analysis"
  | "embedding"
  | "alt-text"
  | "visitor-chat";

export interface AIModelConfig {
  providerId: string;
  modelId: string;
}

export interface AIRouterConfig {
  defaults: Record<AITaskType, AIModelConfig>;
  fallbacks: Record<AITaskType, AIModelConfig>;
  overrides?: Partial<Record<AITaskType, AIModelConfig>>;
}

export interface GenerateTextOptions {
  task: AITaskType;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateTextResult {
  text: string;
  model: string;
  usedFallback: boolean;
}

export interface GenerateImageOptions {
  prompt: string;
  style?: string;
  width?: number;
  height?: number;
  aspectRatio?: string; // "1:1" | "3:4" | "4:3" | "9:16" | "16:9"
}

export interface GenerateImageResult {
  imageBytes: string; // base64-encoded image data
  mimeType: string;
  model: string;
  usedFallback: boolean;
}

export interface EmbedOptions {
  input: string | string[];
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
}

export interface AnalyzeImageOptions {
  imageUrl: string;
  prompt: string;
}

export interface AnalyzeImageResult {
  text: string;
  model: string;
  usedFallback: boolean;
}

// ── Tool use (pull-context / Claude Code-style) ─────────────────────────────

export type AIMessageContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AIMessage {
  role: "user" | "assistant";
  content: string | AIMessageContent[];
}

export interface AITool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type AIStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface GenerateWithToolsOptions {
  task: AITaskType;
  messages: AIMessage[];
  // Stable, reusable portion of the system prompt (persona, theme, design
  // intent). Provider-neutral hint: when set, it is treated as a cacheable
  // prefix that precedes systemPrompt. Providers that support prompt caching
  // (Claude) mark it cacheable; others simply prepend it. Keep it byte-stable
  // across turns or the cache won't hit.
  cachedSystemPrefix?: string;
  systemPrompt?: string;
  tools: AITool[];
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateWithToolsResult {
  message: AIMessage;
  stopReason: AIStopReason;
  model: string;
  usedFallback: boolean;
}

export interface AIProvider {
  id: string;
  name: string;
  generateText(options: GenerateTextOptions): Promise<GenerateTextResult>;
  generateWithTools?(options: GenerateWithToolsOptions): Promise<GenerateWithToolsResult>;
  generateImage?(options: GenerateImageOptions): Promise<GenerateImageResult>;
  embed?(options: EmbedOptions): Promise<EmbedResult>;
  analyzeImage?(options: AnalyzeImageOptions): Promise<AnalyzeImageResult>;
}
