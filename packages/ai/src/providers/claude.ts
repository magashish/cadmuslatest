import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProvider,
  AIMessage,
  AIMessageContent,
  AIStopReason,
  GenerateTextOptions,
  GenerateTextResult,
  GenerateWithToolsOptions,
  GenerateWithToolsResult,
  AnalyzeImageOptions,
  AnalyzeImageResult,
} from "../types.js";

export interface ClaudeProviderConfig {
  apiKey: string;
  defaultModel?: string;
}

export class ClaudeProvider implements AIProvider {
  readonly id = "claude";
  readonly name = "Claude (Anthropic)";

  private client: Anthropic;
  private defaultModel: string;

  constructor(config: ClaudeProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-6";
  }

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const response = await this.client.messages.create({
      model: this.defaultModel,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature,
      system: options.systemPrompt,
      messages: [{ role: "user", content: options.prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      model: response.model,
      usedFallback: false,
    };
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<GenerateWithToolsResult> {
    const response = await this.client.messages.create({
      model: this.defaultModel,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature,
      system: buildSystem(options.cachedSystemPrefix, options.systemPrompt),
      tools: options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      messages: options.messages.map(toAnthropicMessage),
    });

    const content: AIMessageContent[] = response.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        };
      }
      throw new Error(`Unexpected Claude content block type: ${block.type}`);
    });

    return {
      message: { role: "assistant", content },
      stopReason: mapStopReason(response.stop_reason),
      model: response.model,
      usedFallback: false,
    };
  }

  async analyzeImage(options: AnalyzeImageOptions): Promise<AnalyzeImageResult> {
    const response = await this.client.messages.create({
      model: this.defaultModel,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: options.imageUrl },
            },
            { type: "text", text: options.prompt },
          ],
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      model: response.model,
      usedFallback: false,
    };
  }
}

// Build the `system` field. With a cacheable prefix, emit two text blocks and
// put a cache_control breakpoint on the prefix so the stable persona+theme+
// design-intent portion is cached across turns (prompt caching is a prefix
// match — the volatile part follows and doesn't invalidate the cached prefix).
// Below the model's minimum cacheable size the breakpoint is a silent no-op.
function buildSystem(
  cachedPrefix: string | undefined,
  volatile: string | undefined,
): string | Anthropic.TextBlockParam[] | undefined {
  if (cachedPrefix && cachedPrefix.trim()) {
    const blocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
    ];
    if (volatile && volatile.trim()) blocks.push({ type: "text", text: volatile });
    return blocks;
  }
  return volatile;
}

function toAnthropicMessage(msg: AIMessage): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }
  const content = msg.content.map((block): Anthropic.ContentBlockParam => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") {
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    }
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: block.content,
      is_error: block.is_error,
    };
  });
  return { role: msg.role, content };
}

function mapStopReason(reason: Anthropic.Message["stop_reason"]): AIStopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
