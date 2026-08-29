#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CodingAgent, type AgentOutcome } from "../agent/coding-agent.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { DeepSeekChatClient } from "../provider/deepseek-chat-client.js";
import { formatTraceInspection } from "../session/inspect-trace.js";
import { replayTrace } from "../session/replay-trace.js";
import {
  prepareSessionDirectory,
  resolveTraceReference,
} from "../session/session-paths.js";
import { readTrace } from "../session/trace-reader.js";
import { safeDisplay } from "../text/safe-display.js";
import { createDefaultTools } from "../tools/default-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { AllowAllApprover } from "../tools/types.js";
import { EventBus, newSessionId } from "../trace/events.js";
import { FileEventSink } from "../trace/file-event-sink.js";
import { Workspace } from "../workspace/workspace.js";
import {
  CLI_USAGE,
  CliUsageError,
  parseCliArguments,
  type ReplayCommand,
  type RunCommand,
} from "./arguments.js";
import { ConsoleEventSink } from "./console-event-sink.js";
import { openTerminalApprover } from "./interactive-approver.js";

export async function main(arguments_ = process.argv.slice(2)): Promise<number> {
  try {
    const command = parseCliArguments(arguments_);
    switch (command.kind) {
      case "help":
        process.stdout.write(`${CLI_USAGE}\n`);
        return 0;
      case "run":
        return await runAgent(command);
      case "inspect": {
        const workspace = await Workspace.open(command.workspace);
        const tracePath = await resolveTraceReference(workspace, command.reference);
        const events = await readTrace(tracePath);
        process.stdout.write(formatTraceInspection(tracePath, events));
        return 0;
      }
      case "replay":
        return await replaySession(command);
    }
  } catch (error) {
    const message = safeDisplay(messageOf(error), 2_000);
    process.stderr.write(`nash: ${message}\n`);
    if (error instanceof CliUsageError) {
      process.stderr.write(`\n${CLI_USAGE}\n`);
      return 2;
    }
    return 1;
  }
}

async function runAgent(command: RunCommand): Promise<number> {
  const runtime = loadRuntimeConfig();
  const workspace = await Workspace.open(command.workspace);
  const provider = {
    ...runtime.provider,
    ...(command.model === undefined ? {} : { model: command.model }),
  };
  const sessionId = newSessionId();
  const sessionDirectory = await prepareSessionDirectory(workspace);
  const fileSink = await FileEventSink.open(sessionDirectory, sessionId);
  let eventBus: EventBus | undefined;
  let terminalApproval: ReturnType<typeof openTerminalApprover> | undefined;
  let cancellation: ReturnType<typeof installCancellation> | undefined;
  let outcome: AgentOutcome;
  try {
    eventBus = new EventBus(sessionId, [
      fileSink,
      new ConsoleEventSink(process.stderr),
    ]);
    terminalApproval = command.allowAll ? undefined : openTerminalApprover();
    const approver = command.allowAll
      ? new AllowAllApprover()
      : terminalApproval?.approver;
    if (approver === undefined) {
      throw new Error("approval policy could not be initialized");
    }

    process.stderr.write(
      [
        `Nash session ${sessionId}`,
        `workspace: ${workspace.root}`,
        `model: ${provider.model}`,
        `trace: ${workspace.relative(fileSink.path)}`,
        command.allowAll
          ? "warning: --yes approves writes and unsandboxed shell commands"
          : "reads are automatic; writes and commands require approval",
        "",
      ].join("\n"),
    );

    cancellation = installCancellation("Cancelling Nash…");
    const agent = new CodingAgent({
      model: new DeepSeekChatClient(provider, runtime.credentials),
      tools: new ToolRegistry(createDefaultTools(workspace)),
      approver,
      events: eventBus,
      limits: command.limits,
    });
    outcome = await agent.run(command.task, cancellation.signal);
  } finally {
    cancellation?.close();
    terminalApproval?.close();
    if (eventBus === undefined) {
      await fileSink.close();
    } else {
      await eventBus.close();
    }
  }

  if (outcome.finalAnswer !== undefined) {
    process.stdout.write(`${outcome.finalAnswer}${outcome.finalAnswer.endsWith("\n") ? "" : "\n"}`);
  }
  if (outcome.error !== undefined) {
    process.stderr.write(`nash: ${safeDisplay(outcome.error, 2_000)}\n`);
  }
  if (outcome.stopReason === "final_answer") {
    return 0;
  }
  return outcome.stopReason === "cancelled" ? 130 : 1;
}

async function replaySession(command: ReplayCommand): Promise<number> {
  const workspace = await Workspace.open(command.workspace);
  const tracePath = await resolveTraceReference(workspace, command.reference);
  const events = await readTrace(tracePath);
  const cancellation = installCancellation("Stopping replay…");
  try {
    await replayTrace(
      events,
      command.speed,
      new ConsoleEventSink(process.stdout),
      cancellation.signal,
    );
    return 0;
  } finally {
    cancellation.close();
  }
}

function installCancellation(message: string): {
  readonly signal: AbortSignal;
  readonly close: () => void;
} {
  const controller = new AbortController();
  const cancel = (): void => {
    if (!controller.signal.aborted) {
      process.stderr.write(`\n${message}\n`);
      controller.abort(new Error(message));
    }
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return {
    signal: controller.signal,
    close: () => {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
