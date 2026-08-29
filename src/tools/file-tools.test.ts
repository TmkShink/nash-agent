import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Workspace } from "../workspace/workspace.js";
import { EditFileTool } from "./edit-file.js";
import {
  MAX_FILE_READ_BYTES,
  MAX_FILE_WRITE_BYTES,
} from "./file-helpers.js";
import { ListFilesTool } from "./list-files.js";
import { ReadFileTool } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import {
  AllowAllApprover,
  type LocalTool,
  type ToolResult,
} from "./types.js";
import { WriteFileTool } from "./write-file.js";

const signal = new AbortController().signal;

async function temporaryWorkspace(
  t: test.TestContext,
): Promise<{ readonly root: string; readonly workspace: Workspace }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nash-tools-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace: await Workspace.open(root) };
}

async function execute(
  tool: LocalTool,
  argumentsValue: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  return await new ToolRegistry([tool]).execute(
    {
      id: "call-1",
      name: tool.definition.name,
      arguments: JSON.stringify(argumentsValue),
    },
    new AllowAllApprover(),
    signal,
  );
}

function kindOf(result: ToolResult): unknown {
  return result.metadata?.kind;
}

test("ReadFileTool returns a bounded line range with stable numbers", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  await writeFile(path.join(root, "lines.txt"), "one\ntwo\nthree\nfour\n");

  const result = await execute(new ReadFileTool(workspace), {
    path: "lines.txt",
    start_line: 2,
    end_line: 3,
  });

  assert.equal(result.isError, false);
  assert.match(result.content, /     2 \| two\n/);
  assert.match(result.content, /     3 \| three\n/);
  assert.doesNotMatch(result.content, /one|four/);
  assert.equal(result.metadata?.lines_returned, 2);
});

test("ReadFileTool enforces line, output, and source-file limits", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const reader = new ReadFileTool(workspace);
  await writeFile(path.join(root, "small.txt"), "one\n");

  const lineLimited = await execute(reader, {
    path: "small.txt",
    start_line: 1,
    end_line: 501,
  });
  assert.equal(lineLimited.isError, true);
  assert.equal(kindOf(lineLimited), "limit_exceeded");

  const longLine = "x".repeat(1_000);
  await writeFile(path.join(root, "large-output.txt"), `${longLine}\n`.repeat(100));
  const outputLimited = await execute(reader, {
    path: "large-output.txt",
    start_line: 1,
    end_line: 100,
  });
  assert.equal(outputLimited.isError, false);
  assert.equal(outputLimited.metadata?.truncated, true);
  assert.match(outputLimited.content, /output truncated by byte limit/);

  await writeFile(
    path.join(root, "too-large.txt"),
    Buffer.alloc(MAX_FILE_READ_BYTES + 1, "x"),
  );
  const fileLimited = await execute(reader, { path: "too-large.txt" });
  assert.equal(fileLimited.isError, true);
  assert.equal(kindOf(fileLimited), "limit_exceeded");
});

test("ReadFileTool distinguishes binary and invalid UTF-8 files", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const reader = new ReadFileTool(workspace);
  await writeFile(path.join(root, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xff, 0xfe, 0x61]));

  const binary = await execute(reader, { path: "binary.txt" });
  assert.equal(binary.isError, true);
  assert.equal(kindOf(binary), "binary_file");

  const invalid = await execute(reader, { path: "invalid.txt" });
  assert.equal(invalid.isError, true);
  assert.equal(kindOf(invalid), "invalid_encoding");
});

test("ListFilesTool applies depth, ignore, and entry limits without following symlinks", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "nash-list-outside-"));
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "a.txt"), "a");
  await writeFile(path.join(root, "b.txt"), "b");
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "child.txt"), "child");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "hidden"), "hidden");
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "hidden"), "hidden");
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(outside, path.join(root, "outside-link"));
  const lister = new ListFilesTool(workspace);

  const depthOne = await execute(lister, {
    path: ".",
    max_depth: 1,
    max_entries: 20,
  });
  assert.equal(depthOne.isError, false);
  assert.match(depthOne.content, /nested\/\n/);
  assert.match(depthOne.content, /outside-link@\n/);
  assert.doesNotMatch(depthOne.content, /child\.txt|secret\.txt|\.git|node_modules/);

  const entryLimited = await execute(lister, {
    path: ".",
    max_depth: 2,
    max_entries: 2,
  });
  assert.equal(entryLimited.isError, false);
  assert.equal(entryLimited.metadata?.truncated, true);
  assert.match(entryLimited.content, /listing truncated after 2 entries/);
});

test("ListFilesTool rejects invalid bounds and regular-file roots", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  await writeFile(path.join(root, "file.txt"), "content");
  const lister = new ListFilesTool(workspace);

  for (const argumentsValue of [{ max_depth: 6 }, { max_entries: 501 }]) {
    const result = await execute(lister, argumentsValue);
    assert.equal(result.isError, true);
    assert.equal(kindOf(result), "invalid_arguments");
  }

  const regularFile = await execute(lister, { path: "file.txt" });
  assert.equal(regularFile.isError, true);
  assert.equal(kindOf(regularFile), "invalid_file_type");
});

