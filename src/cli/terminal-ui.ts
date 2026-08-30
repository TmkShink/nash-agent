import { once } from "node:events";
import type { Writable } from "node:stream";

import type {
  ModelStreamEvent,
  ModelStreamObserver,
} from "../core/types.js";
import { safeDisplay } from "../text/safe-display.js";
import type { EventSink, TraceEvent } from "../trace/events.js";
import { formatTraceEvent } from "../trace/format-event.js";

export interface TerminalUiOptions {
  readonly isTTY: boolean;
  readonly color: boolean;
  readonly now?: () => number;
}

interface AttemptState {
  readonly startedAt: number;
  readonly toolNames: Map<number, string>;
  reasoningCharacters: number;
  contentCharacters: number;
  toolArgumentCharacters: number;
  contentOpen: boolean;
  contentEndsWithNewline: boolean;
  statusVisible: boolean;
}

interface RunningTool {
  readonly name: string;
  readonly startedAt: number;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[38;5;75m",
  green: "\u001b[38;5;78m",
  red: "\u001b[38;5;203m",
  yellow: "\u001b[38;5;221m",
  violet: "\u001b[38;5;141m",
} as const;

export class TerminalUI implements EventSink, ModelStreamObserver {
  readonly #output: Writable;
  readonly #isTTY: boolean;
  readonly #color: boolean;
  readonly #now: () => number;
  readonly #runningTools = new Map<string, RunningTool>();
  #attempt: AttemptState | undefined;
  #finalAnswerWasStreamed = false;

  public constructor(output: Writable, options: TerminalUiOptions) {
    this.#output = output;
    this.#isTTY = options.isTTY;
    this.#color = options.color;
    this.#now = options.now ?? Date.now;
  }

  public get finalAnswerWasStreamed(): boolean {
    return this.#finalAnswerWasStreamed;
  }

  public onModelStreamEvent(event: ModelStreamEvent): void {
    if (!this.#isTTY) {
      return;
    }
    const attempt = this.#attempt;
    if (attempt === undefined) {
      return;
    }

    switch (event.type) {
      case "reasoning_delta":
        attempt.reasoningCharacters += event.delta.length;
        this.#replaceStatus(this.#thinkingStatus(attempt));
        return;
      case "content_delta": {
        if (!attempt.contentOpen) {
          this.#settleStatus(this.#thoughtSummary(attempt));
          this.#writeImmediate(`\n${this.#paint("cyan", "◆ Nash")}\n`);
          attempt.contentOpen = true;
        }
        const displayed = safeStreamText(event.delta);
        this.#writeImmediate(displayed);
        attempt.contentCharacters += event.delta.length;
        attempt.contentEndsWithNewline = displayed.endsWith("\n");
        return;
      }
      case "tool_call_delta": {
        if (event.nameDelta !== undefined) {
          const current = attempt.toolNames.get(event.index) ?? "";
          attempt.toolNames.set(event.index, current + event.nameDelta);
        }
        attempt.toolArgumentCharacters += event.argumentsDelta?.length ?? 0;
        if (!attempt.contentOpen) {
          this.#replaceStatus(this.#toolPreparationStatus(attempt, event.index));
        }
      }
    }
  }

