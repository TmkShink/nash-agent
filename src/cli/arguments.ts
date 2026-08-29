import type { AgentLimits } from "../agent/coding-agent.js";

export const CLI_USAGE = `Nash coding agent

Usage:
  nash run [options] <task>
  nash inspect [--workspace <path>] <session-id|trace.jsonl>
  nash replay [--workspace <path>] [--speed <factor>] <session-id|trace.jsonl>

Run options:
  -w, --workspace <path>  Workspace root (default: current directory)
  --model <name>          Override NASH_MODEL for this run
  --yes                   Approve every tool call; commands are not sandboxed
  --max-turns <count>     Maximum model turns
  --max-tools <count>     Maximum tool calls
  --max-tokens <count>    Maximum accumulated input and output tokens
  --max-duration <secs>   Wall-clock limit in seconds
  -h, --help              Show this message

Replay uses recorded events only and never re-executes a tool. A speed of 0
disables delays; the default is 1.`;

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

interface WorkspaceCommand {
  readonly workspace: string;
}

export interface HelpCommand {
  readonly kind: "help";
}

export interface RunCommand extends WorkspaceCommand {
  readonly kind: "run";
  readonly task: string;
  readonly allowAll: boolean;
  readonly model?: string;
  readonly limits: Partial<AgentLimits>;
}

export interface InspectCommand extends WorkspaceCommand {
  readonly kind: "inspect";
  readonly reference: string;
}

export interface ReplayCommand extends WorkspaceCommand {
  readonly kind: "replay";
  readonly reference: string;
  readonly speed: number;
}

export type CliCommand = HelpCommand | RunCommand | InspectCommand | ReplayCommand;

interface MutableRunLimits {
  maxTurns?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxDurationMs?: number;
}

export function parseCliArguments(
  arguments_: readonly string[],
  currentDirectory = process.cwd(),
): CliCommand {
  if (arguments_.length === 0 || isHelp(arguments_[0])) {
    return { kind: "help" };
  }
  const [command, ...rest] = arguments_;
  if (hasHelpOption(rest)) {
    return { kind: "help" };
  }
  switch (command) {
    case "run":
      return parseRun(rest, currentDirectory);
    case "inspect":
      return parseInspect(rest, currentDirectory);
    case "replay":
      return parseReplay(rest, currentDirectory);
    default:
      throw new CliUsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

function parseRun(arguments_: readonly string[], currentDirectory: string): RunCommand {
  let workspace = currentDirectory;
  let allowAll = false;
  let model: string | undefined;
  const limits: MutableRunLimits = {};
  const task: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index] ?? "";
    if (argument === "--") {
      task.push(...arguments_.slice(index + 1));
      break;
    }
    if (!argument.startsWith("-")) {
      task.push(argument);
      continue;
    }
    if (argument === "--yes") {
      markOnce(seen, argument);
      allowAll = true;
      continue;
    }
    const option = normalizeWorkspaceOption(argument);
    const value = nextValue(arguments_, index, option);
    index++;
    markOnce(seen, option);
    switch (option) {
      case "--workspace":
        workspace = nonBlank(value, option);
        break;
      case "--model":
        model = nonBlank(value, option);
        break;
      case "--max-turns":
        limits.maxTurns = positiveInteger(value, option);
        break;
      case "--max-tools":
        limits.maxToolCalls = positiveInteger(value, option);
        break;
      case "--max-tokens":
        limits.maxTotalTokens = positiveInteger(value, option);
        break;
      case "--max-duration": {
        const seconds = positiveInteger(value, option);
        if (seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
          throw new CliUsageError(`${option} is too large`);
        }
        limits.maxDurationMs = seconds * 1_000;
        break;
      }
      default:
        throw new CliUsageError(`unknown run option ${JSON.stringify(argument)}`);
    }
  }

  const taskText = task.join(" ").trim();
  if (taskText === "") {
    throw new CliUsageError("run requires a non-blank task");
  }
  return {
    kind: "run",
    workspace,
    task: taskText,
    allowAll,
    ...(model === undefined ? {} : { model }),
    limits,
  };
}

function parseInspect(
  arguments_: readonly string[],
  currentDirectory: string,
): InspectCommand {
  const parsed = parseTraceOptions(arguments_, currentDirectory, false);
  return { kind: "inspect", workspace: parsed.workspace, reference: parsed.reference };
}

function parseReplay(
  arguments_: readonly string[],
  currentDirectory: string,
): ReplayCommand {
  const parsed = parseTraceOptions(arguments_, currentDirectory, true);
  return {
    kind: "replay",
    workspace: parsed.workspace,
    reference: parsed.reference,
    speed: parsed.speed,
  };
}

function parseTraceOptions(
  arguments_: readonly string[],
  currentDirectory: string,
  allowSpeed: boolean,
): { readonly workspace: string; readonly reference: string; readonly speed: number } {
  let workspace = currentDirectory;
  let speed = 1;
  const positional: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index] ?? "";
    if (argument === "--") {
      positional.push(...arguments_.slice(index + 1));
      break;
    }
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    const option = normalizeWorkspaceOption(argument);
    const value = nextValue(arguments_, index, option);
    index++;
    markOnce(seen, option);
    if (option === "--workspace") {
      workspace = nonBlank(value, option);
    } else if (allowSpeed && option === "--speed") {
      speed = replaySpeed(value);
    } else {
      throw new CliUsageError(`unknown option ${JSON.stringify(argument)}`);
    }
  }
  const reference = positional[0];
  if (positional.length !== 1 || reference === undefined || reference.trim() === "") {
    throw new CliUsageError("command requires exactly one session reference");
  }
  return { workspace, reference, speed };
}

function normalizeWorkspaceOption(option: string): string {
  return option === "-w" ? "--workspace" : option;
}

function nextValue(
  arguments_: readonly string[],
  index: number,
  option: string,
): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
}

function markOnce(seen: Set<string>, option: string): void {
  if (seen.has(option)) {
    throw new CliUsageError(`${option} may only be specified once`);
  }
  seen.add(option);
}

function nonBlank(value: string, option: string): string {
  if (value.trim() === "") {
    throw new CliUsageError(`${option} requires a non-blank value`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${option} must be a positive integer`);
  }
  return parsed;
}

function replaySpeed(value: string): number {
  if (!/^(?:\d+|\d*\.\d+)$/.test(value)) {
    throw new CliUsageError("--speed must be a number from 0 to 100");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new CliUsageError("--speed must be a number from 0 to 100");
  }
  return parsed;
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

function hasHelpOption(arguments_: readonly string[]): boolean {
  const separator = arguments_.indexOf("--");
  const options = separator === -1 ? arguments_ : arguments_.slice(0, separator);
  return options.some(isHelp);
}
