import assert from "node:assert/strict";
import test from "node:test";

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
import { ProviderError } from "../provider/provider-error.js";
import type { EventEmitter } from "../trace/events.js";
import {
  AllowAllApprover,
  type Approver,
  type ToolExecutor,
  type ToolResult,
  failure,
  success,
} from "../tools/types.js";
import {
  CodingAgent,
  type AgentLimits,
  type AgentOutcome,
} from "./coding-agent.js";

type ModelStep =
  | ModelResponse
  | Error
  | ((
      request: ModelRequest,
      signal: AbortSignal,
      observer: ModelStreamObserver | undefined,
    ) => ModelResponse | Promise<ModelResponse>);

class ScriptedModel implements ModelClient {
  public readonly requests: ModelRequest[] = [];
  public readonly observers: (ModelStreamObserver | undefined)[] = [];

  public constructor(private readonly steps: ModelStep[]) {}

  public async complete(
    request: ModelRequest,
    signal: AbortSignal,
    observer?: ModelStreamObserver,
  ): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    this.observers.push(observer);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("scripted model ran out of responses");
    }
    if (step instanceof Error) {
      throw step;
    }
    return typeof step === "function"
      ? await step(request, signal, observer)
      : step;
  }
}

class RecordingStreamObserver implements ModelStreamObserver {
  public readonly events: ModelStreamEvent[] = [];

  public onModelStreamEvent(event: ModelStreamEvent): void {
    this.events.push(structuredClone(event));
  }
}

