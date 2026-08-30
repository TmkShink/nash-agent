#!/usr/bin/env node

import {
  type EvaluationCase,
  type EvaluationResult,
  isEvaluationEntryPoint,
  runEvaluation,
  runEvaluationEntry,
} from "./evaluation-runner.js";

const GAME_2048_CASE: EvaluationCase = {
  caseName: "game-2048",
  protectedFiles: [
    "README.md",
    "package.json",
    "scripts/serve.mjs",
    "test/game.test.js",
  ],
  graderFiles: ["test/game.test.js", ".grader/game.hidden.test.js"],
  maxTurns: 20,
  maxTools: 48,
  maxDurationSeconds: 360,
};

export async function runGame2048Evaluation(): Promise<EvaluationResult> {
  return await runEvaluation(GAME_2048_CASE);
}

if (isEvaluationEntryPoint(import.meta.url)) {
  runEvaluationEntry(GAME_2048_CASE);
}
