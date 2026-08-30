export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface Message {
  readonly role: Role;
  readonly content: string | null;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
  /**
   * Opaque reasoning state returned by providers such as DeepSeek. The agent
   * never interprets or displays it, but compatible providers may require it
   * to be sent back on later tool-calling turns.
   */
  readonly reasoningContent?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitTokens?: number;
  readonly cacheMissTokens?: number;
}

export interface ModelResponse {
  readonly message: Message;
  readonly finishReason: string;
  readonly usage: Usage;
}

export type ModelStreamEvent =
  | {
      readonly type: "reasoning_delta";
      readonly delta: string;
    }
  | {
      readonly type: "content_delta";
      readonly delta: string;
    }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly nameDelta?: string;
      readonly argumentsDelta?: string;
    };

/**
 * Receives best-effort, ephemeral model progress. Implementations must not
 * throw: durable state is committed only after complete() returns.
 */
export interface ModelStreamObserver {
  onModelStreamEvent(event: ModelStreamEvent): void;
}

export interface ModelClient {
  complete(
    request: ModelRequest,
    signal: AbortSignal,
    observer?: ModelStreamObserver,
  ): Promise<ModelResponse>;
}
