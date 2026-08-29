import { randomBytes } from "node:crypto";

export const TRACE_SCHEMA_VERSION = 1;
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface TraceEvent {
  readonly version: number;
  readonly sessionId: string;
  readonly sequence: number;
  readonly time: string;
  readonly type: string;
  readonly data: unknown;
}

export interface EventSink {
  write(event: TraceEvent): Promise<void>;
  close(): Promise<void>;
}

export interface EventEmitter {
  emit(type: string, data: unknown): Promise<void>;
}

export class EventBus implements EventEmitter {
  readonly #sessionId: string;
  readonly #sinks: readonly EventSink[];
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();
  #failure: Error | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  public constructor(sessionId: string, sinks: readonly EventSink[]) {
    if (sessionId.trim() === "") {
      throw new Error("session ID is empty");
    }
    if (sinks.some((sink) => sink === undefined || sink === null)) {
      throw new Error("event sink is missing");
    }
    this.#sessionId = sessionId;
    this.#sinks = [...sinks];
  }

  public emit(type: string, data: unknown): Promise<void> {
    if (this.#closing) {
      return Promise.reject(new Error("event bus is closed"));
    }
    if (type.trim() === "") {
      return Promise.reject(new Error("event type is empty"));
    }

    let snapshot: unknown;
    try {
      snapshot = cloneJson(data);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    const operation = this.#tail.then(async () => {
      if (this.#failure !== undefined) {
        throw this.#failure;
      }
      const event: TraceEvent = {
        version: TRACE_SCHEMA_VERSION,
        sessionId: this.#sessionId,
        sequence: ++this.#sequence,
        time: new Date().toISOString(),
        type,
        data: snapshot,
      };
      for (const sink of this.#sinks) {
        await sink.write(event);
      }
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
    this.#closing = true;
    this.#closePromise = this.#closeSinks();
    return await this.#closePromise;
  }

  async #closeSinks(): Promise<void> {
    await this.#tail;

    const errors: Error[] = this.#failure === undefined ? [] : [this.#failure];
    for (const sink of this.#sinks) {
      try {
        await sink.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "failed to close event bus cleanly");
    }
  }
}

export function newSessionId(now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

function cloneJson(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch (error) {
    throw new Error(
      `event data is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (serialized === undefined) {
    return null;
  }
  return JSON.parse(serialized) as unknown;
}
