import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SIZE,
  addRandomTile,
  createGame,
  hasAvailableMoves,
  move,
  moveBoard,
  slideAndMerge,
} from "../src/game.js";

const freezeBoard = (board) => {
  for (const row of board) {
    Object.freeze(row);
  }
  return Object.freeze(board);
};

const sequenceRandom = (values) => {
  let index = 0;
  return {
    random() {
      assert.ok(index < values.length, "random was called more often than expected");
      return values[index++];
    },
    calls() {
      return index;
    },
  };
};

const lockedBoard = () => [
  [2, 4, 8, 16],
  [4, 8, 16, 32],
  [8, 16, 32, 64],
  [16, 32, 64, 128],
];

test("slideAndMerge compresses gaps and lets each source tile merge once", () => {
  const cases = [
    {
      input: [2, 2, 2, 2],
      expected: { line: [4, 4, 0, 0], scoreGained: 8 },
    },
    {
      input: [2, 2, 4, 4],
      expected: { line: [4, 8, 0, 0], scoreGained: 12 },
    },
    {
      input: [2, 2, 4, 0],
      expected: { line: [4, 4, 0, 0], scoreGained: 4 },
    },
    {
      input: [0, 2, 0, 2],
      expected: { line: [4, 0, 0, 0], scoreGained: 4 },
    },
  ];

  for (const { input, expected } of cases) {
    const snapshot = [...input];
    Object.freeze(input);
    assert.deepEqual(slideAndMerge(input), expected);
    assert.deepEqual(input, snapshot);
  }
});

