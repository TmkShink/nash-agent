import assert from "node:assert/strict";
import test from "node:test";

import { LeaseCache, type Scheduler } from "../src/lease-cache.js";

interface ScheduledCallback {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

class ManualScheduler implements Scheduler {
  #currentTime = 0;
  #nextId = 1;
  #scheduled: ScheduledCallback[] = [];
  #ready: ScheduledCallback[] = [];

  public now(): number {
    return this.#currentTime;
  }

  public schedule(callback: () => void, delayMs: number): unknown {
    const scheduled = {
      id: this.#nextId++,
      dueAt: this.#currentTime + delayMs,
      callback,
    };
    this.#scheduled.push(scheduled);
    return scheduled;
  }

  public cancel(handle: unknown): void {
    const index = this.#scheduled.findIndex((scheduled) => scheduled === handle);
    if (index !== -1) {
      this.#scheduled.splice(index, 1);
    }
    // A ready callback has already been dequeued. Cancellation is best effort
    // and deliberately cannot remove it from #ready.
  }

  public advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError("milliseconds must be a non-negative integer");
    }
    this.#currentTime += milliseconds;
    const due = this.#scheduled
      .filter((scheduled) => scheduled.dueAt <= this.#currentTime)
      .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
    const dueIds = new Set(due.map((scheduled) => scheduled.id));
    this.#scheduled = this.#scheduled.filter(
      (scheduled) => !dueIds.has(scheduled.id),
    );
    this.#ready.push(...due);
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

  public get readyCount(): number {
    return this.#ready.length;
  }
}

test("LeaseCache returns a value until its lease callback expires it", () => {
  const scheduler = new ManualScheduler();
  const cache = new LeaseCache<string, string>(scheduler);
  cache.set("key", "value", 10);

  assert.equal(cache.get("key"), "value");
  scheduler.advanceBy(9);
  scheduler.runReady();
  assert.equal(cache.get("key"), "value");

  scheduler.advanceBy(1);
  assert.equal(scheduler.readyCount, 1);
  scheduler.runReady();
  assert.equal(cache.get("key"), undefined);
  assert.equal(cache.size, 0);
});

test("LeaseCache requires a positive safe-integer ttl", () => {
  const scheduler = new ManualScheduler();
  const cache = new LeaseCache<string, string>(scheduler);

  for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    assert.throws(() => cache.set("key", "value", ttl), RangeError);
  }
  assert.doesNotThrow(() => cache.set("key", "value", 1));
});

test("LeaseCache delete removes only an existing current lease", () => {
  const scheduler = new ManualScheduler();
  const cache = new LeaseCache<string, string>(scheduler);

  assert.equal(cache.delete("key"), false);
  cache.set("key", "value", 5);
  assert.equal(cache.delete("key"), true);
  assert.equal(cache.delete("key"), false);
  scheduler.advanceBy(5);
  scheduler.runReady();
  assert.equal(cache.get("key"), undefined);
  assert.equal(cache.size, 0);
});

test("LeaseCache size lazily excludes expired entries whose callbacks are delayed", () => {
  const scheduler = new ManualScheduler();
  const cache = new LeaseCache<string, string>(scheduler);
  cache.set("expired", "old", 5);
  cache.set("live", "new", 20);

  scheduler.advanceBy(5);
  assert.equal(scheduler.readyCount, 1);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("expired"), undefined);
  assert.equal(cache.get("live"), "new");

  scheduler.runReady();
  assert.equal(cache.get("live"), "new");
  assert.equal(cache.size, 1);
});

test("a dequeued callback from an old lease cannot delete its replacement", () => {
  const scheduler = new ManualScheduler();
  const cache = new LeaseCache<string, string>(scheduler);
  cache.set("key", "old", 5);

  scheduler.advanceBy(5);
  assert.equal(scheduler.readyCount, 1);
  cache.set("key", "replacement", 100);
  assert.equal(cache.get("key"), "replacement");

  scheduler.runReady();
  assert.equal(cache.get("key"), "replacement");
  assert.equal(cache.size, 1);
});