  public async write(event: TraceEvent): Promise<void> {
    if (!this.#isTTY) {
      await this.#write(`${formatTraceEvent(event)}\n`);
      return;
    }

    const data = asRecord(event.data);
    switch (event.type) {
      case "session_started":
        await this.#write(`${this.#paint("cyan", "◆ Nash started")}\n`);
        return;
      case "model_request_started":
        this.#finishDanglingAttempt();
        this.#attempt = {
          startedAt: this.#now(),
          toolNames: new Map(),
          reasoningCharacters: 0,
          contentCharacters: 0,
          toolArgumentCharacters: 0,
          contentOpen: false,
          contentEndsWithNewline: false,
          statusVisible: false,
        };
        this.#replaceStatus(this.#thinkingStatus(this.#attempt));
        return;
      case "model_request_failed":
        this.#finishFailedAttempt(
          safeDisplay(stringField(data, "kind", "unknown"), 60),
        );
        return;
      case "model_retry_scheduled":
        await this.#write(
          `${this.#paint("yellow", "↻ Retrying model")} ${this.#paint("dim", `in ${numberField(data, "delayMs", 0)}ms`)}\n`,
        );
        return;
      case "model_response":
        this.#finishModelResponse(data);
        return;
      case "tool_started":
        await this.#writeToolStarted(data);
        return;
      case "tool_finished":
        await this.#writeToolFinished(data);
        return;
      case "session_finished":
        this.#finishDanglingAttempt();
        await this.#writeSessionFinished(data);
        return;
      default:
        await this.#write(`${formatTraceEvent(event)}\n`);
    }
  }

  public async close(): Promise<void> {
    this.#finishDanglingAttempt();
  }

  #finishModelResponse(data: Record<string, unknown>): void {
    const attempt = this.#attempt;
    if (attempt === undefined) {
      return;
    }
    const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
    const content = typeof data.content === "string" ? data.content : "";

    if (attempt.contentOpen) {
      if (!attempt.contentEndsWithNewline) {
        this.#writeImmediate("\n");
      }
    } else {
      this.#settleStatus(this.#thoughtSummary(attempt));
      if (content !== "") {
        this.#writeImmediate(
          `\n${this.#paint("cyan", "◆ Nash")}\n${safeStreamText(content)}${content.endsWith("\n") ? "" : "\n"}`,
        );
      }
    }

    if (calls.length === 0 && content !== "") {
      this.#finalAnswerWasStreamed = true;
    }
    this.#attempt = undefined;
  }

  async #writeToolStarted(data: Record<string, unknown>): Promise<void> {
    const call = asRecord(data.call);
    const id = stringField(call, "id", "unknown");
    const name = stringField(call, "name", "unknown");
    const detail = summarizeToolArguments(name, stringField(call, "arguments", ""));
    this.#runningTools.set(id, { name, startedAt: this.#now() });
    const label = displayToolName(name);
    await this.#write(
      `\n${this.#paint("violet", "╭─")} ${this.#paint("bold", label)}${detail === "" ? "" : `  ${this.#paint("dim", detail)}`}\n`,
    );
  }

  async #writeToolFinished(data: Record<string, unknown>): Promise<void> {
    const callId = stringField(data, "callId", "unknown");
    const running = this.#runningTools.get(callId);
    this.#runningTools.delete(callId);
    const result = asRecord(data.result);
    const isError = result.isError === true;
    const metadata = asRecord(result.metadata);
    const content = stringField(result, "content", "");
    const name = running?.name ?? stringField(data, "toolName", "unknown");

    if (name === "run_command") {
      for (const line of commandOutputPreview(content)) {
        await this.#write(`${this.#paint("violet", "│")}  ${line}\n`);
      }
    } else if (isError && content !== "") {
      await this.#write(
        `${this.#paint("violet", "│")}  ${this.#paint("red", safeDisplay(firstLine(content), 180))}\n`,
      );
    }

    const durationMs =
      typeof metadata.duration_ms === "number"
        ? metadata.duration_ms
        : running === undefined
          ? undefined
          : Math.max(0, this.#now() - running.startedAt);
    const summary = summarizeToolResult(name, metadata, durationMs);
    const symbol = isError
      ? this.#paint("red", "✗")
      : this.#paint("green", "✓");
    await this.#write(
      `${this.#paint("violet", "╰─")} ${symbol}${summary === "" ? "" : ` ${summary}`}\n`,
    );
  }

  async #writeSessionFinished(data: Record<string, unknown>): Promise<void> {
    const reason = stringField(data, "stopReason", "unknown");
    const success = reason === "final_answer";
    const symbol = success
      ? this.#paint("green", "✓ Done")
      : this.#paint("red", `■ Stopped · ${safeDisplay(reason, 60)}`);
    const turns = numberField(data, "turns", 0);
    const tools = numberField(data, "toolCalls", 0);
    const details = [
      `${turns} ${turns === 1 ? "turn" : "turns"}`,
      `${tools} ${tools === 1 ? "tool" : "tools"}`,
      formatDuration(numberField(data, "durationMs", 0)),
    ].join(" · ");
    await this.#write(
      `\n${this.#paint("dim", "────────────────────────────────────────────────")}\n${symbol} ${this.#paint("dim", details)}\n`,
    );
  }

  #finishFailedAttempt(kind: string): void {
    const attempt = this.#attempt;
    if (attempt?.contentOpen === true && !attempt.contentEndsWithNewline) {
      this.#writeImmediate("\n");
    }
    if (attempt?.statusVisible === true) {
      this.#writeImmediate("\r\u001b[2K");
    }
    this.#writeImmediate(
      `${this.#paint("red", "✗ Model attempt failed")} ${this.#paint("dim", kind)}\n`,
    );
    this.#attempt = undefined;
  }

  #finishDanglingAttempt(): void {
    const attempt = this.#attempt;
    if (attempt === undefined) {
      return;
    }
    if (attempt.contentOpen) {
      if (!attempt.contentEndsWithNewline) {
        this.#writeImmediate("\n");
      }
    } else {
      this.#settleStatus(this.#thoughtSummary(attempt));
    }
    this.#attempt = undefined;
  }

  #thinkingStatus(attempt: AttemptState): string {
    const count = attempt.reasoningCharacters;
    return `${this.#paint("yellow", "◇ Thinking…")}${count === 0 ? "" : ` ${this.#paint("dim", `${formatCount(count)} chars`)}`}`;
  }

  #toolPreparationStatus(attempt: AttemptState, index: number): string {
    const rawName = attempt.toolNames.get(index) ?? "tool";
    const label = rawName === "" ? "tool" : displayToolName(rawName);
    const reasoning =
      attempt.reasoningCharacters === 0
        ? ""
        : `${formatCount(attempt.reasoningCharacters)} thinking chars · `;
    return `${this.#paint("yellow", "◇ Preparing")} ${label}… ${this.#paint("dim", `${reasoning}${formatCount(attempt.toolArgumentCharacters)} argument chars`)}`;
  }

  #thoughtSummary(attempt: AttemptState): string {
    const elapsed = Math.max(0, this.#now() - attempt.startedAt);
    if (attempt.reasoningCharacters === 0) {
      return `${this.#paint("yellow", "◇ Model responded")} ${this.#paint("dim", formatDuration(elapsed))}`;
    }
    return `${this.#paint("yellow", "◇ Thought")} ${this.#paint("dim", `${formatDuration(elapsed)} · ${formatCount(attempt.reasoningCharacters)} chars`)}`;
  }

  #replaceStatus(text: string): void {
    const attempt = this.#attempt;
    if (attempt === undefined || attempt.contentOpen) {
      return;
    }
    attempt.statusVisible = true;
    this.#writeImmediate(`\r\u001b[2K${text}`);
  }

  #settleStatus(text: string): void {
    const attempt = this.#attempt;
    if (attempt?.statusVisible === true) {
      this.#writeImmediate(`\r\u001b[2K${text}\n`);
      attempt.statusVisible = false;
    } else {
      this.#writeImmediate(`${text}\n`);
    }
  }

  #paint(color: keyof typeof ANSI, text: string): string {
    return this.#color ? `${ANSI[color]}${text}${ANSI.reset}` : text;
  }

  #writeImmediate(text: string): void {
    this.#output.write(text);
  }

  async #write(text: string): Promise<void> {
    if (!this.#output.write(text)) {
      await once(this.#output, "drain");
    }
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
    return safeDisplay(stringField(arguments_, "command", ""), 180);
  }
  return safeDisplay(stringField(arguments_, "path", ""), 180);
}

