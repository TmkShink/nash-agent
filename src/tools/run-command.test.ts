import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Workspace } from "../workspace/workspace.js";
import { ToolRegistry } from "./registry.js";
import { RunCommandTool } from "./run-command.js";
import { AllowAllApprover, type ToolResult } from "./types.js";

const signal = new AbortController().signal;

async function commandTool(
  t: test.TestContext,
): Promise<{ readonly root: string; readonly run: (value: object) => Promise<ToolResult> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nash-command-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await Workspace.open(root);
  const tool = new RunCommandTool(workspace);
  const registry = new ToolRegistry([tool]);
  return {
    root: workspace.root,
    run: async (value) =>
      await registry.execute(
        {
          id: "command-1",
          name: "run_command",
          arguments: JSON.stringify(value),
        },
        new AllowAllApprover(),
        signal,
      ),
  };
}

function kindOf(result: ToolResult): unknown {
  return result.metadata?.kind;
}

test("RunCommandTool uses the workspace and reports nonzero exits as results", async (t) => {
  const { root, run } = await commandTool(t);

  const cwd = await run({ command: "pwd" });
  assert.equal(cwd.isError, false);
  assert.match(cwd.content, new RegExp(escapeRegExp(root)));

  const failed = await run({ command: "printf boom; exit 7" });
  assert.equal(failed.isError, true);
  assert.equal(kindOf(failed), "command_failed");
  assert.equal(failed.metadata?.exit_code, 7);
  assert.match(failed.content, /boom/);
});

test("RunCommandTool terminates a command at its timeout", async (t) => {
  const { run } = await commandTool(t);

  const result = await run({ command: "sleep 5", timeout_seconds: 1 });

  assert.equal(result.isError, true);
  assert.equal(kindOf(result), "timeout");
});

test("RunCommandTool strips sensitive environment variables", async (t) => {
  const previous = {
    apiKey: process.env.NASH_TEST_API_KEY,
    token: process.env.NASH_TEST_TOKEN,
    safe: process.env.NASH_TEST_SAFE,
  };
  process.env.NASH_TEST_API_KEY = "do-not-leak";
  process.env.NASH_TEST_TOKEN = "do-not-leak-either";
  process.env.NASH_TEST_SAFE = "visible";
  t.after(() => {
    restoreEnvironment("NASH_TEST_API_KEY", previous.apiKey);
    restoreEnvironment("NASH_TEST_TOKEN", previous.token);
    restoreEnvironment("NASH_TEST_SAFE", previous.safe);
  });
  const { run } = await commandTool(t);
  const command =
    `printf '%s|%s|%s|%s' ` +
    `"\${NASH_TEST_API_KEY-unset}" "\${NASH_TEST_TOKEN-unset}" ` +
    `"\${NASH_TEST_SAFE-unset}" "\${NASH_AGENT-unset}"`;

  const result = await run({ command });

  assert.equal(result.isError, false);
  assert.match(result.content, /unset\|unset\|visible\|1/);
  assert.doesNotMatch(result.content, /do-not-leak/);
});

test("RunCommandTool keeps bounded head and tail output", async (t) => {
  const { run } = await commandTool(t);
  const command = `awk 'BEGIN { for (i=0; i<70000; i++) printf "x" }'`;

  const result = await run({ command });

  assert.equal(result.isError, false);
  assert.equal(result.metadata?.truncated, true);
  assert.equal(result.metadata?.output_bytes, 70_000);
  assert.match(result.content, /bytes omitted/);
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
