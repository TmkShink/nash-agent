import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type {
  ProviderCredentials,
  ProviderSettings,
} from "../config/runtime-config.js";
import type {
  ModelRequest,
  ModelStreamEvent,
  ModelStreamObserver,
} from "../core/types.js";
import { DeepSeekChatClient } from "./deepseek-chat-client.js";
import { ProviderError } from "./provider-error.js";

const TEST_KEY = "provider-test-secret";
const MAX_SUCCESS_BODY_BYTES = 8 * 1024 * 1024;

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

interface SseOptions {
  readonly done?: boolean;
  readonly lineEnding?: "\n" | "\r\n";
  readonly byteChunkSizes?: readonly number[];
}

class RecordingObserver implements ModelStreamObserver {
  public readonly events: ModelStreamEvent[] = [];

  public onModelStreamEvent(event: ModelStreamEvent): void {
    this.events.push(structuredClone(event));
  }
}

async function localServer(
  t: test.TestContext,
  handler: RequestHandler,
): Promise<string> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      if (!response.headersSent) {
        response.statusCode = 500;
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function settings(
  baseUrl: string,
  overrides: Partial<ProviderSettings> = {},
): ProviderSettings {
  return {
    baseUrl,
    model: "deepseek-test",
    thinking: "enabled",
    reasoningEffort: "high",
    requestTimeoutMs: 1_000,
    maxOutputTokens: 4_096,
    ...overrides,
  };
}

function credentials(): ProviderCredentials {
  return { apiKey: TEST_KEY };
}

function emptyRequest(): ModelRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  };
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function sendSse(
  response: ServerResponse,
  payloads: readonly unknown[],
  options: SseOptions = {},
): Promise<void> {
  const lineEnding = options.lineEnding ?? "\n";
  const frames = payloads.map(
    (payload) => `data: ${JSON.stringify(payload)}${lineEnding}${lineEnding}`,
  );
  if (options.done !== false) {
    frames.push(`data: [DONE]${lineEnding}${lineEnding}`);
  }
  const wire = Buffer.from(frames.join(""), "utf8");
  response.writeHead(200, { "content-type": "text/event-stream" });

  let offset = 0;
  for (const requestedSize of options.byteChunkSizes ?? [wire.byteLength]) {
    if (offset >= wire.byteLength) {
      break;
    }
    const next = Math.min(wire.byteLength, offset + requestedSize);
    response.write(wire.subarray(offset, next));
    offset = next;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (offset < wire.byteLength) {
    response.write(wire.subarray(offset));
  }
  response.end();
}

function delta(
  value: Readonly<Record<string, unknown>>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    choices: [{ index: 0, delta: value, finish_reason: finishReason }],
  };
}

function usage(options: {
  readonly prompt?: number;
  readonly completion?: number;
  readonly cacheHit?: number;
  readonly cacheMiss?: number;
} = {}): Record<string, unknown> {
  return {
    choices: [],
    usage: {
      prompt_tokens: options.prompt ?? 21,
      completion_tokens: options.completion ?? 8,
      ...(options.cacheHit === undefined
        ? {}
        : { prompt_cache_hit_tokens: options.cacheHit }),
      ...(options.cacheMiss === undefined
        ? {}
        : { prompt_cache_miss_tokens: options.cacheMiss }),
    },
  };
}

async function providerErrorOf(operation: Promise<unknown>): Promise<ProviderError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof ProviderError);
    return error;
  }
  assert.fail("expected ProviderError");
}

