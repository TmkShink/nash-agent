import assert from "node:assert/strict";
import test from "node:test";

import type { EventSink, TraceEvent } from "../trace/events.js";
import { replayTrace } from "./replay-trace.js";

function event(sequence: number, seconds: number): TraceEvent {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    time: new Date(Date.UTC(2026, 7, 30, 0, 0, seconds)).toISOString(),
    type: sequence === 1 ? "session_started" : "probe",
    data: { sequence },
  };
}

class RecordingSink implements EventSink {
  public readonly events: TraceEvent[] = [];
  public closeCalls = 0;

  public constructor(
    private readonly onWrite: (
      event: TraceEvent,
      index: number,
    ) => void | Promise<void> = () => undefined,
  ) {}

  public async write(value: TraceEvent): Promise<void> {
    const index = this.events.length;
    this.events.push(value);
    await this.onWrite(value, index);
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

test("replayTrace speed zero preserves order without timestamp delays", async () => {
  const events = [event(1, 0), event(2, 30), event(3, 59)];
  const sink = new RecordingSink();

  await replayTrace(events, 0, sink, new AbortController().signal);

  assert.deepEqual(sink.events.map((value) => value.sequence), [1, 2, 3]);
  assert.equal(sink.closeCalls, 1);
});

test("replayTrace closes its sink when writing fails", async () => {
  const failure = new Error("display failed");
  const sink = new RecordingSink((_event, index) => {
    if (index === 1) {
      throw failure;
    }
  });

  await assert.rejects(
    replayTrace(
      [event(1, 0), event(2, 1), event(3, 2)],
      0,
      sink,
      new AbortController().signal,
    ),
    failure,
  );
  assert.deepEqual(sink.events.map((value) => value.sequence), [1, 2]);
  assert.equal(sink.closeCalls, 1);
});

test("replayTrace closes its sink and stops promptly on cancellation", async (t) => {
  await t.test("already cancelled", async () => {
    const reason = new Error("cancelled before replay");
    const controller = new AbortController();
    controller.abort(reason);
    const sink = new RecordingSink();

    await assert.rejects(replayTrace([event(1, 0)], 0, sink, controller.signal), reason);
    assert.equal(sink.events.length, 0);
    assert.equal(sink.closeCalls, 1);
  });

  await t.test("cancelled between events", async () => {
    const reason = new Error("cancelled during replay");
    const controller = new AbortController();
    const sink = new RecordingSink((_event, index) => {
      if (index === 0) {
        controller.abort(reason);
      }
    });

    await assert.rejects(
      replayTrace(
        [event(1, 0), event(2, 30)],
        1,
        sink,
        controller.signal,
      ),
      reason,
    );
    assert.deepEqual(sink.events.map((value) => value.sequence), [1]);
    assert.equal(sink.closeCalls, 1);
  });
});
