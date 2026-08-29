import path from "node:path";

import type { TraceEvent } from "../trace/events.js";
import { formatTraceEvent } from "../trace/format-event.js";

export function formatTraceInspection(
  filePath: string,
  events: readonly TraceEvent[],
): string {
  const first = events[0];
  if (first === undefined) {
    throw new Error("cannot inspect an empty trace");
  }
  const finalEvent = [...events].reverse().find((event) => event.type === "session_finished");
  const finalData = asRecord(finalEvent?.data);
  const toolCounts = new Map<string, number>();
  const pendingTools = new Map<string, string>();

  for (const event of events) {
    const data = asRecord(event.data);
    if (event.type === "tool_started") {
      const call = asRecord(data.call);
      const id = stringField(call, "id", `sequence-${event.sequence}`);
      pendingTools.set(id, stringField(call, "name", "unknown"));
    } else if (event.type === "tool_finished") {
      const name = stringField(data, "toolName", "unknown");
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      pendingTools.delete(stringField(data, "callId", ""));
    }
  }

  const last = events.at(-1) ?? first;
  const elapsedMs = Math.max(0, Date.parse(last.time) - Date.parse(first.time));
  const usage = asRecord(finalData.usage);
  const lines = [
    `Session: ${first.sessionId}`,
    `Trace: ${path.relative(process.cwd(), filePath) || path.basename(filePath)}`,
    `Status: ${stringField(finalData, "stopReason", "incomplete")}`,
    `Events: ${events.length}`,
    `Elapsed: ${formatDuration(elapsedMs)}`,
  ];
  if (finalEvent !== undefined) {
    lines.push(
      `Work: ${numberField(finalData, "turns")} turns, ${numberField(finalData, "modelAttempts")} model attempts, ${numberField(finalData, "toolCalls")} tool calls`,
      `Tokens: ${numberField(usage, "inputTokens")} input, ${numberField(usage, "outputTokens")} output`,
    );
  }
  if (toolCounts.size > 0) {
    lines.push(
      `Tools: ${[...toolCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, count]) => `${name}×${count}`)
        .join(", ")}`,
    );
  }
  if (pendingTools.size > 0) {
    lines.push(`Unfinished tools: ${[...pendingTools.values()].join(", ")}`);
  }
  lines.push("", "Timeline:", ...events.map((event) => `  ${formatTraceEvent(event)}`));
  return `${lines.join("\n")}\n`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${milliseconds}ms`;
  }
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return typeof record[key] === "string" ? record[key] : fallback;
}

function numberField(record: Record<string, unknown>, key: string): number {
  return typeof record[key] === "number" ? record[key] : 0;
}
