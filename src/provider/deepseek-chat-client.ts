import { Buffer } from "node:buffer";

import type {
  Message,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelStreamObserver,
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
    observer?: ModelStreamObserver,
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

      const parsed = await parseStreamingResponse(response, observer);
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
      stream: true,
      stream_options: { include_usage: true },
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

interface MutableToolCall {
  id: string;
  name: string;
  arguments: string;
}

class StreamingResponseAccumulator {
  readonly #observer: ModelStreamObserver | undefined;
  readonly #content: string[] = [];
  readonly #reasoning: string[] = [];
  readonly #toolCalls = new Map<number, MutableToolCall>();
  #finishReason: string | undefined;
  #usage: Usage = { inputTokens: 0, outputTokens: 0 };
  #sawChoice = false;

  public constructor(observer: ModelStreamObserver | undefined) {
    this.#observer = observer;
  }

  public accept(value: unknown): void {
    const root = requireRecord(value, "stream chunk");
    if (root.usage !== undefined && root.usage !== null) {
      this.#usage = parseUsage(root.usage);
    }

    const choices = requireArray(root.choices, "choices");
    if (choices.length === 0) {
      return;
    }
    if (choices.length !== 1) {
      throw protocolError("stream chunk must contain at most one choice");
    }

    const choice = requireRecord(choices[0], "choices[0]");
    if (requireNonNegativeInteger(choice.index, "choices[0].index") !== 0) {
      throw protocolError("stream choice index must be 0");
    }
    this.#sawChoice = true;
    const delta = requireRecord(choice.delta, "choices[0].delta");
    if (
      delta.role !== undefined &&
      delta.role !== null &&
      delta.role !== "assistant"
    ) {
      throw protocolError("stream delta role is not assistant");
    }

    const reasoningDelta = optionalNullableString(
      delta.reasoning_content,
      "delta.reasoning_content",
    );
    if (reasoningDelta !== undefined && reasoningDelta !== "") {
      this.#reasoning.push(reasoningDelta);
      this.#notify({ type: "reasoning_delta", delta: reasoningDelta });
    }
    const contentDelta = optionalNullableString(delta.content, "delta.content");
    if (contentDelta !== undefined && contentDelta !== "") {
      this.#content.push(contentDelta);
      this.#notify({ type: "content_delta", delta: contentDelta });
    }
    this.#acceptToolCallDeltas(delta.tool_calls);

    const finishReason = optionalNullableString(
      choice.finish_reason,
      "choices[0].finish_reason",
    );
    if (finishReason !== undefined) {
      if (
        this.#finishReason !== undefined &&
        this.#finishReason !== finishReason
      ) {
        throw protocolError("stream returned conflicting finish reasons");
      }
      this.#finishReason = finishReason;
    }
  }

  public finish(): ModelResponse {
    if (!this.#sawChoice) {
      throw protocolError("provider stream contains no choices");
    }
    if (this.#finishReason === undefined) {
      throw protocolError("provider stream is missing a finish reason");
    }

    const toolCalls = this.#finalizeToolCalls();
    const reasoningContent = this.#reasoning.join("");
    const content = this.#content.join("");
    const message: Message = {
      role: "assistant",
      content: content === "" ? null : content,
      ...(reasoningContent === "" ? {} : { reasoningContent }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    };
    return {
      message,
      finishReason: this.#finishReason,
      usage: this.#usage,
    };
  }

  #acceptToolCallDeltas(value: unknown): void {
    if (value === undefined || value === null) {
      return;
    }
    const deltas = requireArray(value, "delta.tool_calls");
    for (const [position, rawDelta] of deltas.entries()) {
      const delta = requireRecord(rawDelta, `delta.tool_calls[${position}]`);
      const index = requireNonNegativeInteger(
        delta.index,
        `delta.tool_calls[${position}].index`,
      );
      const call = this.#toolCalls.get(index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      if (delta.type !== undefined && delta.type !== null && delta.type !== "function") {
        throw protocolError(`tool call delta ${index} has unsupported type`);
      }

      const idDelta = optionalNullableString(
        delta.id,
        `delta.tool_calls[${position}].id`,
      );
      if (idDelta !== undefined) {
        call.id += idDelta;
      }

      let nameDelta: string | undefined;
      let argumentsDelta: string | undefined;
      if (delta.function !== undefined && delta.function !== null) {
        const fn = requireRecord(
          delta.function,
          `delta.tool_calls[${position}].function`,
        );
        nameDelta = optionalNullableString(
          fn.name,
          `delta.tool_calls[${position}].function.name`,
        );
        argumentsDelta = optionalNullableString(
          fn.arguments,
          `delta.tool_calls[${position}].function.arguments`,
        );
        if (nameDelta !== undefined) {
          call.name += nameDelta;
        }
        if (argumentsDelta !== undefined) {
          call.arguments += argumentsDelta;
        }
      }
      this.#toolCalls.set(index, call);

      if ((nameDelta ?? "") !== "" || (argumentsDelta ?? "") !== "") {
        this.#notify({
          type: "tool_call_delta",
          index,
          ...(nameDelta === undefined || nameDelta === "" ? {} : { nameDelta }),
          ...(argumentsDelta === undefined || argumentsDelta === ""
            ? {}
            : { argumentsDelta }),
        });
      }
    }
  }

  #finalizeToolCalls(): readonly ToolCall[] {
    const indices = [...this.#toolCalls.keys()].sort((left, right) => left - right);
    const ids = new Set<string>();
    return indices.map((index, position) => {
      if (index !== position) {
        throw protocolError("tool call indices must be contiguous from 0");
      }
      const call = this.#toolCalls.get(index);
      if (call === undefined) {
        throw protocolError(`tool call ${index} is missing`);
      }
      const id = requireNonBlankString(call.id, `tool call ${index} id`);
      if (ids.has(id)) {
        throw protocolError(`tool call ID ${JSON.stringify(id)} is duplicated`);
      }
      ids.add(id);
      return {
        id,
        name: requireNonBlankString(call.name, `tool call ${index} name`),
        arguments: call.arguments,
      };
    });
  }

  #notify(event: ModelStreamEvent): void {
    try {
      this.#observer?.onModelStreamEvent(event);
    } catch {
      // Terminal progress is intentionally best-effort and cannot change agent semantics.
    }
  }
}

