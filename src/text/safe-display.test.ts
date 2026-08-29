import assert from "node:assert/strict";
import test from "node:test";

import { safeDisplay } from "./safe-display.js";

test("safeDisplay escapes ANSI and whitespace control characters", () => {
  const displayed = safeDisplay("\u001b[31mred\u001b[0m\nnext\tcell\rreturn");

  assert.equal(
    displayed,
    "\\x1b[31mred\\x1b[0m\\nnext\\tcell\\rreturn",
  );
  assert.doesNotMatch(displayed, /[\u0000-\u001f\u007f-\u009f]/u);
});

test("safeDisplay truncates the escaped preview to a visible bound", () => {
  assert.equal(safeDisplay("abcdefgh", 5), "abcde...");
  assert.equal(safeDisplay("\u001babcdef", 5), "\\x1ba...");
});

test("safeDisplay validates its display bound", () => {
  for (const maximum of [0, -1, 1.5]) {
    assert.throws(() => safeDisplay("value", maximum), RangeError);
  }
});
