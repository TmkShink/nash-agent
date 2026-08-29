import { once } from "node:events";
import type { Writable } from "node:stream";

import type { EventSink, TraceEvent } from "../trace/events.js";
import { formatTraceEvent } from "../trace/format-event.js";

export class ConsoleEventSink implements EventSink {
  readonly #output: Writable;

  public constructor(output: Writable) {
    this.#output = output;
  }

  public async write(event: TraceEvent): Promise<void> {
    const writable = this.#output.write(`${formatTraceEvent(event)}\n`);
    if (!writable) {
      await once(this.#output, "drain");
    }
  }

  public async close(): Promise<void> {}
}
