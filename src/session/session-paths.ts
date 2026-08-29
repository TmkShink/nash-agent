import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isSessionId } from "../trace/events.js";
import type { Workspace } from "../workspace/workspace.js";

const STATE_DIRECTORY_PARTS = [".nash", "sessions"] as const;

export async function prepareSessionDirectory(workspace: Workspace): Promise<string> {
  await assertStatePathHasNoSymlinks(workspace.root);
  const directory = path.join(workspace.root, ...STATE_DIRECTORY_PARTS);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(path.join(workspace.root, STATE_DIRECTORY_PARTS[0]), 0o700);
  await chmod(directory, 0o700);
  await assertStatePathHasNoSymlinks(workspace.root);
  return directory;
}

export async function resolveTraceReference(
  workspace: Workspace,
  reference: string,
): Promise<string> {
  if (reference.trim() === "") {
    throw new Error("session reference is empty");
  }
  let candidate: string;
  const looksLikeTracePath =
    path.extname(reference).toLowerCase() === ".jsonl" || /[\\/]/.test(reference);
  if (!looksLikeTracePath && isSessionId(reference)) {
    candidate = path.join(
      workspace.root,
      ...STATE_DIRECTORY_PARTS,
      `${reference}.jsonl`,
    );
  } else {
    if (path.isAbsolute(reference) || path.win32.isAbsolute(reference)) {
      throw new Error("trace path must be relative to the workspace");
    }
    if (path.extname(reference).toLowerCase() !== ".jsonl") {
      throw new Error("trace path must end in .jsonl");
    }
    candidate = path.resolve(workspace.root, reference);
    assertInside(workspace.root, candidate);
  }

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    throw new Error(`cannot resolve trace: ${messageOf(error)}`);
  }
  assertInside(workspace.root, canonical);
  if (!(await stat(canonical)).isFile()) {
    throw new Error("trace reference is not a regular file");
  }
  return canonical;
}

async function assertStatePathHasNoSymlinks(root: string): Promise<void> {
  let current = root;
  for (const part of STATE_DIRECTORY_PARTS) {
    current = path.join(current, part);
    try {
      const information = await lstat(current);
      if (information.isSymbolicLink()) {
        throw new Error(`state path ${JSON.stringify(part)} must not be a symlink`);
      }
      if (!information.isDirectory()) {
        throw new Error(`state path ${JSON.stringify(part)} is not a directory`);
      }
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
  }
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, path.normalize(candidate));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("trace path escapes the workspace");
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
