import { readFile, stat } from "node:fs/promises";

import type { ToolDefinition } from "../core/types.js";
import { safeDisplay } from "../text/safe-display.js";
import type { Workspace } from "../workspace/workspace.js";
import {
  objectSchema,
  optionalInteger,
  parseArgumentObject,
  requiredString,
} from "./arguments.js";
import {
  MAX_FILE_READ_BYTES,
  InvalidEncodingError,
  decodeUtf8,
  messageOf,
} from "./file-helpers.js";
import {
  type LocalTool,
  type PreparedToolCall,
  ToolInputError,
  failure,
  success,
} from "./types.js";

const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 500;
const MAX_READ_OUTPUT_BYTES = 64 * 1024;

export class ReadFileTool implements LocalTool {
  public readonly effect = "read" as const;
  public readonly definition: ToolDefinition = {
    name: "read_file",
    description:
      "Read a bounded line range from a UTF-8 text file inside the workspace. Lines include stable line numbers.",
    parameters: objectSchema(
      {
        path: { type: "string", description: "Workspace-relative file path" },
        start_line: { type: "integer", minimum: 1, description: "First line, default 1" },
        end_line: { type: "integer", minimum: 1, description: "Last line, inclusive" },
      },
      ["path"],
    ),
  };

  readonly #workspace: Workspace;

  public constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  public prepare(argumentsJson: string): PreparedToolCall {
    const object = parseArgumentObject(argumentsJson, ["path", "start_line", "end_line"]);
    const requestedPath = requiredString(object, "path", { nonBlank: true });
    const startLine = optionalInteger(object, "start_line", 1, 1, Number.MAX_SAFE_INTEGER);
    const defaultEnd = Math.min(Number.MAX_SAFE_INTEGER, startLine + DEFAULT_READ_LINES - 1);
    const endLine = optionalInteger(
      object,
      "end_line",
      defaultEnd,
      startLine,
      Number.MAX_SAFE_INTEGER,
    );
    if (endLine - startLine + 1 > MAX_READ_LINES) {
      throw new ToolInputError(
        `read range exceeds the ${MAX_READ_LINES} line limit`,
        "limit_exceeded",
      );
    }

    return {
      preview: `read ${safeDisplay(requestedPath)}`,
      execute: async (signal) =>
        await this.#execute(requestedPath, startLine, endLine, signal),
    };
  }

  async #execute(
    requestedPath: string,
    startLine: number,
    endLine: number,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      return failure("read was cancelled", "cancelled");
    }
    let resolved: string;
    try {
      resolved = await this.#workspace.resolveExisting(requestedPath);
    } catch (error) {
      return failure(`cannot resolve file: ${messageOf(error)}`, "path_error");
    }

    try {
      const information = await stat(resolved);
      if (!information.isFile()) {
        return failure("path is not a regular file", "invalid_file_type");
      }
      if (information.size > MAX_FILE_READ_BYTES) {
        return failure(
          `file exceeds the ${MAX_FILE_READ_BYTES} byte read limit`,
          "limit_exceeded",
        );
      }
      const bytes = await readFile(resolved);
      if (bytes.byteLength > MAX_FILE_READ_BYTES) {
        return failure(
          `file exceeds the ${MAX_FILE_READ_BYTES} byte read limit`,
          "limit_exceeded",
        );
      }
      if (bytes.includes(0)) {
        return failure("file appears to be binary", "binary_file");
      }
      const text = decodeUtf8(bytes);
      const lines = splitLines(text);
      const output: string[] = [];
      let outputBytes = 0;
      let returned = 0;
      let truncated = false;
      const last = Math.min(endLine, lines.length);
      for (let lineNumber = startLine; lineNumber <= last; lineNumber++) {
        if (signal.aborted) {
          return failure("read was cancelled", "cancelled");
        }
        const line = lines[lineNumber - 1] ?? "";
        const formatted = `${String(lineNumber).padStart(6)} | ${line}\n`;
        const bytesInLine = Buffer.byteLength(formatted);
        if (outputBytes + bytesInLine > MAX_READ_OUTPUT_BYTES) {
          truncated = true;
          break;
        }
        output.push(formatted);
        outputBytes += bytesInLine;
        returned++;
      }
      if (output.length === 0) {
        output.push("(no lines in requested range)\n");
      }
      if (truncated) {
        output.push("... output truncated by byte limit ...\n");
      }
      return success(output.join(""), {
        path: this.#workspace.relative(resolved),
        start_line: startLine,
        lines_returned: returned,
        truncated,
      });
    } catch (error) {
      if (error instanceof InvalidEncodingError) {
        return failure(error.message, "invalid_encoding");
      }
      return failure(`cannot read file: ${messageOf(error)}`, "io_error");
    }
  }
}

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r\n|\n|\r/);
  if (/\r\n$|[\n\r]$/.test(text)) {
    lines.pop();
  }
  return lines;
}
