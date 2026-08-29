import { readFile, stat } from "node:fs/promises";

import {
  TRACE_SCHEMA_VERSION,
  isSessionId,
  type TraceEvent,
} from "../trace/events.js";

const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const MAX_TRACE_EVENTS = 100_000;
const TRACE_EVENT_FIELDS = new Set([
  "version",
  "sessionId",
  "sequence",
  "time",
  "type",
  "data",
]);

export async function readTrace(filePath: string): Promise<readonly TraceEvent[]> {
  const information = await stat(filePath);
  if (!information.isFile()) {
    throw new Error("trace is not a regular file");
  }
  if (information.size > MAX_TRACE_BYTES) {
    throw new Error(`trace exceeds the ${MAX_TRACE_BYTES} byte inspection limit`);
  }
  const content = await readFile(filePath, "utf8");
  if (Buffer.byteLength(content) > MAX_TRACE_BYTES) {
    throw new Error(`trace exceeds the ${MAX_TRACE_BYTES} byte inspection limit`);
  }
  return parseTrace(content);
}

export function parseTrace(content: string): readonly TraceEvent[] {
  if (Buffer.byteLength(content) > MAX_TRACE_BYTES) {
    throw new Error(`trace exceeds the ${MAX_TRACE_BYTES} byte inspection limit`);
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    throw new Error("trace contains no events");
  }
  if (lines.length > MAX_TRACE_EVENTS) {
    throw new Error(`trace exceeds the ${MAX_TRACE_EVENTS} event inspection limit`);
  }

  const events: TraceEvent[] = [];
  let sessionId: string | undefined;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim() === "") {
      throw new Error(`trace line ${lineNumber} is blank`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`trace line ${lineNumber} is not valid JSON`);
    }
    const event = parseEvent(decoded, lineNumber);
    if (sessionId === undefined) {
      sessionId = event.sessionId;
    } else if (event.sessionId !== sessionId) {
      throw new Error(`trace line ${lineNumber} changes the session ID`);
    }
    if (event.sequence !== lineNumber) {
      throw new Error(
        `trace line ${lineNumber} has sequence ${event.sequence}; expected ${lineNumber}`,
      );
    }
    events.push(event);
  }
  if (events[0]?.type !== "session_started") {
    throw new Error("trace must begin with session_started");
  }
  if (events.slice(1).some((event) => event.type === "session_started")) {
    throw new Error("trace contains more than one session_started event");
  }
  const finishedAt = events.findIndex((event) => event.type === "session_finished");
  if (finishedAt !== -1 && finishedAt !== events.length - 1) {
    throw new Error("trace contains events after session_finished");
  }
  return events;
}

function parseEvent(value: unknown, lineNumber: number): TraceEvent {
  const event = requireRecord(value, lineNumber);
  const unknownField = Object.keys(event).find((key) => !TRACE_EVENT_FIELDS.has(key));
  if (unknownField !== undefined) {
    throw new Error(
      `trace line ${lineNumber} contains unknown field ${JSON.stringify(unknownField)}`,
    );
  }
  if (event.version !== TRACE_SCHEMA_VERSION) {
    throw new Error(
      `trace line ${lineNumber} has unsupported schema version ${JSON.stringify(event.version)}`,
    );
  }
  if (typeof event.sessionId !== "string" || !isSessionId(event.sessionId)) {
    throw new Error(`trace line ${lineNumber} has an invalid session ID`);
  }
  if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1) {
    throw new Error(`trace line ${lineNumber} has an invalid sequence`);
  }
  if (typeof event.time !== "string" || !isCanonicalTimestamp(event.time)) {
    throw new Error(`trace line ${lineNumber} has an invalid timestamp`);
  }
  if (typeof event.type !== "string" || event.type.trim() === "") {
    throw new Error(`trace line ${lineNumber} has an invalid event type`);
  }
  if (!("data" in event)) {
    throw new Error(`trace line ${lineNumber} is missing event data`);
  }
  return {
    version: TRACE_SCHEMA_VERSION,
    sessionId: event.sessionId,
    sequence: event.sequence as number,
    time: event.time,
    type: event.type,
    data: event.data,
  };
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return !Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function requireRecord(value: unknown, lineNumber: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`trace line ${lineNumber} must contain an event object`);
  }
  return value as Record<string, unknown>;
}