class ScriptedTools implements ToolExecutor {
  public readonly definitions = [
    {
      name: "probe",
      description: "Test probe",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  public readonly calls: ToolCall[] = [];

  public constructor(
    private readonly handler: (
      call: ToolCall,
      approver: Approver | undefined,
      signal: AbortSignal,
    ) => ToolResult | Promise<ToolResult> = () => success("ok"),
  ) {}

  public async execute(
    call: ToolCall,
    approver: Approver | undefined,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    this.calls.push(structuredClone(call));
    return await this.handler(call, approver, signal);
  }
}

class RecordingEvents implements EventEmitter {
  public readonly records: { readonly type: string; readonly data: unknown }[] = [];

  public async emit(type: string, data: unknown): Promise<void> {
    this.records.push({ type, data: structuredClone(data) });
  }
}

class FailingEvents implements EventEmitter {
  public calls = 0;

  public async emit(): Promise<void> {
    this.calls += 1;
    throw new Error("trace unavailable");
  }
}

const defaultUsage: Usage = { inputTokens: 2, outputTokens: 1 };
const CONTINUATION_PROMPT =
  "The previous response reached the output limit. Continue the same task now: use a tool immediately or provide the final answer, and keep reasoning concise.";

function response(options: {
  readonly content?: string | null;
  readonly finishReason?: string;
  readonly reasoningContent?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: Usage;
} = {}): ModelResponse {
  const content = Object.hasOwn(options, "content") ? options.content ?? null : "done";
  const message: Message = {
    role: "assistant",
    content,
    ...(options.reasoningContent === undefined
      ? {}
      : { reasoningContent: options.reasoningContent }),
    ...(options.toolCalls === undefined ? {} : { toolCalls: options.toolCalls }),
  };
  return {
    message,
    finishReason: options.finishReason ?? "stop",
    usage: options.usage ?? defaultUsage,
  };
}

function toolCall(id: string, argumentsJson = "{}"): ToolCall {
  return { id, name: "probe", arguments: argumentsJson };
}

function makeAgent(options: {
  readonly model: ModelClient;
  readonly tools?: ToolExecutor;
  readonly events?: EventEmitter;
  readonly limits?: Partial<AgentLimits>;
  readonly modelStreamObserver?: ModelStreamObserver;
}): CodingAgent {
  return new CodingAgent({
    model: options.model,
    tools: options.tools ?? new ScriptedTools(),
    approver: new AllowAllApprover(),
    events: options.events ?? new RecordingEvents(),
    ...(options.modelStreamObserver === undefined
      ? {}
      : { modelStreamObserver: options.modelStreamObserver }),
    systemPrompt: "test system",
    limits: {
      maxDurationMs: 2_000,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      ...options.limits,
    },
  });
}

async function run(agent: CodingAgent, task = "do the work"): Promise<AgentOutcome> {
  return await agent.run(task, new AbortController().signal);
}

test("CodingAgent returns a final answer without executing a tool", async () => {
  const model = new ScriptedModel([
    response({ content: "  finished  ", usage: { inputTokens: 5, outputTokens: 2 } }),
  ]);
  const tools = new ScriptedTools();

  const outcome = await run(makeAgent({ model, tools }));

  assert.equal(outcome.stopReason, "final_answer");
  assert.equal(outcome.finalAnswer, "  finished  ");
  assert.equal(outcome.turns, 1);
  assert.equal(outcome.modelAttempts, 1);
  assert.equal(outcome.toolCalls, 0);
  assert.deepEqual(outcome.usage, {
    inputTokens: 5,
    outputTokens: 2,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  });
  assert.equal(tools.calls.length, 0);
  assert.deepEqual(model.requests[0]?.messages, [
    { role: "system", content: "test system" },
    { role: "user", content: "do the work" },
  ]);
});

test("CodingAgent preserves opaque reasoning across a tool round", async () => {
  const call = toolCall("call-1", '{"path":"a.ts"}');
  const model = new ScriptedModel([
    response({
      content: null,
      finishReason: "tool_calls",
      reasoningContent: "opaque reasoning state",
      toolCalls: [call],
    }),
    (request) => {
      assert.deepEqual(request.messages[2], {
        role: "assistant",
        content: null,
        reasoningContent: "opaque reasoning state",
        toolCalls: [call],
      });
      assert.equal(request.messages[3]?.role, "tool");
      assert.equal(request.messages[3]?.toolCallId, "call-1");
      assert.deepEqual(JSON.parse(request.messages[3]?.content ?? ""), {
        content: "observation",
        isError: false,
      });
      return response({ content: "complete" });
    },
  ]);
  const tools = new ScriptedTools(() => success("observation"));

  const outcome = await run(makeAgent({ model, tools }));

  assert.equal(outcome.stopReason, "final_answer");
  assert.equal(outcome.finalAnswer, "complete");
  assert.equal(tools.calls.length, 1);
});

test("CodingAgent executes a tool batch serially and appends results in call order", async () => {
  const first = toolCall("first", '{"index":1}');
  const second = toolCall("second", '{"index":2}');
  let firstFinished = false;
  const tools = new ScriptedTools(async (call) => {
    if (call.id === "first") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      firstFinished = true;
      return success("first result");
    }
    assert.equal(firstFinished, true, "second tool started before first completed");
    return success("second result");
  });
  const model = new ScriptedModel([
    response({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [first, second],
    }),
    (request) => {
      const resultMessages = request.messages.slice(3);
      assert.deepEqual(
        resultMessages.map((message) => message.toolCallId),
        ["first", "second"],
      );
      assert.match(resultMessages[0]?.content ?? "", /first result/);
      assert.match(resultMessages[1]?.content ?? "", /second result/);
      return response({ content: "complete" });
    },
  ]);

  const outcome = await run(makeAgent({ model, tools }));

  assert.equal(outcome.stopReason, "final_answer");
  assert.deepEqual(tools.calls.map((call) => call.id), ["first", "second"]);
});

test("CodingAgent rejects an over-budget tool batch before any side effect", async () => {
  const tools = new ScriptedTools();
  const model = new ScriptedModel([
    response({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [toolCall("first"), toolCall("second")],
    }),
  ]);

  const outcome = await run(
    makeAgent({ model, tools, limits: { maxToolCalls: 1 } }),
  );

  assert.equal(outcome.stopReason, "max_tool_calls");
  assert.equal(outcome.toolCalls, 0);
  assert.equal(tools.calls.length, 0);
});

test("CodingAgent enforces turn and token budgets", async (t) => {
  await t.test("turn budget", async () => {
    const model = new ScriptedModel([
      response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [toolCall("once")],
      }),
    ]);
    const outcome = await run(makeAgent({ model, limits: { maxTurns: 1 } }));

    assert.equal(outcome.stopReason, "max_turns");
    assert.equal(outcome.turns, 1);
    assert.equal(outcome.toolCalls, 1);
    assert.equal(model.requests.length, 1);
  });