test("moveBoard maps left, right, up, and down without mutating the board", () => {
  const horizontal = freezeBoard([
    [2, 0, 2, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const vertical = freezeBoard([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [2, 0, 0, 0],
    [4, 0, 0, 0],
  ]);

  assert.deepEqual(moveBoard(horizontal, "left"), {
    board: [
      [4, 4, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    scoreGained: 4,
    moved: true,
  });
  assert.deepEqual(moveBoard(horizontal, "right"), {
    board: [
      [0, 0, 4, 4],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    scoreGained: 4,
    moved: true,
  });
  assert.deepEqual(moveBoard(vertical, "up"), {
    board: [
      [4, 0, 0, 0],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    scoreGained: 4,
    moved: true,
  });
  assert.deepEqual(moveBoard(vertical, "down"), {
    board: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [4, 0, 0, 0],
      [4, 0, 0, 0],
    ],
    scoreGained: 4,
    moved: true,
  });
});

test("moveBoard reports an unchanged board with no score", () => {
  const board = freezeBoard([
    [2, 4, 8, 16],
    [32, 64, 128, 256],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  assert.deepEqual(moveBoard(board, "left"), {
    board,
    scoreGained: 0,
    moved: false,
  });
});

test("addRandomTile uses row-major empties and the exact value threshold", () => {
  const board = freezeBoard([
    [2, 0, 4, 8],
    [0, 16, 32, 64],
    [128, 256, 512, 1024],
    [2, 4, 8, 0],
  ]);
  const source = sequenceRandom([0.5, 0.1]);

  const result = addRandomTile(board, source.random);

  assert.deepEqual(result, [
    [2, 0, 4, 8],
    [2, 16, 32, 64],
    [128, 256, 512, 1024],
    [2, 4, 8, 0],
  ]);
  assert.equal(source.calls(), 2);

  const oneEmpty = freezeBoard([
    [0, 4, 8, 16],
    [4, 8, 16, 32],
    [8, 16, 32, 64],
    [16, 32, 64, 128],
  ]);
  const belowThreshold = sequenceRandom([0.75, 0.899999]);
  const atThreshold = sequenceRandom([0.25, 0.9]);

  assert.equal(addRandomTile(oneEmpty, belowThreshold.random)[0][0], 2);
  assert.equal(addRandomTile(oneEmpty, atThreshold.random)[0][0], 4);
  assert.equal(belowThreshold.calls(), 2);
  assert.equal(atThreshold.calls(), 2);
});

test("addRandomTile returns a new board and consumes no randomness when full", () => {
  const board = freezeBoard(lockedBoard());
  let calls = 0;

  const result = addRandomTile(board, () => {
    calls += 1;
    return 0;
  });

  assert.deepEqual(result, board);
  assert.notStrictEqual(result, board);
  assert.equal(calls, 0);
});

test("hasAvailableMoves detects spaces and horizontal or vertical merges", () => {
  const withSpace = lockedBoard();
  withSpace[3][3] = 0;

  const horizontalPair = lockedBoard();
  horizontalPair[0][1] = 2;

  const verticalPair = lockedBoard();
  verticalPair[1][0] = 2;

  assert.equal(hasAvailableMoves(freezeBoard(withSpace)), true);
  assert.equal(hasAvailableMoves(freezeBoard(horizontalPair)), true);
  assert.equal(hasAvailableMoves(freezeBoard(verticalPair)), true);
  assert.equal(hasAvailableMoves(freezeBoard(lockedBoard())), false);
});

test("createGame calls the random source twice per spawned tile", () => {
  assert.equal(SIZE, 4);
  const source = sequenceRandom([0, 0, 0.999999, 0.95]);

  const state = createGame(source.random);

  assert.deepEqual(state, {
    board: [
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 4],
    ],
    score: 0,
    status: "playing",
  });
  assert.equal(source.calls(), 4);
});

test("move spawns exactly one tile and accumulates the merge score", () => {
  const state = Object.freeze({
    board: freezeBoard([
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]),
    score: 10,
    status: "playing",
  });
  const source = sequenceRandom([0, 0]);

  const result = move(state, "left", source.random);

  assert.deepEqual(result, {
    board: [
      [4, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    score: 14,
    status: "playing",
    moved: true,
  });
  assert.equal(source.calls(), 2);
});

test("move does not spawn a tile after an unchanged move", () => {
  const state = Object.freeze({
    board: freezeBoard([
      [2, 4, 0, 0],
      [8, 16, 0, 0],
      [32, 64, 0, 0],
      [128, 256, 0, 0],
    ]),
    score: 19,
    status: "playing",
  });
  let calls = 0;

  const result = move(state, "left", () => {
    calls += 1;
    return 0;
  });

  assert.deepEqual(result, {
    board: state.board,
    score: 19,
    status: "playing",
    moved: false,
  });
  assert.equal(calls, 0);
});

test("move marks a game won after creating a 2048 tile", () => {
  const state = Object.freeze({
    board: freezeBoard([
      [1024, 1024, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]),
    score: 0,
    status: "playing",
  });
  const source = sequenceRandom([0, 0]);

  const result = move(state, "left", source.random);

  assert.equal(result.moved, true);
  assert.equal(result.score, 2048);
  assert.equal(result.status, "won");
  assert.equal(result.board[0][0], 2048);
  assert.equal(source.calls(), 2);
});

test("move marks a game lost when its spawned tile locks the board", () => {
  const state = Object.freeze({
    board: freezeBoard([
      [2, 0, 4, 8],
      [4, 8, 2, 4],
      [8, 2, 4, 8],
      [2, 4, 8, 2],
    ]),
    score: 5,
    status: "playing",
  });
  const source = sequenceRandom([0, 0]);

  const result = move(state, "left", source.random);

  assert.deepEqual(result, {
    board: [
      [2, 4, 8, 2],
      [4, 8, 2, 4],
      [8, 2, 4, 8],
      [2, 4, 8, 2],
    ],
    score: 5,
    status: "lost",
    moved: true,
  });
  assert.equal(source.calls(), 2);
});

const hasHook = (html, names) => {
  const values = [
    ...html.matchAll(
      /(?:id|class|data-testid|data-role|data-hook)\s*=\s*["']([^"']+)["']/gi,
    ),
  ].map((match) => match[1].toLowerCase());

  return names.some((name) =>
    values.some(
      (value) =>
        value === name ||
        value.split(/\s+/).includes(name) ||
        value.split(/[\s_-]+/).includes(name),
    ),
  );
};

test("the page exposes the game UI through a native module entry point", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];

  assert.ok(
    scriptTags.some(
      (tag) =>
        /\btype\s*=\s*["']module["']/i.test(tag) &&
        /\bsrc\s*=\s*["'](?:\.\/|\/)?src\/app\.js["']/i.test(tag),
    ),
    "index.html must load src/app.js as a module",
  );
  assert.equal(hasHook(html, ["board", "game-board"]), true, "missing board hook");
  assert.equal(hasHook(html, ["score", "current-score"]), true, "missing score hook");
  assert.equal(hasHook(html, ["best", "best-score"]), true, "missing best-score hook");
  assert.equal(hasHook(html, ["restart", "new-game"]), true, "missing New Game hook");
  assert.equal(hasHook(html, ["status", "game-status"]), true, "missing status hook");
});

test("the browser controller wires keyboard, swipe, storage, and scroll handling", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(app, /["']\.\/game\.js["']/i, "app.js must import the game engine");
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    assert.match(app, new RegExp(key), `missing ${key} handling`);
  }
  for (const key of ["w", "a", "s", "d"]) {
    assert.match(
      app,
      new RegExp(
        `(?:["'\\\`]${key}["'\\\`]|\\b${key}\\s*:|Key${key.toUpperCase()})`,
        "i",
      ),
      `missing ${key.toUpperCase()} key handling`,
    );
  }

  const hasPointerSwipe = /pointerdown/i.test(app) && /pointerup/i.test(app);
  const hasTouchSwipe = /touchstart/i.test(app) && /touchend/i.test(app);
  assert.equal(hasPointerSwipe || hasTouchSwipe, true, "missing swipe handling");
  assert.match(app, /localStorage/i, "best score must use localStorage");
  assert.match(app, /preventDefault\s*\(/, "handled keys must prevent page scrolling");
});

test("the stylesheet keeps a four-column board usable on narrow screens", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /grid-template-columns\s*:\s*repeat\(\s*4\s*,/i,
    "the 2048 board must define a four-column CSS grid",
  );

  const hasNarrowScreenMediaQuery =
    /@media\b[^{}]*(?:width|orientation)\s*(?::|[<>=])/i.test(styles);
  const viewportWidthDeclarations = [
    ...styles.matchAll(
      /\b(?:width|inline-size)\s*:\s*([^;{}]*(?:vw|vmin|vmax|dvw|svw|lvw)[^;{}]*)[;}]/gi,
    ),
  ].map((match) => match[1]);
  const hasBoundedViewportWidth =
    viewportWidthDeclarations.some((value) =>
      /\b(?:min|max|clamp|calc)\s*\(/i.test(value),
    ) ||
    (viewportWidthDeclarations.length > 0 &&
      /\bmax-(?:width|inline-size)\s*:\s*[^;{}]+[;}]/i.test(styles));
  const hasScalableType =
    /font-size\s*:\s*[^;{}]*(?:clamp|min|max|calc)\s*\(/i.test(styles) ||
    /font-size\s*:\s*[^;{}]*(?:vw|vmin|vmax|dvw|svw|lvw)/i.test(styles);
  const hasSquareTiles = /aspect-ratio\s*:\s*1(?:\s*\/\s*1)?(?:\s*[;}])/i.test(
    styles,
  );
  const hasFluidNarrowScreenLayout =
    hasBoundedViewportWidth && (hasScalableType || hasSquareTiles);

  assert.equal(
    hasNarrowScreenMediaQuery || hasFluidNarrowScreenLayout,
    true,
    "styles.css must adapt to narrow screens with a responsive media query or a bounded viewport-relative layout with scalable type or square tiles",
  );
});
