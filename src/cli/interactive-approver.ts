import { createInterface } from "node:readline/promises";

import { safeDisplay } from "../text/safe-display.js";
import type { Approver, ApprovalRequest } from "../tools/types.js";

export type ApprovalQuestion = (
  question: string,
  signal: AbortSignal,
) => Promise<string>;

export class InteractiveApprover implements Approver {
  readonly #ask: ApprovalQuestion;
  #allowAll = false;

  public constructor(ask: ApprovalQuestion) {
    this.#ask = ask;
  }

  public async approve(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (request.effect === "read" || this.#allowAll) {
      return true;
    }
    if (signal.aborted) {
      throw signal.reason ?? new Error("approval was cancelled");
    }
    const answer = await this.#ask(formatApprovalQuestion(request), signal);
    const normalized = answer.trim().toLowerCase();
    if (normalized === "a" || normalized === "all") {
      this.#allowAll = true;
      return true;
    }
    return normalized === "y" || normalized === "yes";
  }
}

export function openTerminalApprover(): {
  readonly approver: InteractiveApprover;
  readonly close: () => void;
} {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY && process.stderr.isTTY,
  });
  return {
    approver: new InteractiveApprover(
      async (question, signal) => await terminal.question(question, { signal }),
    ),
    close: () => terminal.close(),
  };
}

function formatApprovalQuestion(request: ApprovalRequest): string {
  const action = request.effect === "write" ? "write" : "execute";
  const preview = safeDisplay(request.preview, 500);
  return `\nApprove ${action}: ${preview}\n[y]es / [N]o / approve [a]ll: `;
}
