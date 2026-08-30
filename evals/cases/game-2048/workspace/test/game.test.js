import assert from "node:assert/strict";
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

const emptyBoard = () =>
  Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0));

const cloneBoard = (board) => board.map((row) => [...row]);

test("SIZE is four and slideAndMerge compresses a line before merging", () => {
  assert.equal(SIZE, 4);

  const input = [0, 2, 2, 4];
  const snapshot = [...input];
  const result = slideAndMerge(input);

  assert.deepEqual(result, {
    line: [4, 4, 0, 0],
    scoreGained: 4,
  });
  assert.deepEqual(input, snapshot, "slideAndMerge must not mutate its input");
});

test("moveBoard moves and scores an entire board", () => {
  const board = [
    [2, 0, 2, 4],
    [4, 4, 8, 8],
    [0, 0, 0, 0],
    [2, 4, 8, 16],
  ];
  const snapshot = cloneBoard(board);

  const result = moveBoard(board, "left");

  assert.deepEqual(result, {
    board: [
      [4, 4, 0, 0],
      [8, 16, 0, 0],
      [0, 0, 0, 0],
      [2, 4, 8, 16],
    ],
    scoreGained: 28,
    moved: true,
  });
  assert.deepEqual(board, snapshot, "moveBoard must not mutate its input");
});

test("addRandomTile chooses a row-major empty cell and a tile value", () => {
  const board = emptyBoard();
  const snapshot = cloneBoard(board);
  const values = [0.5, 0.95];
  let calls = 0;

  const result = addRandomTile(board, () => values[calls++]);

  const expected = emptyBoard();
  expected[2][0] = 4;
  assert.deepEqual(result, expected);
  assert.equal(calls, 2);
  assert.notStrictEqual(result, board);
  assert.deepEqual(board, snapshot, "addRandomTile must not mutate its input");
});

test("hasAvailableMoves recognizes an empty cell and a locked board", () => {
  const withSpace = [
    [2, 4, 8, 16],
    [4, 8, 16, 32],
    [8, 16, 32, 64],
    [16, 32, 64, 0],
  ];
  const locked = [
    [2, 4, 8, 16],
    [4, 8, 16, 32],
    [8, 16, 32, 64],
    [16, 32, 64, 128],
  ];

  assert.equal(hasAvailableMoves(withSpace), true);
  assert.equal(hasAvailableMoves(locked), false);
});

test("createGame starts with two tiles, zero score, and playing status", () => {
  const values = [0, 0, 0, 0];
  let calls = 0;

  const state = createGame(() => values[calls++]);

  const expected = emptyBoard();
  expected[0][0] = 2;
  expected[0][1] = 2;
  assert.deepEqual(state, {
    board: expected,
    score: 0,
    status: "playing",
  });
  assert.equal(calls, 4);
});

test("move merges, accumulates score, and spawns one tile", () => {
  const state = {
    board: [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    score: 12,
    status: "playing",
  };
  const snapshot = cloneBoard(state.board);
  const values = [0, 0];
  let calls = 0;

  const result = move(state, "left", () => values[calls++]);

  assert.deepEqual(result, {
    board: [
      [4, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    score: 16,
    status: "playing",
    moved: true,
  });
  assert.equal(calls, 2);
  assert.deepEqual(state.board, snapshot, "move must not mutate the state board");
});

test("an unchanged move consumes no randomness and spawns no tile", () => {
  const state = {
    board: [
      [2, 4, 0, 0],
      [8, 16, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    score: 7,
    status: "playing",
  };

  const result = move(state, "left", () => {
    throw new Error("random must not be called for an unchanged move");
  });

  assert.deepEqual(result, {
    board: state.board,
    score: 7,
    status: "playing",
    moved: false,
  });
});
