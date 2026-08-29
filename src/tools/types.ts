import type { ToolCall, ToolDefinition } from "../core/types.js";

export type ToolEffect = "read" | "write" | "execute";

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PreparedToolCall {
  readonly preview: string;
  execute(signal: AbortSignal): Promise<ToolResult>;
}

export interface LocalTool {
  readonly definition: ToolDefinition;
  readonly effect: ToolEffect;
  prepare(argumentsJson: string): PreparedToolCall;
}

export interface ApprovalRequest {
  readonly toolName: string;
  readonly effect: ToolEffect;
  readonly preview: string;
}

export interface Approver {
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
}

export class AllowAllApprover implements Approver {
  public async approve(): Promise<boolean> {
    return true;
  }
}

export class ReadOnlyApprover implements Approver {
  public async approve(request: ApprovalRequest): Promise<boolean> {
    return request.effect === "read";
  }
}

export class ToolInputError extends Error {
  public readonly kind: string;

  public constructor(message: string, kind = "invalid_arguments") {
    super(message);
    this.name = "ToolInputError";
    this.kind = kind;
  }
}

export function success(
  content: string,
  metadata?: Readonly<Record<string, unknown>>,
): ToolResult {
  return metadata === undefined
    ? { content, isError: false }
    : { content, isError: false, metadata };
}

export function failure(
  content: string,
  kind: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ToolResult {
  return {
    content,
    isError: true,
    metadata: { ...metadata, kind },
  };
}

export interface ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  execute(
    call: ToolCall,
    approver: Approver | undefined,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
