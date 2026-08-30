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
        "--thinking",
        "disabled",
        "--reasoning-effort",
        "max",
        "--max-output-tokens",
        "4096",
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
      provider: {
        model: "deepseek-test",
        thinking: "disabled",
        reasoningEffort: "max",
        maxOutputTokens: 4_096,
      },
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
    provider: {},
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
    ["run", "--model", "one", "--model", "two", "task"],
    ["run", "--thinking", "enabled", "--thinking", "disabled", "task"],
    [
      "run",
      "--reasoning-effort",
      "low",
      "--reasoning-effort",
      "high",
      "task",
    ],
    [
      "run",
      "--max-output-tokens",
      "256",
      "--max-output-tokens",
      "512",
      "task",
    ],
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
    ["run", "--thinking", "--yes", "task"],
    ["run", "--reasoning-effort", "--yes", "task"],
    ["run", "--max-output-tokens", "--yes", "task"],
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

test("parseCliArguments parses provider enum values and output-token boundaries", () => {
  for (const thinking of ["enabled", "disabled"] as const) {
    const command = parseCliArguments(["run", "--thinking", thinking, "task"]);
    assert.equal(command.kind, "run");
    assert.deepEqual(command.provider, { thinking });
  }

  for (const reasoningEffort of ["low", "high", "max"] as const) {
    const command = parseCliArguments([
      "run",
      "--reasoning-effort",
      reasoningEffort,
      "task",
    ]);
    assert.equal(command.kind, "run");
    assert.deepEqual(command.provider, { reasoningEffort });
  }

  for (const [raw, maxOutputTokens] of [
    ["256", 256],
    ["384000", 384_000],
  ] as const) {
    const command = parseCliArguments([
      "run",
      "--max-output-tokens",
      raw,
      "task",
    ]);
    assert.equal(command.kind, "run");
    assert.deepEqual(command.provider, { maxOutputTokens });
  }
});

test("parseCliArguments rejects invalid provider enums and output-token bounds", () => {
  for (const arguments_ of [
    ["run", "--thinking", "auto", "task"],
    ["run", "--thinking", "ENABLED", "task"],
    ["run", "--reasoning-effort", "medium", "task"],
    ["run", "--reasoning-effort", "MAX", "task"],
    ["run", "--max-output-tokens", "255", "task"],
    ["run", "--max-output-tokens", "384001", "task"],
    ["run", "--max-output-tokens", "256.5", "task"],
    ["run", "--max-output-tokens", "NaN", "task"],
  ]) {
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
