import type { ToolCall, ToolDefinition } from "../core/types.js";
import {
  type Approver,
  type LocalTool,
  ToolInputError,
  type ToolExecutor,
  type ToolResult,
  failure,
} from "./types.js";

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class ToolRegistry implements ToolExecutor {
  readonly #tools: ReadonlyMap<string, LocalTool>;
  public readonly definitions: readonly ToolDefinition[];

  public constructor(tools: readonly LocalTool[]) {
    const byName = new Map<string, LocalTool>();
    for (const tool of tools) {
      const { definition } = tool;
      if (!TOOL_NAME_PATTERN.test(definition.name)) {
        throw new Error(`invalid tool name ${JSON.stringify(definition.name)}`);
      }
      if (definition.description.trim() === "") {
        throw new Error(`tool ${JSON.stringify(definition.name)} has no description`);
      }
      if (byName.has(definition.name)) {
        throw new Error(`duplicate tool ${JSON.stringify(definition.name)}`);
      }
      byName.set(definition.name, tool);
    }
    this.#tools = byName;
    this.definitions = [...byName.values()]
      .map((tool) => tool.definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async execute(
    call: ToolCall,
    approver: Approver | undefined,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      return failure(`unknown tool ${JSON.stringify(call.name)}`, "unknown_tool");
    }
    if (signal.aborted) {
      return failure("tool call was cancelled", "cancelled");
    }

    let prepared;
    try {
      prepared = tool.prepare(call.arguments);
    } catch (error) {
      if (error instanceof ToolInputError) {
        return failure(error.message, error.kind);
      }
      return failure("tool argument preparation failed", "tool_runtime_error");
    }

    if (approver === undefined) {
      return failure("tool approval policy is unavailable", "approval_error");
    }
    let allowed: boolean;
    try {
      allowed = await approver.approve(
        { toolName: call.name, effect: tool.effect, preview: prepared.preview },
        signal,
      );
    } catch (error) {
      return failure(`tool approval failed: ${messageOf(error)}`, "approval_error");
    }
    if (!allowed) {
      return failure("tool call was denied by the approval policy", "denied");
    }
    if (signal.aborted) {
      return failure("tool call was cancelled", "cancelled");
    }

    try {
      const result = await prepared.execute(signal);
      return result.content.trim() === ""
        ? { ...result, content: "tool returned no content" }
        : result;
    } catch (error) {
      return failure(`tool execution failed: ${messageOf(error)}`, "tool_runtime_error");
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
