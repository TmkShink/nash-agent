import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { ToolDefinition } from "../core/types.js";
import { HeadTailBuffer } from "../text/head-tail-buffer.js";
import { safeDisplay } from "../text/safe-display.js";
import type { Workspace } from "../workspace/workspace.js";
import {
  objectSchema,
  optionalInteger,
  parseArgumentObject,
  requiredString,
} from "./arguments.js";
import {
  type LocalTool,
  type PreparedToolCall,
  failure,
  success,
} from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 120;
const TERMINATION_GRACE_MS = 500;

export class RunCommandTool implements LocalTool {
  public readonly effect = "execute" as const;
  public readonly definition: ToolDefinition = {
    name: "run_command",
    description:
      "Run a shell command in the workspace. Returns bounded combined output, exit status, and duration. This is not an OS sandbox.",
    parameters: objectSchema(
      {
        command: { type: "string", description: "Shell command to run" },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_SECONDS,
          description: `Timeout in seconds, default ${DEFAULT_TIMEOUT_SECONDS}`,
        },
      },
      ["command"],
    ),
  };

  readonly #workspace: Workspace;

  public constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  public prepare(argumentsJson: string): PreparedToolCall {
    const object = parseArgumentObject(argumentsJson, ["command", "timeout_seconds"]);
    const command = requiredString(object, "command", { nonBlank: true });
    const timeoutSeconds = optionalInteger(
      object,
      "timeout_seconds",
      DEFAULT_TIMEOUT_SECONDS,
      1,
      MAX_TIMEOUT_SECONDS,
    );
    const compact = command.trim().replace(/\s+/g, " ");
    const preview = safeDisplay(compact);
    return {
      preview,
      execute: async (signal) =>
        await runCommand(command, timeoutSeconds, this.#workspace.root, signal),
    };
  }
}

async function runCommand(
  commandText: string,
  timeoutSeconds: number,
  workingDirectory: string,
  signal: AbortSignal,
) {
  if (signal.aborted) {
    return failure("command was cancelled before it started", "cancelled");
  }

  const output = new HeadTailBuffer(48 * 1024, 16 * 1024);
  const started = performance.now();
  const detached = process.platform !== "win32";

  return await new Promise<ReturnType<typeof success>>((resolve) => {
    const child = spawn("/bin/sh", ["-lc", commandText], {
      cwd: workingDirectory,
      env: sanitizedEnvironment(process.env),
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => output.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.write(chunk));

    const terminate = (): void => {
      if (child.pid === undefined || child.killed) {
        return;
      }
      killProcess(child.pid, "SIGTERM", detached);
      forceKillTimer = setTimeout(() => {
        if (child.pid !== undefined) {
          killProcess(child.pid, "SIGKILL", detached);
        }
      }, TERMINATION_GRACE_MS);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutSeconds * 1_000);
    timeout.unref();

    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = (
      exitCode: number,
      exitSignal: NodeJS.Signals | null,
      spawnError?: Error,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      signal.removeEventListener("abort", onAbort);
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const rawOutput = output.toString();
      const retainedOutput = rawOutput.trim() === "" ? "(command produced no output)" : rawOutput;
      const summary = `exit=${exitCode} duration=${durationMs}ms\n${retainedOutput}`;
      const metadata = {
        exit_code: exitCode,
        signal: exitSignal,
        duration_ms: durationMs,
        output_bytes: output.totalBytes,
        truncated: output.truncated,
      };

      if (spawnError !== undefined) {
        resolve(failure(`cannot start command: ${spawnError.message}`, "spawn_error", metadata));
      } else if (cancelled) {
        resolve(failure(summary, "cancelled", metadata));
      } else if (timedOut) {
        resolve(failure(summary, "timeout", metadata));
      } else if (exitCode !== 0) {
        resolve(failure(summary, "command_failed", metadata));
      } else {
        resolve(success(summary, metadata));
      }
    };

    child.once("error", (error) => finish(-1, null, error));
    child.once("close", (code, exitSignal) => finish(code ?? -1, exitSignal));
  });
}

function killProcess(pid: number, signal: NodeJS.Signals, processGroup: boolean): void {
  try {
    process.kill(processGroup ? -pid : pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch {
        // The process may have exited between the two kill attempts.
      }
    }
  }
}

export function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !isSensitiveEnvironmentKey(key)) {
      result[key] = value;
    }
  }
  result.NASH_AGENT = "1";
  return result;
}

function isSensitiveEnvironmentKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (
    upper === "SSH_AUTH_SOCK" ||
    upper === "GIT_ASKPASS" ||
    upper === "DEEPSEEK_API_KEY" ||
    upper === "NASH_API_KEY"
  ) {
    return true;
  }
  return [
    "API_KEY",
    "ACCESS_KEY",
    "PRIVATE_KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "COOKIE",
    "BEARER",
  ].some((fragment) => upper.includes(fragment));
}
