import { createHash } from "node:crypto";

import type {
  Message,
  ModelClient,
  ModelResponse,
  ToolCall,
  Usage,
} from "../core/types.js";
import { ProviderError } from "../provider/provider-error.js";
import type { EventEmitter } from "../trace/events.js";
import type { Approver, ToolExecutor, ToolResult } from "../tools/types.js";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.js";

export type StopReason =
  | "final_answer"
  | "cancelled"
  | "max_duration"
  | "max_turns"
  | "max_tool_calls"
  | "token_budget"
  | "repeated_tool_failure"
  | "model_error"
  | "incomplete_model_output"
  | "content_filtered"
  | "invalid_model_response"
  | "runtime_error"
  | "trace_error";

export interface AgentLimits {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
  readonly maxDurationMs: number;
  readonly maxRepeatedToolFailures: number;
  readonly maxModelRetries: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
}

export interface AgentOutcome {
  readonly stopReason: StopReason;
  readonly finalAnswer?: string;
  readonly error?: string;
  readonly turns: number;
  readonly modelAttempts: number;
  readonly toolCalls: number;
  readonly usage: Usage;
  readonly durationMs: number;
}

export interface CodingAgentDependencies {
  readonly model: ModelClient;
  readonly tools: ToolExecutor;
  readonly approver: Approver;
  readonly events: EventEmitter;
  readonly limits?: Partial<AgentLimits>;
  readonly systemPrompt?: string;
}

const DEFAULT_LIMITS: AgentLimits = {
  maxTurns: 24,
  maxToolCalls: 64,
  maxTotalTokens: 2_000_000,
  maxDurationMs: 10 * 60 * 1_000,
  maxRepeatedToolFailures: 3,
  maxModelRetries: 2,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 10_000,
};