async function parseStreamingResponse(
  response: Response,
  observer: ModelStreamObserver | undefined,
): Promise<ModelResponse> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SUCCESS_BODY_BYTES
  ) {
    await response.body?.cancel();
    throw protocolError(`provider response exceeds ${MAX_SUCCESS_BODY_BYTES} bytes`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType !== undefined && !contentType.includes("text/event-stream")) {
    await response.body?.cancel();
    throw protocolError("provider streaming response is not text/event-stream");
  }
  if (response.body === null) {
    throw new ProviderError({
      kind: "network",
      message: "provider stream ended before data was received",
      retryable: true,
    });
  }

  const reader = response.body.getReader();
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  const sseDecoder = new SseDataDecoder();
  const accumulator = new StreamingResponseAccumulator(observer);
  let totalBytes = 0;
  let sawDone = false;

  const acceptPayload = (payload: string): void => {
    if (payload.trim() === "[DONE]") {
      sawDone = true;
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload) as unknown;
    } catch (error) {
      throw new ProviderError({
        kind: "protocol",
        message: "provider stream contains malformed JSON",
        retryable: false,
        cause: error,
      });
    }
    accumulator.accept(decoded);
  };

  while (!sawDone) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SUCCESS_BODY_BYTES) {
      await reader.cancel();
      throw protocolError(`provider response exceeds ${MAX_SUCCESS_BODY_BYTES} bytes`);
    }
    let text: string;
    try {
      text = textDecoder.decode(value, { stream: true });
    } catch (error) {
      throw new ProviderError({
        kind: "protocol",
        message: "provider stream is not valid UTF-8",
        retryable: false,
        cause: error,
      });
    }
    for (const payload of sseDecoder.push(text)) {
      acceptPayload(payload);
      if (sawDone) {
        break;
      }
    }
  }

  if (!sawDone) {
    let tail: string;
    try {
      tail = textDecoder.decode();
    } catch (error) {
      throw new ProviderError({
        kind: "protocol",
        message: "provider stream is not valid UTF-8",
        retryable: false,
        cause: error,
      });
    }
    for (const payload of [...sseDecoder.push(tail), ...sseDecoder.finish()]) {
      acceptPayload(payload);
    }
  } else {
    await reader.cancel().catch(() => undefined);
  }

  if (!sawDone) {
    throw new ProviderError({
      kind: "network",
      message: "provider stream ended before the [DONE] marker",
      retryable: true,
    });
  }
  return accumulator.finish();
}

class SseDataDecoder {
  #buffer = "";
  #dataLines: string[] = [];

  public push(text: string): readonly string[] {
    this.#buffer += text;
    return this.#drain(false);
  }

  public finish(): readonly string[] {
    const payloads = this.#drain(true);
    const pending = this.#dispatch();
    return pending === undefined ? payloads : [...payloads, pending];
  }

  #drain(final: boolean): string[] {
    const payloads: string[] = [];
    while (this.#buffer !== "") {
      const boundary = firstLineBoundary(this.#buffer);
      if (boundary === undefined) {
        if (final) {
          this.#consumeLine(this.#buffer, payloads);
          this.#buffer = "";
        }
        break;
      }
      if (
        !final &&
        boundary.index === this.#buffer.length - 1 &&
        this.#buffer[boundary.index] === "\r"
      ) {
        break;
      }
      const line = this.#buffer.slice(0, boundary.index);
      const width =
        this.#buffer[boundary.index] === "\r" &&
        this.#buffer[boundary.index + 1] === "\n"
          ? 2
          : 1;
      this.#buffer = this.#buffer.slice(boundary.index + width);
      this.#consumeLine(line, payloads);
    }
    return payloads;
  }

  #consumeLine(line: string, payloads: string[]): void {
    if (line === "") {
      const payload = this.#dispatch();
      if (payload !== undefined) {
        payloads.push(payload);
      }
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") {
      return;
    }
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    this.#dataLines.push(value);
  }

  #dispatch(): string | undefined {
    if (this.#dataLines.length === 0) {
      return undefined;
    }
    const payload = this.#dataLines.join("\n");
    this.#dataLines = [];
    return payload;
  }
}

function firstLineBoundary(
  value: string,
): { readonly index: number } | undefined {
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\r" || character === "\n") {
      return { index };
    }
  }
  return undefined;
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

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError(`${field} must be a non-negative integer`);
  }
  return value as number;
}
