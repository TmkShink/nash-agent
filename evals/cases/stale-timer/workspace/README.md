# LeaseCache exercise

`LeaseCache` stores values until their lease expires. Its public behavior is:

- `set(key, value, ttlMs)` creates or replaces a lease. `ttlMs` must be a positive integer.
- Replacing a key starts a new lease. A callback from the old lease must never remove the replacement.
- `get(key)` returns the current value, or `undefined` after its deadline.
- `size` excludes expired entries even when their scheduled callbacks have not run yet.
- `delete(key)` removes the current lease and returns whether one existed.

The injected `Scheduler` makes time deterministic in tests. `cancel(handle)` is best effort: once a callback has been dequeued, cancellation cannot prevent that callback from running. A scheduler may recycle that callback's handle after dequeue because the handle no longer refers to cancellable work. Keep the exported API unchanged.
