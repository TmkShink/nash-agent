import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class WorkspacePathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class Workspace {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  public static async open(root: string): Promise<Workspace> {
    if (root.trim() === "") {
      throw new WorkspacePathError("workspace root is empty");
    }
    let canonical: string;
    try {
      canonical = await realpath(path.resolve(root));
    } catch (error) {
      throw new WorkspacePathError(`cannot resolve workspace root: ${messageOf(error)}`);
    }
    const information = await stat(canonical);
    if (!information.isDirectory()) {
      throw new WorkspacePathError("workspace root is not a directory");
    }
    return new Workspace(path.normalize(canonical));
  }

  public get root(): string {
    return this.#root;
  }

  public async resolveExisting(input: string): Promise<string> {
    const candidate = this.#lexicalCandidate(input);
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      throw new WorkspacePathError(`cannot resolve path: ${messageOf(error)}`);
    }
    this.#assertInside(canonical);
    return path.normalize(canonical);
  }

  public async resolveForWrite(input: string): Promise<string> {
    const candidate = this.#lexicalCandidate(input);
    if (candidate === this.#root) {
      throw new WorkspacePathError("workspace root cannot be used as a file");
    }

    try {
      await lstat(candidate);
      return await this.resolveExisting(input);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        if (error instanceof WorkspacePathError) {
          throw error;
        }
        throw new WorkspacePathError(`cannot inspect path: ${messageOf(error)}`);
      }
    }

    let ancestor = path.dirname(candidate);
    while (true) {
      try {
        await lstat(ancestor);
        break;
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) {
          throw new WorkspacePathError(`cannot inspect parent path: ${messageOf(error)}`);
        }
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw new WorkspacePathError("path escapes the workspace root");
      }
      ancestor = parent;
    }

    let canonicalAncestor: string;
    try {
      canonicalAncestor = await realpath(ancestor);
    } catch (error) {
      throw new WorkspacePathError(`cannot resolve parent path: ${messageOf(error)}`);
    }
    this.#assertInside(canonicalAncestor);
    const remainder = path.relative(ancestor, candidate);
    const resolved = path.join(canonicalAncestor, remainder);
    this.#assertInside(resolved);
    return path.normalize(resolved);
  }

  public relative(absolutePath: string): string {
    return path.relative(this.#root, absolutePath).split(path.sep).join("/") || ".";
  }

  #lexicalCandidate(input: string): string {
    if (input.trim() === "") {
      throw new WorkspacePathError("path is empty");
    }
    if (input.includes("\0")) {
      throw new WorkspacePathError("path contains a NUL byte");
    }
    if (path.isAbsolute(input) || path.win32.isAbsolute(input)) {
      throw new WorkspacePathError("absolute paths are outside the workspace");
    }
    const candidate = path.resolve(this.#root, input);
    this.#assertInside(candidate);
    return candidate;
  }

  #assertInside(candidate: string): void {
    const relative = path.relative(this.#root, path.normalize(candidate));
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new WorkspacePathError("path escapes the workspace root");
    }
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
