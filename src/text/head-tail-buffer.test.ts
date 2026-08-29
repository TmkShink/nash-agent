import assert from "node:assert/strict";
import test from "node:test";

import { HeadTailBuffer } from "./head-tail-buffer.js";

test("HeadTailBuffer retains complete short input", () => {
  const buffer = new HeadTailBuffer(5, 4);

  buffer.write("abc");

  assert.equal(buffer.toString(), "abc");
  assert.equal(buffer.totalBytes, 3);
  assert.equal(buffer.truncated, false);
});

test("HeadTailBuffer retains the head and tail of long input", () => {
  const buffer = new HeadTailBuffer(5, 4);

  buffer.write("abcdefghijk");

  assert.equal(
    buffer.toString(),
    "abcde\n... [2 bytes omitted] ...\nhijk",
  );
  assert.equal(buffer.totalBytes, 11);
  assert.equal(buffer.truncated, true);
});

test("HeadTailBuffer computes retention across segmented writes", () => {
  const buffer = new HeadTailBuffer(3, 3);

  buffer.write("ab");
  buffer.write(Buffer.from("cdef"));
  buffer.write("gh");

  assert.equal(buffer.toString(), "abc\n... [2 bytes omitted] ...\nfgh");
  assert.equal(buffer.totalBytes, 8);
  assert.equal(buffer.truncated, true);
});

test("HeadTailBuffer validates its limits", () => {
  for (const [head, tail] of [
    [-1, 1],
    [1, -1],
    [1.5, 1],
  ] as const) {
    assert.throws(() => new HeadTailBuffer(head, tail), RangeError);
  }
});
