import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EventBus,
  type EventSink,
  TRACE_SCHEMA_VERSION,
  newSessionId,
  type TraceEvent,
} from "./events.js";
import { FileEventSink } from "./file-event-sink.js";

async function traceDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nash-trace-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("EventBus serializes concurrent events as ordered parseable JSONL", async (t) => {
  const directory = await traceDirectory(t);
  const sink = await FileEventSink.open(directory, "ordered-session");
  const bus = new EventBus("ordered-session", [sink]);

  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      bus.emit("probe", { index }),
    ),
  );
  await bus.close();

  const lines = (await readFile(sink.path, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 24);
  const events = lines.map((line) => JSON.parse(line) as TraceEvent);
  for (const [index, event] of events.entries()) {
    assert.equal(event.version, TRACE_SCHEMA_VERSION);
    assert.equal(event.sessionId, "ordered-session");
    assert.equal(event.sequence, index + 1);
    assert.equal(event.type, "probe");
    assert.equal((event.data as { readonly index: number }).index, index);
    assert.ok(!Number.isNaN(Date.parse(event.time)));
  }

  assert.equal((await stat(sink.path)).mode & 0o777, 0o600);
});

test("EventBus snapshots data when emit is called", async (t) => {
  const directory = await traceDirectory(t);
  const sink = await FileEventSink.open(directory, "snapshot-session");
  const bus = new EventBus("snapshot-session", [sink]);
  const data = { nested: { value: "before" } };

  const emitted = bus.emit("snapshot", data);
  data.nested.value = "after";
  await emitted;
  await bus.close();

  const event = JSON.parse(
    (await readFile(sink.path, "utf8")).trim(),
  ) as TraceEvent;
  assert.deepEqual(event.data, { nested: { value: "before" } });
});

test("EventBus keeps sink failures sticky and closes every sink", async () => {
  const writeFailure = new Error("sink write failed");
  const failing = new FailingSink(writeFailure);
  const other = new TrackingSink();
  const bus = new EventBus("failing-session", [failing, other]);

  await assert.rejects(bus.emit("first", { index: 0 }), writeFailure);
  await assert.rejects(bus.emit("second", { index: 1 }), writeFailure);
  await assert.rejects(
    bus.close(),
    (error: unknown) =>
      error instanceof AggregateError && error.errors.includes(writeFailure),
  );

  assert.equal(failing.closed, true);
  assert.equal(other.closed, true);
  assert.equal(failing.writes, 1);
  assert.equal(other.writes, 0);
});

test("FileEventSink refuses to clobber an existing session trace", async (t) => {
  const directory = await traceDirectory(t);
  const first = await FileEventSink.open(directory, "duplicate");
  await first.close();

  await assert.rejects(FileEventSink.open(directory, "duplicate"));
});

test("FileEventSink rejects unsafe session identifiers", async (t) => {
  const directory = await traceDirectory(t);
  const invalid = [
    "",
    "../escape",
    "has/slash",
    "-leading",
    "has space",
    "a".repeat(129),
  ];

  for (const sessionId of invalid) {
    await assert.rejects(FileEventSink.open(directory, sessionId));
  }
});

test("newSessionId returns distinct file-safe identifiers", () => {
  const first = newSessionId(new Date("2026-08-30T12:34:56.789Z"));
  const second = newSessionId(new Date("2026-08-30T12:34:56.789Z"));

  assert.match(first, /^20260830T123456Z-[0-9a-f]{8}$/);
  assert.match(second, /^20260830T123456Z-[0-9a-f]{8}$/);
  assert.notEqual(first, second);
});

class FailingSink implements EventSink {
  public writes = 0;
  public closed = false;

  public constructor(private readonly failure: Error) {}

  public async write(_event: TraceEvent): Promise<void> {
    this.writes += 1;
    throw this.failure;
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

class TrackingSink implements EventSink {
  public writes = 0;
  public closed = false;

  public async write(_event: TraceEvent): Promise<void> {
    this.writes += 1;
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}
