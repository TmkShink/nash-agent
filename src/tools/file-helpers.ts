import { randomUUID } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_WRITE_BYTES = 1024 * 1024;
export const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;

export async function writeFileAtomic(
  target: string,
  content: string,
  mode: number,
  replace: boolean,
): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.nash-write-${process.pid}-${randomUUID()}`,
  );
  const handle = await open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (replace) {
      await rename(temporary, target);
    } else {
      // Hard-linking a complete temporary file makes create-only writes
      // atomic and prevents a concurrent creator from being overwritten.
      await link(temporary, target);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export function decodeUtf8(content: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new InvalidEncodingError();
  }
}

export class InvalidEncodingError extends Error {
  public constructor() {
    super("file is not valid UTF-8");
    this.name = "InvalidEncodingError";
  }
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return (error as NodeJS.ErrnoException).code;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
