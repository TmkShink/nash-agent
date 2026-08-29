import assert from "node:assert/strict";
import test from "node:test";

import type { ToolCall, ToolDefinition } from "../core/types.js";
import { parseArgumentObject } from "./arguments.js";
import { ToolRegistry } from "./registry.js";
import {
  AllowAllApprover,
  type Approver,
  type ApprovalRequest,
  type LocalTool,
  ReadOnlyApprover,
  success,
  type ToolEffect,
} from "./types.js";

const signal = new AbortController().signal;

class ProbeTool implements LocalTool {
  public readonly definition: ToolDefinition;
  public readonly effect: ToolEffect;
  public executions = 0;

  public constructor(name = "probe", effect: ToolEffect = "write") {
    this.definition = {
      name,
      description: "Test probe",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
    this.effect = effect;
  }

  public prepare(argumentsJson: string) {
    parseArgumentObject(argumentsJson, []);
    return {
      preview: "probe",
      execute: async () => {
        this.executions += 1;
        return success("executed");
      },
    };
  }
}

class CountingApprover implements Approver {
  public approvals = 0;

  public constructor(private readonly allowed: boolean) {}

  public async approve(
    _request: ApprovalRequest,
    _signal: AbortSignal,
  ): Promise<boolean> {
    this.approvals += 1;
    return this.allowed;
  }
}

function call(name: string, argumentsJson: string): ToolCall {
  return { id: "call-1", name, arguments: argumentsJson };
}

function kindOf(result: { readonly metadata?: Readonly<Record<string, unknown>> }): unknown {
  return result.metadata?.kind;
}

test("ToolRegistry strictly prepares arguments before asking for approval", async (t) => {
  const invalidCalls: readonly [string, ToolCall, string][] = [
    ["unknown tool", call("missing", "{}"), "unknown_tool"],
    ["malformed JSON", call("probe", "{"), "invalid_arguments"],
    ["unknown field", call("probe", '{"unexpected":true}'), "invalid_arguments"],
  ];

  for (const [name, toolCall, expectedKind] of invalidCalls) {
    await t.test(name, async () => {
      const probe = new ProbeTool();
      const approver = new CountingApprover(true);
      const result = await new ToolRegistry([probe]).execute(
        toolCall,
        approver,
        signal,
      );

      assert.equal(result.isError, true);
      assert.equal(kindOf(result), expectedKind);
      assert.equal(approver.approvals, 0);
      assert.equal(probe.executions, 0);
    });
  }
});

test("ToolRegistry turns an approval denial into a recoverable result", async () => {
  const probe = new ProbeTool();
  const approver = new CountingApprover(false);

  const result = await new ToolRegistry([probe]).execute(
    call("probe", "{}"),
    approver,
    signal,
  );

  assert.equal(result.isError, true);
  assert.equal(kindOf(result), "denied");
  assert.equal(approver.approvals, 1);
  assert.equal(probe.executions, 0);
});

test("ToolRegistry honors allow-all and read-only approval policies", async () => {
  const read = new ProbeTool("read_probe", "read");
  const write = new ProbeTool("write_probe", "write");
  const registry = new ToolRegistry([write, read]);

  assert.deepEqual(
    registry.definitions.map((definition) => definition.name),
    ["read_probe", "write_probe"],
  );
  assert.equal(
    (
      await registry.execute(
        call("read_probe", "{}"),
        new ReadOnlyApprover(),
        signal,
      )
    ).isError,
    false,
  );
  assert.equal(
    kindOf(
      await registry.execute(
        call("write_probe", "{}"),
        new ReadOnlyApprover(),
        signal,
      ),
    ),
    "denied",
  );
  assert.equal(
    (
      await registry.execute(
        call("write_probe", "{}"),
        new AllowAllApprover(),
        signal,
      )
    ).isError,
    false,
  );
});
