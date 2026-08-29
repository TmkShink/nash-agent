import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type {
  ProviderCredentials,
  ProviderSettings,
} from "../config/runtime-config.js";
import type { ModelRequest } from "../core/types.js";
import { DeepSeekChatClient } from "./deepseek-chat-client.js";
import { ProviderError } from "./provider-error.js";

const TEST_KEY = "provider-test-secret";

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

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

async function providerErrorOf(operation: Promise<unknown>): Promise<ProviderError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof ProviderError);
    return error;
  }
  assert.fail("expected ProviderError");
}

test("DeepSeekChatClient converts the wire request and normalizes a tool response", async (t) => {
  let receivedRequest: IncomingMessage | undefined;
  let receivedBody: unknown;
  const baseUrl = await localServer(t, async (request, response) => {
    receivedRequest = request;
    receivedBody = await bodyOf(request);
    json(response, {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "opaque next-step reasoning",
            tool_calls: [
              {
                id: "call-2",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{ "path" : "src/main.ts" }',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 21,
        completion_tokens: 8,
        prompt_cache_hit_tokens: 13,
        prompt_cache_miss_tokens: 5,
      },
    });
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

  const result = await new DeepSeekChatClient(
    settings(baseUrl),
    credentials(),
  ).complete(request, new AbortController().signal);

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
    stream: false,
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
          arguments: '{ "path" : "src/main.ts" }',
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

test("DeepSeekChatClient enforces its request timeout", async (t) => {
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

test("DeepSeekChatClient keeps the timeout active while reading a response body", async (t) => {
  const completeBody = JSON.stringify({
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: "late response" },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const baseUrl = await localServer(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    response.write(completeBody.slice(0, 12));
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.end(completeBody.slice(12));
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

test("DeepSeekChatClient rejects malformed JSON and malformed tool calls", async (t) => {
  const invalidResponses: readonly [string, string][] = [
    ["malformed JSON", "{"],
    [
      "missing tool call ID",
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    ],
    [
      "non-string tool arguments",
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: {} },
                },
              ],
            },
          },
        ],
      }),
    ],
  ];

  for (const [name, body] of invalidResponses) {
    await t.test(name, async (t) => {
      const baseUrl = await localServer(t, (_request, response) => {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(body);
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
