import type { EventSink, TraceEvent } from "../trace/events.js";

const MAX_REPLAY_GAP_MS = 2_000;

export async function replayTrace(
  events: readonly TraceEvent[],
  speed: number,
  sink: EventSink,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isFinite(speed) || speed < 0 || speed > 100) {
    throw new RangeError("replay speed must be from 0 to 100");
  }
  let previousTime: number | undefined;
  try {
    for (const event of events) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("replay was cancelled");
      }
      const currentTime = Date.parse(event.time);
      if (speed > 0 && previousTime !== undefined) {
        const delay = Math.min(
          MAX_REPLAY_GAP_MS,
          Math.max(0, (currentTime - previousTime) / speed),
        );
        await sleep(delay, signal);
      }
      await sink.write(event);
      previousTime = currentTime;
    }
  } finally {
    await sink.close();
  }
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("replay was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