test("DeepSeekChatClient requests SSE and aggregates fragmented reasoning and tool calls", async (t) => {
  let receivedRequest: IncomingMessage | undefined;
  let receivedBody: unknown;
  const baseUrl = await localServer(t, async (request, response) => {
    receivedRequest = request;
    receivedBody = await bodyOf(request);
    await sendSse(
      response,
      [
        delta({ role: "assistant", reasoning_content: "opaque next-" }),
        delta({ reasoning_content: "step reasoning" }),
        delta({
          tool_calls: [
            {
              index: 0,
              id: "call-2",
              type: "function",
              function: { name: "read_", arguments: '{ "path"' },
            },
          ],
        }),
        delta({
          tool_calls: [
            {
              index: 0,
              function: {
                name: "file",
                arguments: ' : "src/页面.ts" }',
              },
            },
          ],
        }),
        delta({}, "tool_calls"),
        usage({ cacheHit: 13, cacheMiss: 5 }),
      ],
      {
        lineEnding: "\r\n",
        byteChunkSizes: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
      },
    );
  });
  const originalArguments = '{ "path" : "src/old.ts" }';
  const request: ModelRequest = {
    messages: [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        reasoningContent: "opaque prior reasoning",
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            arguments: originalArguments,
          },
        ],
      },
      {
        role: "tool",
        content: "file contents",
        toolCallId: "call-1",
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read one file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
  };
  const observer = new RecordingObserver();

  const result = await new DeepSeekChatClient(
    settings(baseUrl),
    credentials(),
  ).complete(request, new AbortController().signal, observer);

  assert.equal(receivedRequest?.method, "POST");
  assert.equal(receivedRequest?.url, "/chat/completions");
  assert.equal(receivedRequest?.headers.authorization, `Bearer ${TEST_KEY}`);
  assert.match(receivedRequest?.headers["content-type"] ?? "", /^application\/json/);
  assert.deepEqual(receivedBody, {
    model: "deepseek-test",
    messages: [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "opaque prior reasoning",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: originalArguments },
          },
        ],
      },
      { role: "tool", content: "file contents", tool_call_id: "call-1" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: "enabled" },
    max_tokens: 4_096,
    reasoning_effort: "high",
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read one file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: "auto",
  });
  assert.deepEqual(result, {
    message: {
      role: "assistant",
      content: null,
      reasoningContent: "opaque next-step reasoning",
      toolCalls: [
        {
          id: "call-2",
          name: "read_file",
          arguments: '{ "path" : "src/页面.ts" }',
        },
      ],
    },
    finishReason: "tool_calls",
    usage: {
      inputTokens: 21,
      outputTokens: 8,
      cacheHitTokens: 13,
      cacheMissTokens: 5,
    },
  });
  assert.deepEqual(observer.events, [
    { type: "reasoning_delta", delta: "opaque next-" },
    { type: "reasoning_delta", delta: "step reasoning" },
    {
      type: "tool_call_delta",
      index: 0,
      nameDelta: "read_",
      argumentsDelta: '{ "path"',
    },
    {
      type: "tool_call_delta",
      index: 0,
      nameDelta: "file",
      argumentsDelta: ' : "src/页面.ts" }',
    },
  ]);
});

test("DeepSeekChatClient aggregates content and interleaved tool calls without changing index order", async (t) => {
  const baseUrl = await localServer(t, async (_request, response) => {
    await sendSse(response, [
      delta({ content: "I will " }),
      delta({ content: "inspect both files." }),
      delta({
        tool_calls: [
          {
            index: 1,
            id: "second",
            type: "function",
            function: { name: "read_", arguments: '{"path":"b' },
          },
          {
            index: 0,
            id: "first",
            type: "function",
            function: { name: "list_", arguments: '{"path":"' },
          },
        ],
      }),
      delta({
        tool_calls: [
          { index: 0, function: { name: "files", arguments: 'src"}' } },
          { index: 1, function: { name: "file", arguments: '.ts"}' } },
        ],
      }),
      delta({}, "tool_calls"),
      usage({ prompt: 3, completion: 7 }),
    ]);
  });
  const observer = new RecordingObserver();

  const result = await new DeepSeekChatClient(
    settings(baseUrl),
    credentials(),
  ).complete(emptyRequest(), new AbortController().signal, observer);

  assert.deepEqual(result, {
    message: {
      role: "assistant",
      content: "I will inspect both files.",
      toolCalls: [
        { id: "first", name: "list_files", arguments: '{"path":"src"}' },
        { id: "second", name: "read_file", arguments: '{"path":"b.ts"}' },
      ],
    },
    finishReason: "tool_calls",
    usage: { inputTokens: 3, outputTokens: 7 },
  });
  assert.deepEqual(observer.events.slice(0, 2), [
    { type: "content_delta", delta: "I will " },
    { type: "content_delta", delta: "inspect both files." },
  ]);
  assert.deepEqual(
    observer.events
      .filter((event) => event.type === "tool_call_delta")
      .map((event) => event.index),
    [1, 0, 0, 1],
  );
});