  await t.test("token budget", async () => {
    const model = new ScriptedModel([
      response({
        content: "would otherwise finish",
        usage: { inputTokens: 7, outputTokens: 4 },
      }),
    ]);
    const outcome = await run(
      makeAgent({ model, limits: { maxTotalTokens: 10 } }),
    );

    assert.equal(outcome.stopReason, "token_budget");
    assert.equal(outcome.finalAnswer, undefined);
    assert.equal(outcome.usage.inputTokens + outcome.usage.outputTokens, 11);
  });
});

test("CodingAgent enforces the wall-clock budget while waiting for the model", async () => {
  const model = new ScriptedModel([
    async (_request, signal) =>
      await new Promise<ModelResponse>((_resolve, reject) => {
        const rejectOnAbort = (): void => reject(signal.reason);
        if (signal.aborted) {
          rejectOnAbort();
        } else {
          signal.addEventListener("abort", rejectOnAbort, { once: true });
        }
      }),
  ]);

  const outcome = await run(
    makeAgent({ model, limits: { maxDurationMs: 25 } }),
  );

  assert.equal(outcome.stopReason, "max_duration");
  assert.equal(outcome.turns, 1);
  assert.equal(outcome.modelAttempts, 1);
});

test("CodingAgent canonicalizes JSON arguments before repeated-failure detection", async () => {
  const variants = [
    '{"a":1,"nested":{"y":2,"z":3}}',
    ' { "nested": { "z": 3, "y": 2 }, "a": 1 } ',
    '{"nested":{"y":2,"z":3},"a":1}',
  ];
  const model = new ScriptedModel(
    variants.map((argumentsJson, index) =>
      response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [toolCall(`call-${index}`, argumentsJson)],
      }),
    ),
  );
  const tools = new ScriptedTools(() =>
    failure("same recoverable failure", "path_error"),
  );

  const outcome = await run(
    makeAgent({
      model,
      tools,
      limits: { maxRepeatedToolFailures: 3 },
    }),
  );

  assert.equal(outcome.stopReason, "repeated_tool_failure");
  assert.equal(outcome.turns, 3);
  assert.equal(outcome.toolCalls, 3);
  assert.equal(model.requests.length, 3);
});

test("CodingAgent retries only the model request and does not repeat tools", async () => {
  const retryable = new ProviderError({
    kind: "http",
    message: "temporarily unavailable",
    retryable: true,
    statusCode: 503,
    retryAfterMs: 0,
  });
  const call = toolCall("only-once");
  const observer = new RecordingStreamObserver();
  const model = new ScriptedModel([
    response({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [call],
    }),
    (_request, _signal, attemptObserver) => {
      attemptObserver?.onModelStreamEvent({
        type: "content_delta",
        delta: "partial failed attempt",
      });
      throw retryable;
    },
    (request, _signal, attemptObserver) => {
      assert.deepEqual(request, model.requests[1]);
      attemptObserver?.onModelStreamEvent({
        type: "content_delta",
        delta: "recovered",
      });
      return response({ content: "recovered" });
    },
  ]);
  const tools = new ScriptedTools();
  const events = new RecordingEvents();

  const outcome = await run(
    makeAgent({
      model,
      tools,
      events,
      modelStreamObserver: observer,
      limits: { maxModelRetries: 1 },
    }),
  );

  assert.equal(outcome.stopReason, "final_answer");
  assert.equal(outcome.modelAttempts, 3);
  assert.equal(outcome.turns, 2);
  assert.equal(tools.calls.length, 1);
  assert.equal(model.observers.length, 3);
  assert.ok(model.observers.every((candidate) => candidate === observer));
  assert.deepEqual(observer.events, [
    { type: "content_delta", delta: "partial failed attempt" },
    { type: "content_delta", delta: "recovered" },
  ]);
  assert.deepEqual(
    events.records.map((event) => event.type),
    [
      "session_started",
      "model_request_started",
      "model_response",
      "tool_started",
      "tool_finished",
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_response",
      "session_finished",
    ],
  );
});

