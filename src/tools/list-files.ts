import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ToolDefinition } from "../core/types.js";
import { safeDisplay } from "../text/safe-display.js";
import type { Workspace } from "../workspace/workspace.js";
import { isAgentVisibleName } from "../workspace/agent-path-policy.js";
import {
  objectSchema,
  optionalInteger,
  optionalString,
  parseArgumentObject,
} from "./arguments.js";
import { messageOf } from "./file-helpers.js";
import {
  type LocalTool,
  type PreparedToolCall,
  ToolInputError,
  failure,
  success,
} from "./types.js";

const IGNORED_DIRECTORIES = new Set(["node_modules"]);

export class ListFilesTool implements LocalTool {
  public readonly effect = "read" as const;
  public readonly definition: ToolDefinition = {
    name: "list_files",
    description:
      "List workspace files in deterministic order without following symlinked directories. Skips .git, .nash, and node_modules.",
    parameters: objectSchema({
      path: { type: "string", description: "Directory to list, default ." },
      max_depth: { type: "integer", minimum: 1, maximum: 5, description: "Recursive depth, default 2" },
      max_entries: { type: "integer", minimum: 1, maximum: 500, description: "Entry limit, default 200" },
    }),
  };

  readonly #workspace: Workspace;

  public constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  public prepare(argumentsJson: string): PreparedToolCall {
    const object = parseArgumentObject(argumentsJson, ["path", "max_depth", "max_entries"]);
    const requestedPath = optionalString(object, "path", ".");
    if (requestedPath.trim() === "") {
      throw new ToolInputError("path must not be blank");
    }
    const maxDepth = optionalInteger(object, "max_depth", 2, 1, 5);
    const maxEntries = optionalInteger(object, "max_entries", 200, 1, 500);
    return {
      preview: `list ${safeDisplay(requestedPath)}`,
      execute: async (signal) =>
        await this.#execute(requestedPath, maxDepth, maxEntries, signal),
    };
  }

  async #execute(
    requestedPath: string,
    maxDepth: number,
    maxEntries: number,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      return failure("listing was cancelled", "cancelled");
    }
    let root: string;
    try {
      root = await this.#workspace.resolveExisting(requestedPath);
    } catch (error) {
      return failure(`cannot resolve directory: ${messageOf(error)}`, "path_error");
    }

    try {
      if (!(await stat(root)).isDirectory()) {
        return failure("path is not a directory", "invalid_file_type");
      }
      const output: string[] = [];
      let entries = 0;
      let truncated = false;

      const visit = async (directory: string, depth: number): Promise<void> => {
        const children = await readdir(directory, { withFileTypes: true });
        children.sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );
        for (const child of children) {
          if (signal.aborted) {
            throw new CancellationError();
          }
          if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) {
            continue;
          }
          if (!isAgentVisibleName(child.name)) {
            continue;
          }
          if (entries >= maxEntries) {
            truncated = true;
            return;
          }
          const absolute = path.join(directory, child.name);
          let display = safeDisplay(this.#workspace.relative(absolute), 1_000);
          if (child.isDirectory()) {
            display += "/";
          } else if (child.isSymbolicLink()) {
            display += "@";
          }
          output.push(`${display}\n`);
          entries++;

          if (child.isDirectory() && depth < maxDepth) {
            await visit(absolute, depth + 1);
            if (truncated) {
              return;
            }
          }
        }
      };

      await visit(root, 1);
      if (entries === 0) {
        output.push("(directory is empty)\n");
      }
      if (truncated) {
        output.push(`... listing truncated after ${entries} entries ...\n`);
      }
      return success(output.join(""), { entries, truncated });
    } catch (error) {
      if (error instanceof CancellationError) {
        return failure("listing was cancelled", "cancelled");
      }
      return failure(`cannot list directory: ${messageOf(error)}`, "io_error");
    }
  }
}

class CancellationError extends Error {}