test("tool inputs reject unknown fields before file-system work", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const result = await execute(new ReadFileTool(workspace), {
    path: "missing.txt",
    unexpected: true,
  });

  assert.equal(result.isError, true);
  assert.equal(kindOf(result), "invalid_arguments");
});

test("WriteFileTool gates overwrite and preserves the old file on failure", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const target = path.join(root, "existing.txt");
  await writeFile(target, "original", { mode: 0o600 });
  const writer = new WriteFileTool(workspace);

  const refused = await execute(writer, {
    path: "existing.txt",
    content: "replacement",
  });
  assert.equal(refused.isError, true);
  assert.equal(kindOf(refused), "already_exists");
  assert.equal(await readFile(target, "utf8"), "original");

  const oversized = await execute(writer, {
    path: "existing.txt",
    content: "x".repeat(MAX_FILE_WRITE_BYTES + 1),
    overwrite: true,
  });
  assert.equal(oversized.isError, true);
  assert.equal(kindOf(oversized), "limit_exceeded");
  assert.equal(await readFile(target, "utf8"), "original");

  await chmod(target, 0o600);
  const replaced = await execute(writer, {
    path: "existing.txt",
    content: "replacement",
    overwrite: true,
  });
  assert.equal(replaced.isError, false);
  assert.equal(await readFile(target, "utf8"), "replacement");
  assert.equal((await stat(target)).mode & 0o777, 0o600);

  const nested = await execute(writer, {
    path: "new/nested.txt",
    content: "new",
  });
  assert.equal(nested.isError, false);
  assert.equal(await readFile(path.join(root, "new", "nested.txt"), "utf8"), "new");
});

test("WriteFileTool create-only writes are atomic under concurrency", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const writer = new WriteFileTool(workspace);

  const [alpha, beta] = await Promise.all([
    execute(writer, { path: "race.txt", content: "alpha" }),
    execute(writer, { path: "race.txt", content: "beta" }),
  ]);

  const results = [alpha, beta];
  assert.equal(results.filter((result) => !result.isError).length, 1);
  const loser = results.find((result) => result.isError);
  assert.ok(loser !== undefined);
  assert.equal(kindOf(loser), "already_exists");
  const finalContent = await readFile(path.join(root, "race.txt"), "utf8");
  assert.ok(finalContent === "alpha" || finalContent === "beta");
  assert.equal(
    finalContent,
    alpha.isError ? "beta" : "alpha",
    "the successful create must be the content retained on disk",
  );
});

test("EditFileTool requires one exact fresh match", async (t) => {
  const cases = [
    {
      name: "success",
      initial: "alpha beta gamma",
      oldText: "beta",
      newText: "BETA",
      expected: "alpha BETA gamma",
      expectedKind: undefined,
    },
    {
      name: "missing stale context",
      initial: "alpha beta gamma",
      oldText: "delta",
      newText: "DELTA",
      expected: "alpha beta gamma",
      expectedKind: "stale_edit",
    },
    {
      name: "ambiguous context",
      initial: "same and same",
      oldText: "same",
      newText: "changed",
      expected: "same and same",
      expectedKind: "ambiguous_edit",
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const { root, workspace } = await temporaryWorkspace(t);
      const target = path.join(root, "edit.txt");
      await writeFile(target, entry.initial);

      const result = await execute(new EditFileTool(workspace), {
        path: "edit.txt",
        old_text: entry.oldText,
        new_text: entry.newText,
      });

      assert.equal(result.isError, entry.expectedKind !== undefined);
      if (entry.expectedKind !== undefined) {
        assert.equal(kindOf(result), entry.expectedKind);
      }
      assert.equal(await readFile(target, "utf8"), entry.expected);
    });
  }
});

test("EditFileTool rejects oversized output without changing the file", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const initial = `${"a".repeat(MAX_FILE_WRITE_BYTES - 1)}Z`;
  const target = path.join(root, "near-limit.txt");
  await writeFile(target, initial);

  const result = await execute(new EditFileTool(workspace), {
    path: "near-limit.txt",
    old_text: "Z",
    new_text: "ZZ",
  });

  assert.equal(result.isError, true);
  assert.equal(kindOf(result), "limit_exceeded");
  assert.equal(await readFile(target, "utf8"), initial);
});

test("EditFileTool rejects invalid UTF-8 without changing bytes", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const initial = Buffer.from([0xff, 0xfe, 0x61, 0x0a]);
  const target = path.join(root, "invalid.txt");
  await writeFile(target, initial);

  const result = await execute(new EditFileTool(workspace), {
    path: "invalid.txt",
    old_text: "a",
    new_text: "b",
  });

  assert.equal(result.isError, true);
  assert.equal(kindOf(result), "invalid_encoding");
  assert.deepEqual(await readFile(target), initial);
});