function summarizeToolResult(
  toolName: string,
  metadata: Record<string, unknown>,
  durationMs: number | undefined,
): string {
  const parts: string[] = [];
  if (toolName === "read_file" && typeof metadata.lines_returned === "number") {
    parts.push(`${metadata.lines_returned} lines`);
  } else if (toolName === "list_files" && typeof metadata.entries === "number") {
    parts.push(`${metadata.entries} entries`);
  } else if (toolName === "write_file" && typeof metadata.bytes === "number") {
    parts.push(formatBytes(metadata.bytes));
  } else if (
    toolName === "edit_file" &&
    typeof metadata.bytes_before === "number" &&
    typeof metadata.bytes_after === "number"
  ) {
    parts.push(`${formatBytes(metadata.bytes_before)} → ${formatBytes(metadata.bytes_after)}`);
  } else if (toolName === "run_command" && typeof metadata.exit_code === "number") {
    parts.push(`exit ${metadata.exit_code}`);
  }
  if (durationMs !== undefined) {
    parts.push(formatDuration(durationMs));
  }
  return parts.join(" · ");
}

function commandOutputPreview(content: string): readonly string[] {
  const lines = content.split(/\r\n|\n|\r/).slice(1);
  return lines
    .filter((line) => line.trim() !== "" && line !== "(command produced no output)")
    .slice(0, 3)
    .map((line) => safeDisplay(line, 180));
}

function displayToolName(name: string): string {
  switch (name) {
    case "read_file":
      return "Read";
    case "list_files":
      return "List";
    case "write_file":
      return "Write";
    case "edit_file":
      return "Edit";
    case "run_command":
      return "Bash";
    default:
      return safeDisplay(name, 64);
  }
}

function safeStreamText(value: string): string {
  let displayed = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\n") {
      displayed += "\n";
    } else if (character === "\r") {
      continue;
    } else if (character === "\t") {
      displayed += "    ";
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      displayed += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else if (
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      displayed += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      displayed += character;
    }
  }
  return displayed;
}

function formatCount(value: number): string {
  if (value < 1_000) {
    return String(value);
  }
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${value} B`;
  }
  return `${(value / 1_024).toFixed(1)} KiB`;
}

function formatDuration(value: number): string {
  if (value < 1_000) {
    return `${Math.round(value)}ms`;
  }
  return `${(value / 1_000).toFixed(1)}s`;
}

function firstLine(value: string): string {
  return value.split(/\r\n|\n|\r/, 1)[0] ?? "";
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
  fallback: number,
): number {
  return typeof record[key] === "number" ? record[key] : fallback;
}
