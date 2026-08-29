import { Buffer } from "node:buffer";

import type {
  Message,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolCall,
  Usage,
} from "../core/types.js";
import type {
  ProviderCredentials,
  ProviderSettings,
} from "../config/runtime-config.js";
import { safeDisplay } from "../text/safe-display.js";
import { ProviderError } from "./provider-error.js";

const MAX_SUCCESS_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export class DeepSeekChatClient implements ModelClient {
  readonly #settings: ProviderSettings;
  readonly #credentials: ProviderCredentials;

  public constructor(
    settings: ProviderSettings,
    credentials: ProviderCredentials,
  ) {
    this.#settings = settings;
    this.#credentials = credentials;
  }

  public async complete(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    if (signal.aborted) {
      throw providerCancellation(signal.reason);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("provider request timed out"));
    }, this.#settings.requestTimeoutMs);
    timeout.unref();
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(`${this.#settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#credentials.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(this.#buildRequest(request)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await readBoundedBody(response, MAX_ERROR_BODY_BYTES);
        const detail = this.#safeErrorDetail(body);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        throw new ProviderError({
          kind: "http",
          message: `provider returned HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`,
          retryable: isRetryableStatus(response.status),
          statusCode: response.status,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }

      const body = await readBoundedBody(response, MAX_SUCCESS_BODY_BYTES);
      let decoded: unknown;
      try {
        decoded = JSON.parse(body) as unknown;
      } catch (error) {
        throw new ProviderError({
          kind: "protocol",
          message: "provider returned malformed JSON",
          retryable: false,
          cause: error,
        });
      }
      const parsed = parseResponse(decoded);
      if (parsed.finishReason === "insufficient_system_resource") {
        throw new ProviderError({
          kind: "protocol",
          message: "provider stopped because inference resources were unavailable",
          retryable: true,
        });
      }
      return parsed;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (signal.aborted) {
        throw providerCancellation(signal.reason);
      }
      if (timedOut) {
        throw new ProviderError({
          kind: "timeout",
          message: `provider request exceeded ${this.#settings.requestTimeoutMs}ms`,
          retryable: true,
          cause: error,
        });
      }
      throw new ProviderError({
        kind: "network",
        message: "provider request failed before a complete response was received",
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  #buildRequest(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.#settings.model,
      messages: request.messages.map(toDeepSeekMessage),
      stream: false,
      thinking: { type: this.#settings.thinking },
      max_tokens: this.#settings.maxOutputTokens,
    };
    if (this.#settings.thinking === "enabled") {
      body.reasoning_effort = this.#settings.reasoningEffort;
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = "auto";
    }
    return body;
  }

  #safeErrorDetail(body: string): string {
    let detail = body.trim();
    try {
      const decoded = JSON.parse(body) as unknown;
      if (isRecord(decoded) && isRecord(decoded.error) && typeof decoded.error.message === "string") {
        detail = decoded.error.message;
      }
    } catch {
      // Plain-text proxy errors are still useful after redaction and bounding.
    }
    if (this.#credentials.apiKey !== "") {
      detail = detail.split(this.#credentials.apiKey).join("[redacted]");
    }
    return safeDisplay(detail, 1_000);
  }
}

function toDeepSeekMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool") {
    if (message.toolCallId === undefined || message.toolCallId === "") {
      throw new ProviderError({
        kind: "request",
        message: "tool message is missing toolCallId",
        retryable: false,
      });
    }
    return {
      role: "tool",
      content: message.content ?? "",
      tool_call_id: message.toolCallId,
    };
  }

  const converted: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.role === "assistant") {
    if (message.reasoningContent !== undefined) {
      converted.reasoning_content = message.reasoningContent;
    }
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      converted.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
  }
  return converted;
}

function parseResponse(value: unknown): ModelResponse {
  const root = requireRecord(value, "response");
  const choices = requireArray(root.choices, "choices");
  if (choices.length === 0) {
    throw protocolError("provider response contains no choices");
  }
  const choice = requireRecord(choices[0], "choices[0]");
  const finishReason = requireString(choice.finish_reason, "finish_reason");
  const rawMessage = requireRecord(choice.message, "message");
  if (rawMessage.role !== "assistant") {
    throw protocolError("provider response message role is not assistant");
  }

  const content = nullableString(rawMessage.content, "message.content");
  const reasoningContent = optionalNullableString(
    rawMessage.reasoning_content,
    "message.reasoning_content",
  );
  const toolCalls = parseToolCalls(rawMessage.tool_calls);
  const message: Message = {
    role: "assistant",
    content,
    ...(reasoningContent === undefined ? {} : { reasoningContent }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };

  return {
    message,
    finishReason,
    usage: parseUsage(root.usage),
  };
}

function parseToolCalls(value: unknown): readonly ToolCall[] {
  if (value === undefined || value === null) {
    return [];
  }
  const rawCalls = requireArray(value, "message.tool_calls");
  const ids = new Set<string>();
  return rawCalls.map((rawCall, index) => {
    const call = requireRecord(rawCall, `message.tool_calls[${index}]`);
    if (call.type !== "function") {
      throw protocolError(`tool call ${index} has unsupported type`);
    }
    const id = requireNonBlankString(call.id, `tool call ${index} id`);
    if (ids.has(id)) {
      throw protocolError(`tool call ID ${JSON.stringify(id)} is duplicated`);
    }
    ids.add(id);
    const fn = requireRecord(call.function, `tool call ${index} function`);
    return {
      id,
      name: requireNonBlankString(fn.name, `tool call ${index} name`),
      arguments: requireString(fn.arguments, `tool call ${index} arguments`),
    };
  });
}

function parseUsage(value: unknown): Usage {
  if (value === undefined || value === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usage = requireRecord(value, "usage");
  const cacheHit = optionalNonNegativeInteger(usage.prompt_cache_hit_tokens);
  const cacheMiss = optionalNonNegativeInteger(usage.prompt_cache_miss_tokens);
  return {
    inputTokens: optionalNonNegativeInteger(usage.prompt_tokens) ?? 0,
    outputTokens: optionalNonNegativeInteger(usage.completion_tokens) ?? 0,
    ...(cacheHit === undefined ? {} : { cacheHitTokens: cacheHit }),
    ...(cacheMiss === undefined ? {} : { cacheMissTokens: cacheMiss }),
  };
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw protocolError(`provider response exceeds ${maximumBytes} bytes`);
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw protocolError(`provider response exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

function isRetryableStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}

function providerCancellation(reason: unknown): ProviderError {
  return new ProviderError({
    kind: "cancelled",
    message: "provider request was cancelled",
    retryable: false,
    cause: reason,
  });
}

function protocolError(message: string): ProviderError {
  return new ProviderError({ kind: "protocol", message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw protocolError(`${field} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw protocolError(`${field} must be an array`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw protocolError(`${field} must be a string`);
  }
  return value;
}

function requireNonBlankString(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (result.trim() === "") {
    throw protocolError(`${field} must not be blank`);
  }
  return result;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireString(value, field);
}

function optionalNullableString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError("usage token counts must be non-negative integers");
  }
  return value as number;
}