test("DeepSeekChatClient keeps aggregation authoritative when a progress observer fails", async (t) => {
  const baseUrl = await localServer(t, async (_request, response) => {
    await sendSse(response, [
      delta({ content: "still " }),
      delta({ content: "complete" }),
      delta({}, "stop"),
      usage({ prompt: 2, completion: 2 }),
    ]);
  });
  const observer: ModelStreamObserver = {
    onModelStreamEvent: () => {
      throw new Error("terminal output failed");
    },
  };

  const result = await new DeepSeekChatClient(
    settings(baseUrl),
    credentials(),
  ).complete(emptyRequest(), new AbortController().signal, observer);

  assert.deepEqual(result, {
    message: { role: "assistant", content: "still complete" },
    finishReason: "stop",
    usage: { inputTokens: 2, outputTokens: 2 },
  });
});

test("DeepSeekChatClient classifies HTTP statuses and honors Retry-After", async (t) => {
  const cases = [
    { status: 429, retryable: true, retryAfter: "2", retryAfterMs: 2_000 },
    { status: 500, retryable: true },
    { status: 503, retryable: true },
    { status: 401, retryable: false },
    { status: 400, retryable: false },
  ] as const;

  for (const entry of cases) {
    await t.test(String(entry.status), async (t) => {
      const baseUrl = await localServer(t, (_request, response) => {
        if ("retryAfter" in entry) {
          response.setHeader("retry-after", entry.retryAfter);
        }
        json(
          response,
          { error: { message: `rejected credential ${TEST_KEY}` } },
          entry.status,
        );
      });

      const error = await providerErrorOf(
        new DeepSeekChatClient(settings(baseUrl), credentials()).complete(
          emptyRequest(),
          new AbortController().signal,
        ),
      );

      assert.equal(error.kind, "http");
      assert.equal(error.statusCode, entry.status);
      assert.equal(error.retryable, entry.retryable);
      assert.equal(
        error.retryAfterMs,
        "retryAfterMs" in entry ? entry.retryAfterMs : undefined,
      );
      assert.doesNotMatch(error.message, new RegExp(TEST_KEY));
      assert.match(error.message, /\[redacted\]/);
    });
  }
});