interface MutableStats {
  turns: number;
  modelAttempts: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export class CodingAgent {
  readonly #model: ModelClient;
  readonly #tools: ToolExecutor;
  readonly #approver: Approver;
  readonly #events: EventEmitter;
  readonly #limits: AgentLimits;
  readonly #systemPrompt: string;

  public constructor(dependencies: CodingAgentDependencies) {
    this.#model = dependencies.model;
    this.#tools = dependencies.tools;
    this.#approver = dependencies.approver;
    this.#events = dependencies.events;
    this.#limits = validateLimits({ ...DEFAULT_LIMITS, ...dependencies.limits });
    this.#systemPrompt = dependencies.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  public async run(task: string, signal: AbortSignal): Promise<AgentOutcome> {
    if (task.trim() === "") {
      throw new Error("task must not be blank");
    }

    const startedAt = Date.now();
    const stats: MutableStats = {
      turns: 0,
      modelAttempts: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    };
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadline.abort(new Error("agent wall-clock budget exhausted")),
      this.#limits.maxDurationMs,
    );
    const combined = combineSignals([signal, deadline.signal]);
    const messages: Message[] = [
      { role: "system", content: this.#systemPrompt },
      { role: "user", content: task },
    ];
    let lastFailureSignature: string | undefined;
    let repeatedFailures = 0;

    try {
      await this.#emit("session_started", {
        task,
        limits: this.#limits,
        toolNames: this.#tools.definitions.map((definition) => definition.name),
      });

      while (true) {
        if (combined.signal.aborted) {
          return await this.#finish(
            signal.aborted ? "cancelled" : "max_duration",
            stats,
            startedAt,
          );
        }
        if (stats.turns >= this.#limits.maxTurns) {
          return await this.#finish("max_turns", stats, startedAt);
        }

        stats.turns++;
        const completion = await this.#completeWithRetries(
          messages,
          stats.turns,
          stats,
          combined.signal,
        );
        if (completion instanceof Error) {
          if (combined.signal.aborted) {
            return await this.#finish(
              signal.aborted ? "cancelled" : "max_duration",
              stats,
              startedAt,
            );
          }
          return await this.#finish("model_error", stats, startedAt, {
            error: completion.message,
          });
        }

        addUsage(stats, completion.usage);
        await this.#emit("model_response", {
          turn: stats.turns,
          finishReason: completion.finishReason,
          content: completion.message.content,
          contentCharacters: completion.message.content?.length ?? 0,
          reasoningCharacters: completion.message.reasoningContent?.length ?? 0,
          toolCalls: completion.message.toolCalls ?? [],
          usage: completion.usage,
        });

        if (combined.signal.aborted) {
          return await this.#finish(
            signal.aborted ? "cancelled" : "max_duration",
            stats,
            startedAt,
          );
        }

        if (totalTokens(stats) > this.#limits.maxTotalTokens) {
          return await this.#finish("token_budget", stats, startedAt);
        }

        const calls = completion.message.toolCalls ?? [];
        if (calls.length === 0) {
          if (completion.finishReason === "length") {
            return await this.#finish("incomplete_model_output", stats, startedAt);
          }
          if (completion.finishReason === "content_filter") {
            return await this.#finish("content_filtered", stats, startedAt);
          }
          if (completion.finishReason === "tool_calls") {
            return await this.#finish("invalid_model_response", stats, startedAt, {
              error: "finish_reason requested tools but no tool calls were present",
            });
          }
          const finalAnswer = completion.message.content;
          if (finalAnswer === null || finalAnswer.trim() === "") {
            return await this.#finish("invalid_model_response", stats, startedAt, {
              error: "model returned neither visible content nor tool calls",
            });
          }
          messages.push(completion.message);
          return await this.#finish("final_answer", stats, startedAt, { finalAnswer });
        }

        if (completion.finishReason !== "tool_calls") {
          return await this.#finish("incomplete_model_output", stats, startedAt, {
            error: `model returned tool calls with finish_reason ${JSON.stringify(completion.finishReason)}`,
          });
        }
        if (stats.toolCalls + calls.length > this.#limits.maxToolCalls) {
          return await this.#finish("max_tool_calls", stats, startedAt);
        }

        messages.push(completion.message);
        for (const [index, call] of calls.entries()) {
          if (combined.signal.aborted) {
            return await this.#finish(
              signal.aborted ? "cancelled" : "max_duration",
              stats,
              startedAt,
            );
          }
          stats.toolCalls++;
          await this.#emit("tool_started", {
            turn: stats.turns,
            index,
            call,
          });
          const result = await this.#tools.execute(
            call,
            this.#approver,
            combined.signal,
          );
          messages.push(toolResultMessage(call, result));
          await this.#emit("tool_finished", {
            turn: stats.turns,
            index,
            callId: call.id,
            toolName: call.name,
            result,
          });

          if (result.isError) {
            const signature = toolSignature(call);
            if (signature === lastFailureSignature) {
              repeatedFailures++;
            } else {
              lastFailureSignature = signature;
              repeatedFailures = 1;
            }
            if (repeatedFailures >= this.#limits.maxRepeatedToolFailures) {
              return await this.#finish(
                "repeated_tool_failure",
                stats,
                startedAt,
                { error: `tool ${call.name} failed repeatedly without a changed call` },
              );
            }
          } else {
            lastFailureSignature = undefined;
            repeatedFailures = 0;
          }
        }
      }
    } catch (error) {
      if (error instanceof TraceWriteError) {
        return outcome("trace_error", stats, startedAt, { error: error.message });
      }
      if (combined.signal.aborted) {
        return await this.#finish(
          signal.aborted ? "cancelled" : "max_duration",
          stats,
          startedAt,
        );
      }
      return await this.#finish("runtime_error", stats, startedAt, {
        error: messageOf(error),
      });
    } finally {
      clearTimeout(deadlineTimer);
      combined.cleanup();
    }
  }

  async #completeWithRetries(
    messages: readonly Message[],
    turn: number,
    stats: MutableStats,
    signal: AbortSignal,
  ): Promise<ModelResponse | Error> {
    for (let retry = 0; retry <= this.#limits.maxModelRetries; retry++) {
      stats.modelAttempts++;
      await this.#emit("model_request_started", {
        turn,
        attempt: retry + 1,
        messageCount: messages.length,
      });
      try {
        return await this.#model.complete(
          { messages: [...messages], tools: this.#tools.definitions },
          signal,
        );
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        const providerError = error instanceof ProviderError ? error : undefined;
        const retryable = providerError?.retryable === true;
        await this.#emit("model_request_failed", {
          turn,
          attempt: retry + 1,
          kind: providerError?.kind ?? "unknown",
          statusCode: providerError?.statusCode,
          retryable,
          error: normalized.message,
        });
        if (signal.aborted || !retryable || retry >= this.#limits.maxModelRetries) {
          return normalized;
        }
        const exponential = this.#limits.retryBaseDelayMs * 2 ** retry;
        const requested = providerError.retryAfterMs ?? exponential;
        const delayMs = Math.min(this.#limits.retryMaxDelayMs, Math.max(0, requested));
        await this.#emit("model_retry_scheduled", {
          turn,
          nextAttempt: retry + 2,
          delayMs,
        });
        await sleep(delayMs, signal);
      }
    }
    return new Error("model retry loop ended unexpectedly");
  }

  async #emit(type: string, data: unknown): Promise<void> {
    try {
      await this.#events.emit(type, data);
    } catch (error) {
      throw new TraceWriteError(`cannot persist ${type}: ${messageOf(error)}`);
    }
  }

  async #finish(
    reason: StopReason,
    stats: MutableStats,
    startedAt: number,
    details: { readonly finalAnswer?: string; readonly error?: string } = {},
  ): Promise<AgentOutcome> {
    const result = outcome(reason, stats, startedAt, details);
    try {
      await this.#events.emit("session_finished", result);
      return result;
    } catch (error) {
      return outcome("trace_error", stats, startedAt, {
        error: `cannot persist session_finished: ${messageOf(error)}`,
      });
    }
  }
}

