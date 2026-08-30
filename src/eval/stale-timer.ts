#!/usr/bin/env node

import {
  type EvaluationCase,
  type EvaluationResult,
  isEvaluationEntryPoint,
  runEvaluation,
  runEvaluationEntry,
} from "./evaluation-runner.js";

const STALE_TIMER_CASE: EvaluationCase = {
  caseName: "stale-timer",
  protectedFiles: [
    "README.md",
    "package.json",
    "tsconfig.json",
    "test/lease-cache.test.ts",
  ],
  graderFiles: [
    "test/lease-cache.test.ts",
    ".grader/lease-cache.hidden.test.ts",
  ],
  maxTurns: 12,
  maxTools: 24,
  maxDurationSeconds: 240,
};

export async function runStaleTimerEvaluation(): Promise<EvaluationResult> {
  return await runEvaluation(STALE_TIMER_CASE);
}

if (isEvaluationEntryPoint(import.meta.url)) {
  runEvaluationEntry(STALE_TIMER_CASE);
}

export type { EvaluationResult } from "./evaluation-runner.js";
