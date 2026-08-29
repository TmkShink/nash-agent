import assert from "node:assert/strict";
import test from "node:test";

import type { ApprovalRequest } from "../tools/types.js";
import { InteractiveApprover } from "./interactive-approver.js";

const readRequest: ApprovalRequest = {
  toolName: "read_file",
  effect: "read",
  preview: "read README.md",
};
const writeRequest: ApprovalRequest = {
  toolName: "write_file",
  effect: "write",
  preview: "write README.md",
};
const executeRequest: ApprovalRequest = {
  toolName: "run_command",
  effect: "execute",
  preview: "npm test",
};

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

test("InteractiveApprover automatically allows reads without prompting", async () => {
  let questions = 0;
  const approver = new InteractiveApprover(async () => {
    questions += 1;
    return "no";
  });

  assert.equal(await approver.approve(readRequest, activeSignal()), true);
  assert.equal(questions, 0);
});

test("InteractiveApprover denies writes and execution by default", async (t) => {
  for (const answer of ["", "n", "no", "unexpected"]) {
    await t.test(JSON.stringify(answer), async () => {
      const approver = new InteractiveApprover(async () => answer);
      assert.equal(await approver.approve(writeRequest, activeSignal()), false);
      assert.equal(await approver.approve(executeRequest, activeSignal()), false);
    });
  }
});

test("InteractiveApprover yes applies once while all persists", async () => {
  const answers = [" yes ", "no"];
  let yesQuestions = 0;
  const oneShot = new InteractiveApprover(async () => {
    const answer = answers[yesQuestions];
    yesQuestions += 1;
    return answer ?? "no";
  });

  assert.equal(await oneShot.approve(writeRequest, activeSignal()), true);
  assert.equal(await oneShot.approve(executeRequest, activeSignal()), false);
  assert.equal(yesQuestions, 2);

  let allQuestions = 0;
  const allowAll = new InteractiveApprover(async () => {
    allQuestions += 1;
    return " ALL ";
  });
  assert.equal(await allowAll.approve(writeRequest, activeSignal()), true);
  assert.equal(await allowAll.approve(executeRequest, activeSignal()), true);
  assert.equal(await allowAll.approve(writeRequest, activeSignal()), true);
  assert.equal(allQuestions, 1);
});

test("InteractiveApprover propagates cancellation without approving", async () => {
  const reason = new Error("approval cancelled");
  const controller = new AbortController();
  controller.abort(reason);
  let questions = 0;
  const approver = new InteractiveApprover(async () => {
    questions += 1;
    return "yes";
  });

  await assert.rejects(approver.approve(writeRequest, controller.signal), reason);
  assert.equal(questions, 0);

  const during = new AbortController();
  const duringApprover = new InteractiveApprover(async (_question, signal) => {
    during.abort(reason);
    throw signal.reason;
  });
  await assert.rejects(duringApprover.approve(executeRequest, during.signal), reason);
});

test("InteractiveApprover removes raw control characters from the question", async () => {
  let question = "";
  const approver = new InteractiveApprover(async (value) => {
    question = value;
    return "no";
  });
  const request: ApprovalRequest = {
    toolName: "run_command",
    effect: "execute",
    preview: "echo safe\u001b[31m\nnext\tvalue",
  };

  await approver.approve(request, activeSignal());

  assert.match(question, /Approve execute/);
  assert.match(question, /\\x1b\[31m/);
  assert.match(question, /\\nnext\\tvalue/);
  assert.doesNotMatch(question, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
});