test("CodingAgent does not retry a non-retryable model error", async () => {
  const model = new ScriptedModel([
    new ProviderError({
      kind: "http",
      message: "invalid request",
      retryable: false,
      statusCode: 400,
    }),
  ]);

  const outcome = await run(
    makeAgent({ model, limits: { maxModelRetries: 5 } }),
  );

  assert.equal(outcome.stopReason, "model_error");
  assert.equal(outcome.modelAttempts, 1);
  assert.equal(model.requests.length, 1);
  assert.match(outcome.error ?? "", /invalid request/);
});

test("CodingAgent honors cancellation before calling the model", async () => {
  const model = new ScriptedModel([response()]);
  const tools = new ScriptedTools();
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));

  const outcome = await makeAgent({ model, tools }).run(
    "do the work",
    controller.signal,
  );

  assert.equal(outcome.stopReason, "cancelled");
  assert.equal(outcome.turns, 0);
  assert.equal(model.requests.length, 0);
  assert.equal(tools.calls.length, 0);
});

test("CodingAgent performs no model or tool side effect when session_started cannot persist", async () => {
  const model = new ScriptedModel([response()]);
  const tools = new ScriptedTools();
  const events = new FailingEvents();

  const outcome = await run(makeAgent({ model, tools, events }));

  assert.equal(outcome.stopReason, "trace_error");
  assert.equal(outcome.turns, 0);
  assert.equal(model.requests.length, 0);
  assert.equal(tools.calls.length, 0);
  assert.equal(events.calls, 1);
});

test("CodingAgent continues one reasoning-only length response into tools and a final answer", async () => {
  const call = toolCall("continued-tool", '{"path":"game.ts"}');
  const events = new RecordingEvents();
  const tools = new ScriptedTools(() => success("tool completed"));
  const model = new ScriptedModel([
    response({
      content: " \n ",
      finishReason: "length",
      reasoningContent: "opaque unfinished reasoning",
    }),
    (request) => {
      assert.deepEqual(request.messages, [
        { role: "system", content: "test system" },
        { role: "user", content: "do the work" },
        {
          role: "assistant",
          content: "",
          reasoningContent: "opaque unfinished reasoning",
        },
        { role: "user", content: CONTINUATION_PROMPT },
      ]);
      return response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [call],
      });
    },
    (request) => {
      assert.deepEqual(request.messages.slice(4), [
        {
          role: "assistant",
          content: null,
          toolCalls: [call],
        },
        {
          role: "tool",
          content: JSON.stringify({ content: "tool completed", isError: false }),
          toolCallId: "continued-tool",
        },
      ]);
      return response({ content: "continued task complete" });
    },
  ]);

  const outcome = await run(makeAgent({ model, tools, events }));

  assert.equal(outcome.stopReason, "final_answer");
  assert.equal(outcome.finalAnswer, "continued task complete");
  assert.equal(outcome.turns, 3);
  assert.equal(outcome.modelAttempts, 3);
  assert.equal(outcome.toolCalls, 1);
  assert.deepEqual(outcome.usage, {
    inputTokens: 6,
    outputTokens: 3,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  });
  assert.deepEqual(tools.calls, [call]);
  assert.deepEqual(
    events.records.find(
      (entry) => entry.type === "model_continuation_scheduled",
    )?.data,
    { turn: 1, continuation: 1, maximum: 1 },
  );
  assert.deepEqual(
    events.records.map((entry) => entry.type),
    [
      "session_started",
      "model_request_started",
      "model_response",
      "model_continuation_scheduled",
      "model_request_started",
      "model_response",
      "tool_started",
      "tool_finished",
      "model_request_started",
      "model_response",
      "session_finished",
    ],
  );
});

