import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import type { TraceEvent } from "../trace/events.js";
import { TerminalUI } from "./terminal-ui.js";

class MemoryWritable extends Writable {
  readonly #chunks: Buffer[] = [];

  public get text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
}

function eventSequence(): (type: string, data: unknown) => TraceEvent {
  let sequence = 0;
  return (type, data) => ({
    version: 1,
    sessionId: "terminal-ui-test",
    sequence: ++sequence,
    time: "2026-08-30T00:00:00.000Z",
    type,
    data,
  });
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

test("TerminalUI streams visible content once while hiding reasoning text", async () => {
  const event = eventSequence();
  const output = new MemoryWritable();
  let now = 1_000;
  const ui = new TerminalUI(output, {
    isTTY: true,
    color: false,
    now: () => now,
  });
  await ui.write(event("model_request_started", { turn: 1, attempt: 1 }));

  ui.onModelStreamEvent({
    type: "reasoning_delta",
    delta: "private chain of thought\u001b[31mSECRET",
  });
  now = 1_250;
  ui.onModelStreamEvent({
    type: "content_delta",
    delta: "Hello \u001b[31mworld\r\n",
  });

  assert.equal(ui.finalAnswerWasStreamed, false);
  await ui.write(
    event("model_response", {
      turn: 1,
      finishReason: "stop",
      content: "Hello \u001b[31mworld\r\n",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );

  assert.equal(ui.finalAnswerWasStreamed, true);
  assert.match(output.text, /◇ Thought 250ms · \d+ chars/);
  assert.match(output.text, /◆ Nash\nHello \\x1b\[31mworld\n/);
  assert.equal(occurrences(output.text, "Hello"), 1);
  assert.doesNotMatch(output.text, /private chain of thought|SECRET/);
  assert.equal(output.text.includes("\u001b[31m"), false);
});

test("TerminalUI renders tool lifecycle as a bounded card with sanitized output", async () => {
  const event = eventSequence();
  const output = new MemoryWritable();
  let now = 10_000;
  const ui = new TerminalUI(output, {
    isTTY: true,
    color: false,
    now: () => now,
  });
  await ui.write(event("model_request_started", { turn: 1, attempt: 1 }));
  ui.onModelStreamEvent({ type: "reasoning_delta", delta: "hidden" });
  ui.onModelStreamEvent({
    type: "tool_call_delta",
    index: 0,
    nameDelta: "run_",
    argumentsDelta: '{"command":"printf ',
  });
  ui.onModelStreamEvent({
    type: "tool_call_delta",
    index: 0,
    nameDelta: "command",
    argumentsDelta: 'boom"}',
  });
  await ui.write(
    event("model_response", {
      turn: 1,
      finishReason: "tool_calls",
      content: null,
      toolCalls: [
        { id: "call-1", name: "run_command", arguments: "{}" },
      ],
    }),
  );
  assert.equal(ui.finalAnswerWasStreamed, false);

  now = 20_000;
  await ui.write(
    event("tool_started", {
      turn: 1,
      index: 0,
      call: {
        id: "call-1",
        name: "run_command",
        arguments: '{"command":"printf \\u001b[31mboom"}',
      },
    }),
  );
  now = 20_250;
  await ui.write(
    event("tool_finished", {
      turn: 1,
      index: 0,
      callId: "call-1",
      toolName: "run_command",
      result: {
        isError: false,
        content:
          "command completed\nfirst\u001b[31m\nsecond\nthird\nfourth must be omitted",
        metadata: { exit_code: 0 },
      },
    }),
  );

  assert.match(output.text, /╭─ Bash  printf \\x1b\[31mboom/);
  assert.match(output.text, /│  first\\x1b\[31m/);
  assert.match(output.text, /│  second/);
  assert.match(output.text, /│  third/);
  assert.doesNotMatch(output.text, /fourth must be omitted/);
  assert.match(output.text, /╰─ ✓ exit 0 · 250ms/);
  assert.equal(output.text.includes("\u001b[31m"), false);
  assert.doesNotMatch(output.text, /hidden/);
});

test("TerminalUI throttles status redraws while preserving transition and final counts", async () => {
  const event = eventSequence();
  const output = new MemoryWritable();
  let now = 1_000;
  const ui = new TerminalUI(output, {
    isTTY: true,
    color: false,
    now: () => now,
  });
  const clearLine = "\r\u001b[2K";

  await ui.write(event("model_request_started", { turn: 1, attempt: 1 }));
  assert.equal(occurrences(output.text, clearLine), 1);
  assert.match(output.text, /◇ Thinking…$/);

  for (let index = 0; index < 100; index++) {
    ui.onModelStreamEvent({ type: "reasoning_delta", delta: "x" });
  }
  assert.equal(occurrences(output.text, clearLine), 1);

  now = 1_079;
  ui.onModelStreamEvent({ type: "reasoning_delta", delta: "y" });
  assert.equal(occurrences(output.text, clearLine), 1);

  now = 1_080;
  ui.onModelStreamEvent({ type: "reasoning_delta", delta: "z" });
  assert.equal(occurrences(output.text, clearLine), 2);
  assert.match(output.text, /◇ Thinking… 102 chars$/);

  for (let index = 0; index < 8; index++) {
    ui.onModelStreamEvent({ type: "reasoning_delta", delta: "r" });
  }
  assert.equal(occurrences(output.text, clearLine), 2);

  ui.onModelStreamEvent({
    type: "tool_call_delta",
    index: 0,
    nameDelta: "run_command",
    argumentsDelta: "{",
  });
  assert.equal(occurrences(output.text, clearLine), 3);
  assert.match(
    output.text,
    /◇ Preparing Bash… 110 thinking chars · 1 argument chars$/,
  );

  for (let index = 0; index < 100; index++) {
    ui.onModelStreamEvent({
      type: "tool_call_delta",
      index: 0,
      argumentsDelta: "a",
    });
  }
  assert.equal(occurrences(output.text, clearLine), 3);

  now = 1_159;
  ui.onModelStreamEvent({
    type: "tool_call_delta",
    index: 0,
    argumentsDelta: "b",
  });
  assert.equal(occurrences(output.text, clearLine), 3);

  now = 1_160;
  ui.onModelStreamEvent({
    type: "tool_call_delta",
    index: 0,
    argumentsDelta: "c",
  });
  assert.equal(occurrences(output.text, clearLine), 4);
  assert.match(
    output.text,
    /◇ Preparing Bash… 110 thinking chars · 103 argument chars$/,
  );

  await ui.write(
    event("model_response", {
      turn: 1,
      finishReason: "tool_calls",
      content: null,
      toolCalls: [
        { id: "call-1", name: "run_command", arguments: "{}" },
      ],
    }),
  );
  assert.equal(occurrences(output.text, clearLine), 5);
  assert.match(output.text, /◇ Thought 160ms · 110 chars\n$/);
});

test("TerminalUI non-TTY mode stays deterministic and ignores ephemeral deltas", async () => {
  const event = eventSequence();
  const output = new MemoryWritable();
  const ui = new TerminalUI(output, {
    isTTY: false,
    color: false,
    now: () => 1_000,
  });

  await ui.write(event("session_started", {}));
  await ui.write(event("model_request_started", { turn: 1, attempt: 1 }));
  ui.onModelStreamEvent({
    type: "reasoning_delta",
    delta: "must not appear",
  });
  ui.onModelStreamEvent({
    type: "content_delta",
    delta: "must not appear either",
  });
  await ui.write(
    event("tool_started", {
      call: {
        id: "call-1",
        name: "write_file",
        arguments: '{"path":"game.ts"}',
      },
    }),
  );
  await ui.write(
    event("tool_finished", {
      callId: "call-1",
      toolName: "write_file",
      result: {
        isError: false,
        content: "ok",
        metadata: { path: "game.ts", bytes: 12 },
      },
    }),
  );
  await ui.write(
    event("model_response", {
      finishReason: "stop",
      content: "final",
      toolCalls: [],
    }),
  );

  assert.equal(ui.finalAnswerWasStreamed, false);
  assert.equal(
    output.text,
    [
      "#001 session started",
      "#002 turn 1 · model attempt 1",
      "#003 → write_file · game.ts",
      "#004 ✓ write_file · game.ts",
      "#005 model returned stop",
      "",
    ].join("\n"),
  );
  assert.equal(output.text.includes("\u001b"), false);
  assert.doesNotMatch(output.text, /must not appear/);
});
