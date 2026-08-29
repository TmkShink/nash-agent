import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ListFilesTool } from "../tools/list-files.js";
import { ToolRegistry } from "../tools/registry.js";
import { AllowAllApprover } from "../tools/types.js";
import { AgentPathPolicyError } from "./agent-path-policy.js";
import { Workspace, WorkspacePathError } from "./workspace.js";

async function temporaryDirectory(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("Workspace rejects lexical and symlink escapes", async (t) => {
  const root = await temporaryDirectory(t, "nash-workspace-");
  const outside = await temporaryDirectory(t, "nash-outside-");
  const outsideFile = path.join(outside, "outside.txt");
  await writeFile(outsideFile, "outside");
  await symlink(outsideFile, path.join(root, "file-link"));
  await symlink(outside, path.join(root, "directory-link"));
  const workspace = await Workspace.open(root);

  const escapes: readonly [string, () => Promise<string>][] = [
    ["parent traversal", () => workspace.resolveExisting("../outside.txt")],
    ["absolute path", () => workspace.resolveExisting(outsideFile)],
    ["existing symlink", () => workspace.resolveExisting("file-link")],
    [
      "symlinked write parent",
      () => workspace.resolveForWrite("directory-link/new.txt"),
    ],
  ];

  for (const [name, operation] of escapes) {
    await t.test(name, async () => {
      await assert.rejects(operation, WorkspacePathError);
    });
  }
});

test("Workspace resolves existing and new paths under its canonical root", async (t) => {
  const root = await temporaryDirectory(t, "nash-workspace-");
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "existing.txt"), "ok");
  const workspace = await Workspace.open(root);

  assert.equal(
    await workspace.resolveExisting("nested/existing.txt"),
    path.join(workspace.root, "nested", "existing.txt"),
  );
  assert.equal(
    await workspace.resolveForWrite("nested/more/new.txt"),
    path.join(workspace.root, "nested", "more", "new.txt"),
  );
  assert.equal(
    workspace.relative(path.join(workspace.root, "nested", "existing.txt")),
    "nested/existing.txt",
  );
});

test("Workspace blocks credential and state paths but allows shareable env examples", async (t) => {
  const root = await temporaryDirectory(t, "nash-workspace-policy-");
  await writeFile(path.join(root, ".env.local"), "SECRET=value");
  await writeFile(path.join(root, ".env.example"), "SECRET=");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "config"), "config");
  await mkdir(path.join(root, ".nash"));
  await writeFile(path.join(root, ".nash", "state"), "state");
  await symlink(path.join(root, ".env.local"), path.join(root, "safe-name-link"));
  const workspace = await Workspace.open(root);

  for (const protectedPath of [
    ".env.local",
    ".git/config",
    ".nash/state",
    "safe-name-link",
  ]) {
    await assert.rejects(
      workspace.resolveExisting(protectedPath),
      AgentPathPolicyError,
    );
  }
  await assert.rejects(
    workspace.resolveForWrite(".env.production"),
    AgentPathPolicyError,
  );
  assert.equal(
    await workspace.resolveExisting(".env.example"),
    path.join(workspace.root, ".env.example"),
  );
});

test("ListFilesTool hides protected names while retaining shareable examples", async (t) => {
  const root = await temporaryDirectory(t, "nash-workspace-list-policy-");
  await writeFile(path.join(root, ".env.local"), "SECRET=value");
  await writeFile(path.join(root, ".env.example"), "SECRET=");
  await writeFile(path.join(root, "visible.txt"), "visible");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "config"), "config");
  await mkdir(path.join(root, ".nash"));
  await writeFile(path.join(root, ".nash", "trace.jsonl"), "trace");
  await symlink(path.join(root, ".env.local"), path.join(root, "safe-name-link"));
  const workspace = await Workspace.open(root);
  const tool = new ListFilesTool(workspace);

  const result = await new ToolRegistry([tool]).execute(
    { id: "list-1", name: "list_files", arguments: "{}" },
    new AllowAllApprover(),
    new AbortController().signal,
  );

  assert.equal(result.isError, false);
  assert.match(result.content, /^\.env\.example$/m);
  assert.match(result.content, /^visible\.txt$/m);
  assert.match(result.content, /^safe-name-link@$/m);
  assert.doesNotMatch(result.content, /\.env\.local|\.git|\.nash/);
});
