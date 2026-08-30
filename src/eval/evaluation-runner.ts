import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main as runNash } from "../cli/main.js";
import { prepareStateDirectory } from "../session/session-paths.js";
import { readTrace } from "../session/trace-reader.js";
import { sanitizedEnvironment } from "../tools/run-command.js";
import { newSessionId } from "../trace/events.js";
import { Workspace } from "../workspace/workspace.js";

export interface EvaluationCase {
  readonly caseName: string;
  readonly protectedFiles: readonly string[];
  readonly graderFiles: readonly string[];
  readonly maxTurns: number;
  readonly maxTools: number;
  readonly maxDurationSeconds: number;
}

export interface EvaluationMetrics {
  readonly stopReason: string;
  readonly turns: number;
  readonly modelAttempts: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly durationMs: number;
}

export interface EvaluationResult {
  readonly caseName: string;
  readonly runId: string;
  readonly passed: boolean;
  readonly agentExitCode: number;
  readonly graderExitCode: number;
  readonly protectedFilesIntact: boolean;
  readonly workspace: string;
  readonly trace: string | null;
  readonly metrics: EvaluationMetrics | null;
}

export async function runEvaluation(
  configuration: EvaluationCase,
): Promise<EvaluationResult> {
  const repositoryRoot = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const caseRoot = path.join(
    repositoryRoot,
    "evals",
    "cases",
    configuration.caseName,
  );
  const fixture = path.join(caseRoot, "workspace");
  const graderFixture = path.join(caseRoot, "grader");
  const task = (await readFile(path.join(caseRoot, "task.txt"), "utf8")).trim();
  const runId = newSessionId();
  const repositoryWorkspace = await Workspace.open(repositoryRoot);
  const evaluationDirectory = await prepareStateDirectory(
    repositoryWorkspace,
    "evals",
  );
  const runRoot = path.join(
    evaluationDirectory,
    `${configuration.caseName}-${runId}`,
  );
  const workspace = path.join(runRoot, "workspace");
  await mkdir(runRoot, { recursive: false, mode: 0o700 });
  await cp(fixture, workspace, { recursive: true, errorOnExist: true });

  const protectedBefore = await hashFiles(
    workspace,
    configuration.protectedFiles,
    false,
  );
  process.stderr.write(
    `\nEvaluation case: ${configuration.caseName}\nIsolated workspace: ${path.relative(repositoryRoot, workspace)}\n\n`,
  );
  const agentExitCode = await runNash([
    "run",
    "--yes",
    "--workspace",
    workspace,
    "--max-turns",
    String(configuration.maxTurns),
    "--max-tools",
    String(configuration.maxTools),
    "--max-duration",
    String(configuration.maxDurationSeconds),
    task,
  ]);

  process.stderr.write("\nIndependent grader:\n");
  const graderDirectory = path.join(workspace, ".grader");
  await cp(graderFixture, graderDirectory, {
    recursive: true,
    errorOnExist: true,
  });
  const graderExitCode = await runProcess(
    "node",
    ["--import", "tsx", "--test", ...configuration.graderFiles],
    workspace,
    sanitizedEnvironment(process.env),
  );
  const protectedAfter = await hashFiles(
    workspace,
    configuration.protectedFiles,
    true,
  );
  const trace = await findSessionTrace(workspace);
  const metrics = trace === null ? null : await readMetrics(trace);
  const protectedFilesIntact = hashesEqual(protectedBefore, protectedAfter);
  const passed =
    agentExitCode === 0 && graderExitCode === 0 && protectedFilesIntact;
  const result: EvaluationResult = {
    caseName: configuration.caseName,
    runId,
    passed,
    agentExitCode,
    graderExitCode,
    protectedFilesIntact,
    workspace,
    trace,
    metrics,
  };
  await writeFile(
    path.join(runRoot, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  process.stderr.write(
    [
      "",
      `Evaluation: ${passed ? "PASS" : "FAIL"}`,
      `agent exit: ${agentExitCode}`,
      `grader exit: ${graderExitCode}`,
      `protected files: ${protectedFilesIntact ? "unchanged" : "modified"}`,
      `trace: ${trace === null ? "unavailable" : path.relative(repositoryRoot, trace)}`,
      `artifacts: ${path.relative(repositoryRoot, runRoot)}`,
      "",
    ].join("\n"),
  );
  return result;
}

export function runEvaluationEntry(configuration: EvaluationCase): void {
  void runEvaluation(configuration)
    .then((result) => {
      process.exitCode = result.passed ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

export function isEvaluationEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

async function findSessionTrace(workspace: string): Promise<string | null> {
  const directory = path.join(workspace, ".nash", "sessions");
  try {
    const entries = (await readdir(directory))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort();
    const latest = entries.at(-1);
    return latest === undefined ? null : path.join(directory, latest);
  } catch {
    return null;
  }
}

async function readMetrics(tracePath: string): Promise<EvaluationMetrics | null> {
  const events = await readTrace(tracePath);
  const finished = events.at(-1);
  if (finished?.type !== "session_finished") {
    return null;
  }
  const data = asRecord(finished.data);
  const usage = asRecord(data.usage);
  const stopReason = stringField(data, "stopReason");
  const turns = integerField(data, "turns");
  const modelAttempts = integerField(data, "modelAttempts");
  const toolCalls = integerField(data, "toolCalls");
  const inputTokens = integerField(usage, "inputTokens");
  const outputTokens = integerField(usage, "outputTokens");
  const cacheHitTokens = integerField(usage, "cacheHitTokens");
  const cacheMissTokens = integerField(usage, "cacheMissTokens");
  const durationMs = integerField(data, "durationMs");
  if (
    stopReason === undefined ||
    turns === undefined ||
    modelAttempts === undefined ||
    toolCalls === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheHitTokens === undefined ||
    cacheMissTokens === undefined ||
    durationMs === undefined
  ) {
    return null;
  }
  return {
    stopReason,
    turns,
    modelAttempts,
    toolCalls,
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheMissTokens,
    durationMs,
  };
}

async function hashFiles(
  root: string,
  files: readonly string[],
  allowMissing: boolean,
): Promise<ReadonlyMap<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of files) {
    try {
      const content = await readFile(path.join(root, file));
      hashes.set(file, createHash("sha256").update(content).digest("hex"));
    } catch {
      if (!allowMissing) {
        throw new Error(`evaluation fixture is missing protected file ${file}`);
      }
      hashes.set(file, "missing");
    }
  }
  return hashes;
}

function hashesEqual(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): boolean {
  return (
    before.size === after.size &&
    [...before].every(([file, hash]) => after.get(file) === hash)
  );
}

async function runProcess(
  command: string,
  arguments_: readonly string[],
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: workingDirectory,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  return typeof record[field] === "string" ? record[field] : undefined;
}

function integerField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}
