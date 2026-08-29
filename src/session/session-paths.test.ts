import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Workspace } from "../workspace/workspace.js";
import {
  prepareSessionDirectory,
  prepareStateDirectory,
  resolveTraceReference,
} from "./session-paths.js";

async function temporaryDirectory(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function temporaryWorkspace(
  t: test.TestContext,
): Promise<{ readonly root: string; readonly workspace: Workspace }> {
  const root = await temporaryDirectory(t, "nash-session-workspace-");
  return { root, workspace: await Workspace.open(root) };
}

test("prepareSessionDirectory creates private real directories", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);

  const directory = await prepareSessionDirectory(workspace);

  assert.equal(directory, path.join(workspace.root, ".nash", "sessions"));
  assert.equal((await stat(path.join(root, ".nash"))).mode & 0o777, 0o700);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("prepareSessionDirectory rejects symlinked state directories", async (t) => {
  await t.test(".nash symlink", async (t) => {
    const { root, workspace } = await temporaryWorkspace(t);
    const outside = await temporaryDirectory(t, "nash-session-outside-");
    await symlink(outside, path.join(root, ".nash"));

    await assert.rejects(prepareSessionDirectory(workspace), /symlink/i);
  });

  await t.test("sessions symlink", async (t) => {
    const { root, workspace } = await temporaryWorkspace(t);
    const outside = await temporaryDirectory(t, "nash-session-outside-");
    await mkdir(path.join(root, ".nash"));
    await symlink(outside, path.join(root, ".nash", "sessions"));

    await assert.rejects(prepareSessionDirectory(workspace), /symlink/i);
  });
});

test("prepareStateDirectory creates a private eval directory", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);

  const directory = await prepareStateDirectory(workspace, "evals");

  assert.equal(directory, path.join(workspace.root, ".nash", "evals"));
  assert.equal((await stat(path.join(root, ".nash"))).mode & 0o777, 0o700);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("prepareStateDirectory rejects unsafe names and a symlinked eval directory", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const name of [
    "",
    "../evals",
    "Evals",
    ".evals",
    "eval_files",
    "evals/nested",
    "1evals",
    "a".repeat(33),
  ]) {
    await assert.rejects(prepareStateDirectory(workspace, name), /invalid/i);
  }

  const symlinkFixture = await temporaryWorkspace(t);
  const outside = await temporaryDirectory(t, "nash-evals-outside-");
  await mkdir(path.join(symlinkFixture.root, ".nash"));
  await symlink(outside, path.join(symlinkFixture.root, ".nash", "evals"));
  await assert.rejects(
    prepareStateDirectory(symlinkFixture.workspace, "evals"),
    /symlink/i,
  );
});

test("resolveTraceReference accepts a session ID and a relative JSONL path", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const sessionId = "20260830T000000Z-deadbeef";
  const sessionDirectory = path.join(root, ".nash", "sessions");
  await mkdir(sessionDirectory, { recursive: true });
  const sessionTrace = path.join(sessionDirectory, `${sessionId}.jsonl`);
  await writeFile(sessionTrace, "trace");
  const relativeTrace = path.join(root, "audit.jsonl");
  await writeFile(relativeTrace, "trace");

  assert.equal(
    await resolveTraceReference(workspace, sessionId),
    path.join(workspace.root, ".nash", "sessions", `${sessionId}.jsonl`),
  );
  assert.equal(
    await resolveTraceReference(workspace, "audit.jsonl"),
    path.join(workspace.root, "audit.jsonl"),
  );
});

test("resolveTraceReference rejects unsafe and non-JSONL paths", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const outside = await temporaryDirectory(t, "nash-trace-outside-");
  const outsideTrace = path.join(outside, "outside.jsonl");
  await writeFile(outsideTrace, "trace");
  await symlink(outsideTrace, path.join(root, "escape.jsonl"));
  await mkdir(path.join(root, "directory.jsonl"));

  const invalid = [
    outsideTrace,
    "../outside.jsonl",
    "reports/trace.txt",
    "reports/no-extension",
    "escape.jsonl",
    "directory.jsonl",
  ];
  for (const reference of invalid) {
    await assert.rejects(resolveTraceReference(workspace, reference));
  }
});
