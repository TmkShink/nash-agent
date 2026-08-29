import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
