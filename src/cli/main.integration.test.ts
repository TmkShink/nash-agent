import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readTrace } from "../session/trace-reader.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN_PATH = path.join(REPOSITORY_ROOT, "src", "cli", "main.ts");
const FAKE_API_KEY = "nash-cli-integration-fake-key";
const MODEL = "mock-deepseek-model";
const TASK = "Create the requested integration-test artifact";
const TARGET_PATH = "generated.txt";
const FILE_CONTENT = "created by the Nash CLI integration test\n";
const FINAL_ANSWER = "The integration-test artifact is ready.";
const REASONING_CONTENT = "opaque reasoning state for the next model turn";
const TOOL_CALL_ID = "write-generated-file";
const TOOL_ARGUMENTS = `{ "path" : ${JSON.stringify(TARGET_PATH)}, "content" : ${JSON.stringify(FILE_CONTENT)} }`;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const CHILD_TIMEOUT_MS = 8_000;

interface CapturedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

interface MockServer {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  readonly failure: Error | undefined;
}

interface ChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface CapturedOutput {
  readonly chunks: Buffer[];
  bytes: number;
}

async function openMockServer(t: test.TestContext): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  let failure: Error | undefined;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
      if (!response.headersSent) {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json");
      }
      response.end(JSON.stringify({ error: { message: "invalid mock request" } }));
    });
  });
  server.requestTimeout = 2_000;
  server.headersTimeout = 2_000;

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: await readJsonBody(request),
    });
    if (requests.length === 1) {
      sendJson(response, {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              reasoning_content: REASONING_CONTENT,
              tool_calls: [
                {
                  id: TOOL_CALL_ID,
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: TOOL_ARGUMENTS,
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      });
      return;
    }
    if (requests.length === 2) {
      assertSecondRequestBody(requests[1]?.body);
      sendJson(response, {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: FINAL_ANSWER },
          },
        ],
        usage: { prompt_tokens: 18, completion_tokens: 6 },
      });
      return;
    }
    sendJson(response, { error: { message: "unexpected model turn" } }, 400);
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    get failure() {
      return failure;
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error(`mock request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function runCli(
  t: test.TestContext,
  workspace: string,
  baseUrl: string,
): Promise<ChildResult> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NASH_API_KEY;
  Object.assign(environment, {
    DEEPSEEK_API_KEY: FAKE_API_KEY,
    NASH_BASE_URL: baseUrl,
    NASH_MODEL: MODEL,
    NASH_THINKING: "enabled",
    NASH_REASONING_EFFORT: "high",
    NASH_REQUEST_TIMEOUT_SECONDS: "2",
    NASH_MAX_OUTPUT_TOKENS: "1024",
  });

  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      MAIN_PATH,
      "run",
      "--yes",
      "--workspace",
      workspace,
      TASK,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });

  const output: Record<"stdout" | "stderr", CapturedOutput> = {
    stdout: { chunks: [], bytes: 0 },
    stderr: { chunks: [], bytes: 0 },
  };
  let outputFailure: Error | undefined;
  const capture = (name: "stdout" | "stderr", chunk: Buffer | string): void => {
    if (outputFailure !== undefined) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const destination = output[name];
    destination.bytes += buffer.byteLength;
    if (destination.bytes > MAX_CHILD_OUTPUT_BYTES) {
      outputFailure = new Error(
        `CLI ${name} exceeds ${MAX_CHILD_OUTPUT_BYTES} bytes`,
      );
      child.kill("SIGKILL");
      return;
    }
    destination.chunks.push(buffer);
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, CHILD_TIMEOUT_MS);
  try {
    const result = await new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    if (timedOut) {
      throw new Error(`CLI did not exit within ${CHILD_TIMEOUT_MS}ms`);
    }
    if (outputFailure !== undefined) {
      throw outputFailure;
    }
    return {
      ...result,
      stdout: Buffer.concat(output.stdout.chunks, output.stdout.bytes).toString(
        "utf8",
      ),
      stderr: Buffer.concat(output.stderr.chunks, output.stderr.bytes).toString(
        "utf8",
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function assertSecondRequestBody(value: unknown): void {
  const body = record(value, "second request");
  assert.equal(body.model, MODEL);
  const messages = array(body.messages, "second messages");
  assert.equal(messages.length, 4);
  assert.equal(record(messages[0], "system message").role, "system");
  assert.deepEqual(messages[1], { role: "user", content: TASK });
  assert.deepEqual(messages[2], {
    role: "assistant",
    content: null,
    reasoning_content: REASONING_CONTENT,
    tool_calls: [
      {
        id: TOOL_CALL_ID,
        type: "function",
        function: { name: "write_file", arguments: TOOL_ARGUMENTS },
      },
    ],
  });
  const toolResultMessage = record(messages[3], "tool result message");
  assert.equal(toolResultMessage.role, "tool");
  assert.equal(toolResultMessage.tool_call_id, TOOL_CALL_ID);
  const toolResultContent = toolResultMessage.content;
  if (typeof toolResultContent !== "string") {
    assert.fail("tool result content must be a string");
  }
  assert.deepEqual(JSON.parse(toolResultContent), {
    content: `wrote ${Buffer.byteLength(FILE_CONTENT)} bytes to ${TARGET_PATH}`,
    isError: false,
    metadata: {
      path: TARGET_PATH,
      bytes: Buffer.byteLength(FILE_CONTENT),
    },
  });
}

test(
  "CLI run preserves DeepSeek reasoning and tool state through a real write",
  { timeout: 15_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "nash-cli-integration-"),
    );
    t.after(async () => {
      await rm(workspace, { recursive: true, force: true });
    });
    const mock = await openMockServer(t);

    const result = await runCli(t, workspace, mock.baseUrl);

    assert.equal(result.stderr.includes(FAKE_API_KEY), false);
    const mockFailure = mock.failure;
    if (mockFailure !== undefined) {
      throw mockFailure;
    }
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, `${FINAL_ANSWER}\n`);
    assert.equal(
      await readFile(path.join(workspace, TARGET_PATH), "utf8"),
      FILE_CONTENT,
    );
    assert.match(result.stderr, /Nash session /);
    assert.match(result.stderr, /#001 session started/);
    assert.match(result.stderr, /model requested write_file/);
    assert.match(result.stderr, /✓ write_file/);
    assert.match(result.stderr, /session finished · final_answer/);

    assert.equal(mock.requests.length, 2);
    for (const request of mock.requests) {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/chat/completions");
      assert.equal(request.authorization, `Bearer ${FAKE_API_KEY}`);
      assert.match(request.contentType ?? "", /^application\/json/);
    }

    const firstBody = record(mock.requests[0]?.body, "first request");
    const firstMessages = array(firstBody.messages, "first messages");
    assert.equal(record(firstMessages[1], "user message").content, TASK);
    const tools = array(firstBody.tools, "tools");
    assert.ok(
      tools.some(
        (tool) =>
          record(record(tool, "tool").function, "tool function").name ===
          "write_file",
      ),
    );

    const sessionsDirectory = path.join(workspace, ".nash", "sessions");
    const traceFiles = await readdir(sessionsDirectory, { withFileTypes: true });
    assert.equal(traceFiles.length, 1);
    const traceFile = traceFiles[0];
    if (traceFile === undefined) {
      assert.fail("session trace is missing");
    }
    assert.ok(traceFile.isFile());
    assert.match(traceFile.name, /\.jsonl$/);
    const events = await readTrace(path.join(sessionsDirectory, traceFile.name));
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "session_started",
        "model_request_started",
        "model_response",
        "tool_started",
        "tool_finished",
        "model_request_started",
        "model_response",
        "session_finished",
      ],
    );
    assert.equal(
      path.basename(traceFile.name, ".jsonl"),
      events[0]?.sessionId,
    );
    const finished = events.at(-1);
    assert.equal(finished?.type, "session_finished");
    const finalData = record(finished?.data, "session_finished data");
    assert.equal(finalData.stopReason, "final_answer");
    assert.equal(finalData.finalAnswer, FINAL_ANSWER);
    assert.equal(finalData.turns, 2);
    assert.equal(finalData.toolCalls, 1);
  },
);