test("CodingAgent schedules only the default single incomplete-model continuation", async () => {
  const events = new RecordingEvents();
  const model = new ScriptedModel([
    response({
      content: null,
      finishReason: "length",
      reasoningContent: "first unfinished reasoning",
    }),
    (request) => {
      assert.deepEqual(request.messages.slice(2), [
        {
          role: "assistant",
          content: "",
          reasoningContent: "first unfinished reasoning",
        },
        { role: "user", content: CONTINUATION_PROMPT },
      ]);
      return response({
        content: "",
        finishReason: "length",
        reasoningContent: "second unfinished reasoning",
      });
    },
  ]);

  const outcome = await run(makeAgent({ model, events }));

  assert.equal(outcome.stopReason, "incomplete_model_output");
  assert.equal(outcome.turns, 2);
  assert.equal(outcome.modelAttempts, 2);
  assert.equal(model.requests.length, 2);
  assert.equal(
    (
      events.records[0]?.data as {
        readonly limits?: Readonly<Record<string, unknown>>;
      }
    ).limits?.maxIncompleteModelContinuations,
    1,
  );
  assert.equal(
    events.records.filter(
      (entry) => entry.type === "model_continuation_scheduled",
    ).length,
    1,
  );
  assert.deepEqual(
    events.records.map((entry) => entry.type),
    [
      "session_started",
      "model_request_started",
      "model_response",
      "model_continuation_scheduled",
      "model_request_started",
      "model_response",
      "session_finished",
    ],
  );
});

test("CodingAgent maps incomplete, filtered, and empty model output", async (t) => {
  const cases = [
    {
      name: "length",
      response: response({
        content: "partial",
        finishReason: "length",
        reasoningContent: "opaque partial reasoning",
      }),
      stopReason: "incomplete_model_output",
    },
    {
      name: "length without reasoning",
      response: response({ content: null, finishReason: "length" }),
      stopReason: "incomplete_model_output",
    },
    {
      name: "content filter",
      response: response({ content: null, finishReason: "content_filter" }),
      stopReason: "content_filtered",
    },
    {
      name: "tool finish without calls",
      response: response({ content: null, finishReason: "tool_calls" }),
      stopReason: "invalid_model_response",
    },
    {
      name: "empty stop",
      response: response({ content: null, finishReason: "stop" }),
      stopReason: "invalid_model_response",
    },
    {
      name: "tool calls with non-tool finish",
      response: response({
        content: null,
        finishReason: "stop",
        toolCalls: [toolCall("unexpected")],
      }),
      stopReason: "incomplete_model_output",
    },
    {
      name: "length with incomplete tool calls",
      response: response({
        content: null,
        finishReason: "length",
        reasoningContent: "opaque tool reasoning",
        toolCalls: [toolCall("incomplete")],
      }),
      stopReason: "incomplete_model_output",
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const tools = new ScriptedTools();
      const model = new ScriptedModel([entry.response]);
      const outcome = await run(
        makeAgent({ model, tools }),
      );
      assert.equal(outcome.stopReason, entry.stopReason);
      assert.equal(model.requests.length, 1);
      assert.equal(tools.calls.length, 0);
    });
  }
});
