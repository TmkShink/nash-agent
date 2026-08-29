#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { main as runNash } from "../cli/main.js";
import { prepareStateDirectory } from "../session/session-paths.js";
import { sanitizedEnvironment } from "../tools/run-command.js";
import { newSessionId } from "../trace/events.js";
import { Workspace } from "../workspace/workspace.js";

const CASE_NAME = "stale-timer";
const PROTECTED_FILES = [
  "README.md",
  "package.json",
  "tsconfig.json",
  "test/lease-cache.test.ts",
] as const;

export interface EvaluationResult {
  readonly caseName: string;
  readonly runId: string;
  readonly passed: boolean;
  readonly agentExitCode: number;
  readonly graderExitCode: number;
  readonly protectedFilesIntact: boolean;
  readonly workspace: string;
  readonly trace: string | null;
}

export async function runStaleTimerEvaluation(): Promise<EvaluationResult> {
  const repositoryRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const caseRoot = path.join(repositoryRoot, "evals", "cases", CASE_NAME);
  const fixture = path.join(caseRoot, "workspace");
  const graderFixture = path.join(caseRoot, "grader");
  const task = (await readFile(path.join(caseRoot, "task.txt"), "utf8")).trim();
  const runId = newSessionId();
  const repositoryWorkspace = await Workspace.open(repositoryRoot);
  const evaluationDirectory = await prepareStateDirectory(
    repositoryWorkspace,
    "evals",
  );
  const runRoot = path.join(evaluationDirectory, `${CASE_NAME}-${runId}`);
  const workspace = path.join(runRoot, "workspace");
  await mkdir(runRoot, { recursive: false, mode: 0o700 });
  await cp(fixture, workspace, { recursive: true, errorOnExist: true });

  const protectedBefore = await hashFiles(workspace, PROTECTED_FILES, false);
  process.stderr.write(
    `\nEvaluation case: ${CASE_NAME}\nIsolated workspace: ${path.relative(repositoryRoot, workspace)}\n\n`,
  );
  const agentExitCode = await runNash([
    "run",
    "--yes",
    "--workspace",
    workspace,
    "--max-turns",
    "12",
    "--max-tools",
    "24",
    "--max-duration",
    "240",
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
    [
      "--import",
      "tsx",
      "--test",
      "test/lease-cache.test.ts",
      ".grader/lease-cache.hidden.test.ts",
    ],
    workspace,
    sanitizedEnvironment(process.env),
  );
  const protectedAfter = await hashFiles(workspace, PROTECTED_FILES, true);
  const trace = await findSessionTrace(workspace);
  const protectedFilesIntact = hashesEqual(protectedBefore, protectedAfter);
  const passed =
    agentExitCode === 0 && graderExitCode === 0 && protectedFilesIntact;
  const result: EvaluationResult = {
    caseName: CASE_NAME,
    runId,
    passed,
    agentExitCode,
    graderExitCode,
    protectedFilesIntact,
    workspace,
    trace,
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

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void runStaleTimerEvaluation()
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
