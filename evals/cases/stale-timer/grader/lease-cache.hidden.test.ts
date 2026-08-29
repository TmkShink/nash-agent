import assert from "node:assert/strict";
import test from "node:test";

import { LeaseCache, type Scheduler } from "../src/lease-cache.js";

interface ScheduledCallback {
  readonly handle: number;
  readonly dueAt: number;
  readonly order: number;
  readonly callback: () => void;
}

class RecyclingScheduler implements Scheduler {
  #currentTime = 0;
  #nextHandle = 1;
  #nextOrder = 1;
  #queued = new Map<number, ScheduledCallback>();
  #ready: ScheduledCallback[] = [];
  #recycledHandles: number[] = [];
  public lastDequeuedHandle: number | undefined;
  public lastScheduledHandle: number | undefined;

  public now(): number {
    return this.#currentTime;
  }

  public schedule(callback: () => void, delayMs: number): unknown {
    const handle = this.#recycledHandles.shift() ?? this.#nextHandle++;
    if (this.#queued.has(handle)) {
      throw new Error(`handle ${handle} is still queued`);
    }
    const scheduled = {
      handle,
      dueAt: this.#currentTime + delayMs,
      order: this.#nextOrder++,
      callback,
    };
    this.#queued.set(handle, scheduled);
    this.lastScheduledHandle = handle;
    return handle;
  }

  public cancel(handle: unknown): void {
    if (typeof handle !== "number" || !this.#queued.delete(handle)) {
      return;
    }
    this.#recycle(handle);
  }

  public advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError("milliseconds must be a non-negative integer");
    }
    this.#currentTime += milliseconds;
    const due = [...this.#queued.values()]
      .filter((scheduled) => scheduled.dueAt <= this.#currentTime)
      .sort(
        (left, right) =>
          left.dueAt - right.dueAt || left.order - right.order,
      );
    for (const scheduled of due) {
      this.#queued.delete(scheduled.handle);
      this.#recycle(scheduled.handle);
      this.#ready.push(scheduled);
      this.lastDequeuedHandle = scheduled.handle;
    }
  }

  public runReady(): void {
    while (this.#ready.length > 0) {
      const scheduled = this.#ready.shift();
      if (scheduled === undefined) {
        throw new Error("ready queue changed unexpectedly");
      }
      scheduled.callback();
    }
  }

  #recycle(handle: number): void {
    if (!this.#recycledHandles.includes(handle)) {
      this.#recycledHandles.push(handle);
      this.#recycledHandles.sort((left, right) => left - right);
    }
  }
}

test("RecyclingScheduler still lets LeaseCache cancel a queued lease", () => {
  const scheduler = new RecyclingScheduler();
  const cache = new LeaseCache<string, string>(scheduler);
  cache.set("key", "old", 5);

  scheduler.advanceBy(2);
  cache.set("key", "replacement", 10);
  scheduler.advanceBy(3);
  scheduler.runReady();
  assert.equal(cache.get("key"), "replacement");

  scheduler.advanceBy(7);
  scheduler.runReady();
  assert.equal(cache.get("key"), undefined);
});

test("a recycled timer handle cannot make an old callback own a replacement", () => {
  const scheduler = new RecyclingScheduler();
  const cache = new LeaseCache<string, string>(scheduler);
  cache.set("key", "old", 5);

  scheduler.advanceBy(5);
  const oldHandle = scheduler.lastDequeuedHandle;
  assert.notEqual(oldHandle, undefined);

  cache.set("key", "replacement", 100);
  assert.equal(
    scheduler.lastScheduledHandle,
    oldHandle,
    "the replacement must receive the dequeued callback's recycled handle",
  );
  assert.equal(cache.get("key"), "replacement");

  scheduler.runReady();
  assert.equal(cache.get("key"), "replacement");
  assert.equal(cache.size, 1);
});
