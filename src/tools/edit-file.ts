import { readFile, stat } from "node:fs/promises";

import type { ToolDefinition } from "../core/types.js";
import { safeDisplay } from "../text/safe-display.js";
import type { Workspace } from "../workspace/workspace.js";
import { objectSchema, parseArgumentObject, requiredString } from "./arguments.js";
import {
  MAX_FILE_WRITE_BYTES,
  InvalidEncodingError,
  decodeUtf8,
  messageOf,
  writeFileAtomic,
} from "./file-helpers.js";
import {
  type LocalTool,
  type PreparedToolCall,
  ToolInputError,
  failure,
  success,
} from "./types.js";

export class EditFileTool implements LocalTool {
  public readonly effect = "write" as const;
  public readonly definition: ToolDefinition = {
    name: "edit_file",
    description:
      "Replace one exact, unique text fragment in an existing workspace file. Missing or ambiguous context is rejected.",
    parameters: objectSchema(
      {
        path: { type: "string", description: "Workspace-relative file path" },
        old_text: { type: "string", description: "Exact text that must occur once" },
        new_text: { type: "string", description: "Replacement text" },
      },
      ["path", "old_text", "new_text"],
    ),
  };

  readonly #workspace: Workspace;

  public constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  public prepare(argumentsJson: string): PreparedToolCall {
    const object = parseArgumentObject(argumentsJson, ["path", "old_text", "new_text"]);
    const requestedPath = requiredString(object, "path", { nonBlank: true });
    const oldText = requiredString(object, "old_text");
    const newText = requiredString(object, "new_text");
    if (oldText === "") {
      throw new ToolInputError("old_text must not be empty");
    }
    if (
      Buffer.byteLength(oldText) > MAX_FILE_WRITE_BYTES ||
      Buffer.byteLength(newText) > MAX_FILE_WRITE_BYTES
    ) {
      throw new ToolInputError("edit text exceeds the size limit", "limit_exceeded");
    }
    return {
      preview: `edit ${safeDisplay(requestedPath)} (-${Buffer.byteLength(oldText)} +${Buffer.byteLength(newText)} bytes)`,
      execute: async (signal) =>
        await this.#execute(requestedPath, oldText, newText, signal),
    };
  }

  async #execute(
    requestedPath: string,
    oldText: string,
    newText: string,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      return failure("edit was cancelled", "cancelled");
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
      if (information.size > MAX_FILE_WRITE_BYTES) {
        return failure("file exceeds the editable size limit", "limit_exceeded");
      }
      const bytes = await readFile(resolved);
      if (bytes.byteLength > MAX_FILE_WRITE_BYTES) {
        return failure("file exceeds the editable size limit", "limit_exceeded");
      }
      if (bytes.includes(0)) {
        return failure("file appears to be binary", "binary_file");
      }
      const content = decodeUtf8(bytes);
      const occurrences = countOccurrences(content, oldText);
      if (occurrences === 0) {
        return failure(
          "old_text was not found; read the file again before editing",
          "stale_edit",
        );
      }
      if (occurrences > 1) {
        return failure(
          `old_text occurs ${occurrences} times; include more context`,
          "ambiguous_edit",
          { matches: occurrences },
        );
      }

      const updated = content.replace(oldText, newText);
      const updatedBytes = Buffer.byteLength(updated);
      if (updatedBytes > MAX_FILE_WRITE_BYTES) {
        return failure("edited file exceeds the size limit", "limit_exceeded");
      }
      if (signal.aborted) {
        return failure("edit was cancelled", "cancelled");
      }
      await writeFileAtomic(resolved, updated, information.mode & 0o777, true);
      return success(`updated ${this.#workspace.relative(resolved)}`, {
        path: this.#workspace.relative(resolved),
        bytes_before: bytes.byteLength,
        bytes_after: updatedBytes,
      });
    } catch (error) {
      if (error instanceof InvalidEncodingError) {
        return failure(error.message, "invalid_encoding");
      }
      return failure(`cannot edit file: ${messageOf(error)}`, "io_error");
    }
  }
}

function countOccurrences(content: string, fragment: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(fragment, offset);
    if (index === -1) {
      return count;
    }
    count++;
    offset = index + fragment.length;
  }
}