class TraceWriteError extends Error {}

function outcome(
  stopReason: StopReason,
  stats: MutableStats,
  startedAt: number,
  details: { readonly finalAnswer?: string; readonly error?: string } = {},
): AgentOutcome {
  return {
    stopReason,
    ...details,
    turns: stats.turns,
    modelAttempts: stats.modelAttempts,
    toolCalls: stats.toolCalls,
    usage: usageOf(stats),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function toolResultMessage(call: ToolCall, result: ToolResult): Message {
  return {
    role: "tool",
    content: JSON.stringify(result),
    toolCallId: call.id,
  };
}

function toolSignature(call: ToolCall): string {
  let normalizedArguments = call.arguments.trim();
  try {
    normalizedArguments = JSON.stringify(canonicalJson(JSON.parse(call.arguments) as unknown));
  } catch {
    // Invalid JSON remains distinguishable by its trimmed raw representation.
  }
  return createHash("sha256")
    .update(call.name)
    .update("\0")
    .update(normalizedArguments)
    .digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (typeof value === "object" && value !== null) {
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function addUsage(stats: MutableStats, usage: Usage): void {
  stats.inputTokens += usage.inputTokens;
  stats.outputTokens += usage.outputTokens;
  stats.cacheHitTokens += usage.cacheHitTokens ?? 0;
  stats.cacheMissTokens += usage.cacheMissTokens ?? 0;
}

function totalTokens(stats: MutableStats): number {
  return stats.inputTokens + stats.outputTokens;
}

function usageOf(stats: MutableStats): Usage {
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheHitTokens: stats.cacheHitTokens,
    cacheMissTokens: stats.cacheMissTokens,
  };
}

function validateLimits(limits: AgentLimits): AgentLimits {
  const positiveIntegers: readonly (keyof AgentLimits)[] = [
    "maxTurns",
    "maxToolCalls",
    "maxTotalTokens",
    "maxDurationMs",
    "maxRepeatedToolFailures",
  ];
  for (const key of positiveIntegers) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      throw new RangeError(`${key} must be a positive integer`);
    }
  }
  for (const key of ["maxModelRetries", "retryBaseDelayMs", "retryMaxDelayMs"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) {
      throw new RangeError(`${key} must be a non-negative integer`);
    }
  }
  if (limits.retryMaxDelayMs < limits.retryBaseDelayMs) {
    throw new RangeError("retryMaxDelayMs must be at least retryBaseDelayMs");
  }
  return limits;
}

function combineSignals(signals: readonly AbortSignal[]): {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const removers: (() => void)[] = [];
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const listener = (): void => controller.abort(source.reason);
    source.addEventListener("abort", listener, { once: true });
    removers.push(() => source.removeEventListener("abort", listener));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const remove of removers) {
        remove();
      }
    },
  };
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason ?? new Error("operation cancelled");
  }
  if (milliseconds === 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("operation cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
