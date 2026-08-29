import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTrace, readTrace } from "./trace-reader.js";

function event(
  sequence: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    time: `2026-08-30T00:00:0${sequence}.000Z`,
    type: sequence === 1 ? "session_started" : "probe",
    data: { sequence },
    ...overrides,
  };
}

function jsonl(events: readonly Record<string, unknown>[]): string {
  return `${events.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

test("parseTrace accepts a strict, continuous single-session JSONL trace", () => {
  const parsed = parseTrace(jsonl([event(1), event(2)]));

  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((value) => value.sequence), [1, 2]);
  assert.deepEqual(parsed.map((value) => value.data), [
    { sequence: 1 },
    { sequence: 2 },
  ]);
});

test("parseTrace rejects schema, session, and sequence discontinuities", () => {
  const invalid = [
    jsonl([event(1, { version: 2 })]),
    jsonl([event(1), event(2, { sessionId: "session-2" })]),
    jsonl([event(1), event(3)]),
  ];

  for (const content of invalid) {
    assert.throws(() => parseTrace(content));
  }
});

test("parseTrace rejects blank and truncated lines", () => {
  const first = JSON.stringify(event(1));
  assert.throws(() => parseTrace(""), /no events/);
  assert.throws(() => parseTrace(`${first}\n\n`), /blank/);
  assert.throws(
    () => parseTrace(`${first}\n{"version":1,"sessionId":`),
    /not valid JSON/,
  );
});

test("parseTrace strictly rejects malformed event fields", () => {
  const missingData = event(1);
  delete missingData.data;
  const invalid: unknown[] = [
    [],
    event(1, { sessionId: "../escape" }),
    event(1, { sequence: 0 }),
    event(1, { sequence: 1.5 }),
    event(1, { time: "not-a-time" }),
    event(1, { type: " " }),
    missingData,
  ];

  for (const value of invalid) {
    assert.throws(() => parseTrace(`${JSON.stringify(value)}\n`));
  }
});

test("parseTrace rejects unknown event fields", () => {
  assert.throws(
    () => parseTrace(jsonl([event(1, { unexpected: true })])),
    /unknown|unexpected/i,
  );
});

test("readTrace rejects directories and parses regular trace files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nash-trace-reader-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const trace = path.join(root, "trace.jsonl");
  await writeFile(trace, jsonl([event(1)]));
  await mkdir(path.join(root, "directory"));

  assert.equal((await readTrace(trace)).length, 1);
  await assert.rejects(readTrace(path.join(root, "directory")), /regular file/);
});
