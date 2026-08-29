export interface Scheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

interface Entry<Value> {
  readonly value: Value;
  readonly expiresAt: number;
  readonly timer: unknown;
}

const systemScheduler: Scheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class LeaseCache<Key, Value> {
  readonly #entries = new Map<Key, Entry<Value>>();
  readonly #scheduler: Scheduler;

  public constructor(scheduler: Scheduler = systemScheduler) {
    this.#scheduler = scheduler;
  }

  public set(key: Key, value: Value, ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new RangeError("ttlMs must be a positive integer");
    }
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#scheduler.cancel(previous.timer);
    }
    const expiresAt = this.#scheduler.now() + ttlMs;
    const timer = this.#scheduler.schedule(() => {
      this.#entries.delete(key);
    }, ttlMs);
    this.#entries.set(key, { value, expiresAt, timer });
  }

  public get(key: Key): Value | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= this.#scheduler.now()) {
      this.delete(key);
      return undefined;
    }
    return entry.value;
  }

  public delete(key: Key): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.#scheduler.cancel(entry.timer);
    return this.#entries.delete(key);
  }

  public get size(): number {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= this.#scheduler.now()) {
        this.delete(key);
      }
    }
    return this.#entries.size;
  }
}
