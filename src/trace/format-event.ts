import { safeDisplay } from "../text/safe-display.js";
import type { TraceEvent } from "./events.js";

export function formatTraceEvent(event: TraceEvent): string {
  const prefix = `#${String(event.sequence).padStart(3, "0")}`;
  const data = asRecord(event.data);
  switch (event.type) {
    case "session_started":
      return `${prefix} session started`;
    case "model_request_started":
      return `${prefix} turn ${numberField(data, "turn", "?")} · model attempt ${numberField(data, "attempt", "?")}`;
    case "model_request_failed":
      return `${prefix} model request failed · ${safeDisplay(stringField(data, "kind", "unknown"), 40)}${data.retryable === true ? " · retryable" : ""}`;
    case "model_retry_scheduled":
      return `${prefix} retry scheduled · ${numberField(data, "delayMs", 0)}ms`;
    case "model_response": {
      const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
      if (calls.length === 0) {
        return `${prefix} model returned ${safeDisplay(stringField(data, "finishReason", "response"), 40)}`;
      }
      const names = calls
        .map((call) => stringField(asRecord(call), "name", "unknown"))
        .map((name) => safeDisplay(name, 60))
        .join(", ");
      return `${prefix} model requested ${names}`;
    }
    case "tool_started": {
      const call = asRecord(data.call);
      const name = safeDisplay(stringField(call, "name", "unknown"), 60);
      const detail = summarizeToolArguments(name, stringField(call, "arguments", ""));
      return `${prefix} → ${name}${detail === "" ? "" : ` · ${detail}`}`;
    }
    case "tool_finished": {
      const name = safeDisplay(stringField(data, "toolName", "unknown"), 60);
      const result = asRecord(data.result);
      return `${prefix} ${result.isError === true ? "✗" : "✓"} ${name}${formatToolMetadata(asRecord(result.metadata))}`;
    }
    case "session_finished":
      return `${prefix} session finished · ${safeDisplay(stringField(data, "stopReason", "unknown"), 60)} · ${numberField(data, "turns", 0)} turns · ${numberField(data, "toolCalls", 0)} tools`;
    default:
      return `${prefix} ${safeDisplay(event.type, 80)}`;
  }
}

function summarizeToolArguments(toolName: string, raw: string): string {
  let arguments_: Record<string, unknown>;
  try {
    arguments_ = asRecord(JSON.parse(raw) as unknown);
  } catch {
    return "";
  }
  if (toolName === "run_command") {
    return safeDisplay(stringField(arguments_, "command", ""), 160);
  }
  return safeDisplay(stringField(arguments_, "path", ""), 160);
}

function formatToolMetadata(metadata: Record<string, unknown>): string {
  if (typeof metadata.exit_code === "number") {
    return ` · exit ${metadata.exit_code}`;
  }
  if (typeof metadata.path === "string") {
    return ` · ${safeDisplay(metadata.path, 160)}`;
  }
  return "";
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

function numberField(
  record: Record<string, unknown>,
  key: string,
  fallback: number | string,
): number | string {
  return typeof record[key] === "number" ? record[key] : fallback;
}