test("DeepSeekChatClient rejects malformed or incomplete SSE as protocol errors", async (t) => {
  const protocolCases: readonly {
    readonly name: string;
    readonly wire?: string;
    readonly payloads?: readonly unknown[];
  }[] = [
    { name: "malformed JSON data", wire: "data: {\n\ndata: [DONE]\n\n" },
    { name: "empty data field", wire: "data\n\ndata: [DONE]\n\n" },
    { name: "non-object chunk", payloads: [[]] },
    {
      name: "missing finish reason",
      payloads: [delta({ content: "partial" }), usage()],
    },
    {
      name: "missing tool ID",
      payloads: [
        delta({
          tool_calls: [
            { index: 0, type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        }),
        delta({}, "tool_calls"),
        usage(),
      ],
    },
    {
      name: "missing tool name",
      payloads: [
        delta({
          tool_calls: [
            { index: 0, id: "call-1", type: "function", function: { arguments: "{}" } },
          ],
        }),
        delta({}, "tool_calls"),
        usage(),
      ],
    },
    {
      name: "non-contiguous tool indexes",
      payloads: [
        delta({
          tool_calls: [
            {
              index: 0,
              id: "call-0",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
            {
              index: 2,
              id: "call-2",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        }),
        delta({}, "tool_calls"),
        usage(),
      ],
    },
    {
      name: "duplicate tool IDs",
      payloads: [
        delta({
          tool_calls: [
            {
              index: 0,
              id: "same",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
            {
              index: 1,
              id: "same",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        }),
        delta({}, "tool_calls"),
        usage(),
      ],
    },
  ];

  for (const entry of protocolCases) {
    await t.test(entry.name, async (t) => {
      const baseUrl = await localServer(t, async (_request, response) => {
        if (entry.wire !== undefined) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(entry.wire);
          return;
        }
        await sendSse(response, entry.payloads ?? []);
      });

      const error = await providerErrorOf(
        new DeepSeekChatClient(settings(baseUrl), credentials()).complete(
          emptyRequest(),
          new AbortController().signal,
        ),
      );

      assert.equal(error.kind, "protocol");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, new RegExp(TEST_KEY));
    });
  }
});

test("DeepSeekChatClient treats a stream closed before [DONE] as retryable network failure", async (t) => {
  const baseUrl = await localServer(t, async (_request, response) => {
    await sendSse(
      response,
      [delta({ content: "complete-looking response" }), delta({}, "stop"), usage()],
      { done: false },
    );
  });

  const error = await providerErrorOf(
    new DeepSeekChatClient(settings(baseUrl), credentials()).complete(
      emptyRequest(),
      new AbortController().signal,
    ),
  );

  assert.equal(error.kind, "network");
  assert.equal(error.retryable, true);
});

test("DeepSeekChatClient rejects an oversized event stream", async (t) => {
  const baseUrl = await localServer(t, (_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "content-length": String(MAX_SUCCESS_BODY_BYTES + 1),
    });
    response.end();
  });

  const error = await providerErrorOf(
    new DeepSeekChatClient(settings(baseUrl), credentials()).complete(
      emptyRequest(),
      new AbortController().signal,
    ),
  );

  assert.equal(error.kind, "protocol");
  assert.equal(error.retryable, false);
  assert.match(error.message, /exceeds/);
});

test("DeepSeekChatClient enforces its timeout before response headers arrive", async (t) => {
  const baseUrl = await localServer(t, () => {
    // Leave the response pending until the client aborts the request.
  });

  const error = await providerErrorOf(
    new DeepSeekChatClient(
      settings(baseUrl, { requestTimeoutMs: 25 }),
      credentials(),
    ).complete(emptyRequest(), new AbortController().signal),
  );

  assert.equal(error.kind, "timeout");
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.message, new RegExp(TEST_KEY));
});

test("DeepSeekChatClient keeps the timeout active while reading an SSE stream", async (t) => {
  const baseUrl = await localServer(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    response.write(`data: ${JSON.stringify(delta({ content: "partial" }))}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.end("data: [DONE]\n\n");
  });

  const error = await providerErrorOf(
    new DeepSeekChatClient(
      settings(baseUrl, { requestTimeoutMs: 25 }),
      credentials(),
    ).complete(emptyRequest(), new AbortController().signal),
  );

  assert.equal(error.kind, "timeout");
  assert.equal(error.retryable, true);
});

test("DeepSeekChatClient classifies caller abort while reading an SSE stream", async (t) => {
  let markResponseStarted: (() => void) | undefined;
  const responseStarted = new Promise<void>((resolve) => {
    markResponseStarted = resolve;
  });
  const baseUrl = await localServer(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    response.write(`data: ${JSON.stringify(delta({ content: "partial" }))}\n\n`);
    markResponseStarted?.();
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.end("data: [DONE]\n\n");
  });
  const controller = new AbortController();
  const operation = new DeepSeekChatClient(
    settings(baseUrl),
    credentials(),
  ).complete(emptyRequest(), controller.signal);
  await responseStarted;
  controller.abort(new Error("cancelled by caller"));

  const error = await providerErrorOf(operation);

  assert.equal(error.kind, "cancelled");
  assert.equal(error.retryable, false);
});
