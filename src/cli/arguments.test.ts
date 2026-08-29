import assert from "node:assert/strict";
import test from "node:test";

import {
  CliUsageError,
  parseCliArguments,
} from "./arguments.js";

test("parseCliArguments parses run options and limits", () => {
  assert.deepEqual(
    parseCliArguments(
      [
        "run",
        "-w",
        "/work",
        "--model",
        "deepseek-test",
        "--yes",
        "--max-turns",
        "3",
        "--max-tools",
        "4",
        "--max-tokens",
        "500",
        "--max-duration",
        "7",
        "fix",
        "the",
        "bug",
      ],
      "/default",
    ),
    {
      kind: "run",
      workspace: "/work",
      task: "fix the bug",
      allowAll: true,
      model: "deepseek-test",
      limits: {
        maxTurns: 3,
        maxToolCalls: 4,
        maxTotalTokens: 500,
        maxDurationMs: 7_000,
      },
    },
  );
});

test("parseCliArguments parses inspect and replay", () => {
  assert.deepEqual(
    parseCliArguments(["inspect", "--workspace", "/work", "session-1"]),
    { kind: "inspect", workspace: "/work", reference: "session-1" },
  );
  assert.deepEqual(
    parseCliArguments(["replay", "-w", "/work", "--speed", "2.5", "trace.jsonl"]),
    {
      kind: "replay",
      workspace: "/work",
      reference: "trace.jsonl",
      speed: 2.5,
    },
  );
  assert.deepEqual(parseCliArguments(["replay", "session-1"], "/current"), {
    kind: "replay",
    workspace: "/current",
    reference: "session-1",
    speed: 1,
  });
});

test("parseCliArguments treats every token after -- as positional", () => {
  assert.deepEqual(parseCliArguments(["run", "--", "--help", "--yes"]), {
    kind: "run",
    workspace: process.cwd(),
    task: "--help --yes",
    allowAll: false,
    limits: {},
  });
  assert.deepEqual(
    parseCliArguments(["inspect", "--", "--trace.jsonl"], "/work"),
    { kind: "inspect", workspace: "/work", reference: "--trace.jsonl" },
  );
});

test("parseCliArguments rejects duplicate and unknown options", () => {
  const invalid = [
    ["run", "--yes", "--yes", "task"],
    ["run", "-w", "one", "--workspace", "two", "task"],
    ["run", "--unknown", "value", "task"],
    ["inspect", "--workspace", "one", "-w", "two", "session"],
    ["inspect", "--speed", "2", "session"],
    ["replay", "--speed", "1", "--speed", "2", "session"],
    ["unknown"],
  ];

  for (const arguments_ of invalid) {
    assert.throws(() => parseCliArguments(arguments_), CliUsageError);
  }
});

test("parseCliArguments rejects missing option values and session references", () => {
  const invalid = [
    ["run", "--workspace"],
    ["run", "--model", "--yes", "task"],
    ["run", "--max-turns", "task"],
    ["replay", "--speed"],
    ["inspect"],
    ["inspect", "first", "second"],
    ["replay", ""],
  ];

  for (const arguments_ of invalid) {
    assert.throws(() => parseCliArguments(arguments_), CliUsageError);
  }
});

test("parseCliArguments validates every positive integer run limit", () => {
  for (const option of [
    "--max-turns",
    "--max-tools",
    "--max-tokens",
    "--max-duration",
  ]) {
    for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
      assert.throws(
        () => parseCliArguments(["run", option, value, "task"]),
        CliUsageError,
      );
    }
  }
});

test("parseCliArguments accepts replay speed boundaries and rejects overflow", () => {
  for (const [value, expected] of [
    ["0", 0],
    [".5", 0.5],
    ["100", 100],
  ] as const) {
    const command = parseCliArguments(["replay", "--speed", value, "session"]);
    assert.equal(command.kind, "replay");
    assert.equal(command.speed, expected);
  }

  for (const value of ["-1", "100.1", "Infinity", "NaN", ".", "1e2"]) {
    assert.throws(
      () => parseCliArguments(["replay", "--speed", value, "session"]),
      CliUsageError,
    );
  }
});
