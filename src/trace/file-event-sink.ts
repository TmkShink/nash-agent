import { type FileHandle, chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";

import type { EventSink, TraceEvent } from "./events.js";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class FileEventSink implements EventSink {
  readonly #path: string;
  readonly #handle: FileHandle;
  #tail: Promise<void> = Promise.resolve();
  #failure: Error | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(filePath: string, handle: FileHandle) {
    this.#path = filePath;
    this.#handle = handle;
  }

  public static async open(directory: string, sessionId: string): Promise<FileEventSink> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`invalid session ID ${JSON.stringify(sessionId)}`);
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const filePath = path.join(directory, `${sessionId}.jsonl`);
    const handle = await open(filePath, "wx", 0o600);
    return new FileEventSink(filePath, handle);
  }

  public get path(): string {
    return this.#path;
  }

  public write(event: TraceEvent): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("trace file is closed"));
    }
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const line = `${JSON.stringify(event)}\n`;
    const operation = this.#tail.then(async () => {
      await this.#handle.writeFile(line, { encoding: "utf8" });
      await this.#handle.sync();
    });
    this.#tail = operation.catch((error: unknown) => {
      this.#failure = error instanceof Error ? error : new Error(String(error));
    });
    return operation;
  }

  public async close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return await this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = this.#finishClose();
    return await this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    await this.#tail;
    await this.#handle.close();
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }
}
