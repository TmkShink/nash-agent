#!/usr/bin/env node

const usage = `Nash coding agent

Usage:
  nash run [options] <task>
  nash inspect <session>
  nash replay <session>

The runnable agent loop is under active development. Use --help to show this
message while the first TypeScript vertical slice is being completed.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`${usage}\n`);
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
}
