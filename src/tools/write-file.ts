import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ToolDefinition } from "../core/types.js";
import { safeDisplay } from "../text/safe-display.js";
import type { Workspace } from "../workspace/workspace.js";
import {
  objectSchema,
  optionalBoolean,
  parseArgumentObject,
  requiredString,
} from "./arguments.js";
import {
  MAX_FILE_WRITE_BYTES,
  errorCode,
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

export class WriteFileTool implements LocalTool {
  public readonly effect = "write" as const;
  public readonly definition: ToolDefinition = {
    name: "write_file",
    description:
      "Create a UTF-8 text file inside the workspace. Existing files require overwrite=true. Writes are atomic within the target directory.",
    parameters: objectSchema(
      {
        path: { type: "string", description: "Workspace-relative file path" },
        content: { type: "string", description: "Complete file content" },
        overwrite: { type: "boolean", description: "Allow replacing an existing file, default false" },
      },
      ["path", "content"],
    ),
  };

  readonly #workspace: Workspace;

  public constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  public prepare(argumentsJson: string): PreparedToolCall {
    const object = parseArgumentObject(argumentsJson, ["path", "content", "overwrite"]);
    const requestedPath = requiredString(object, "path", { nonBlank: true });
    const content = requiredString(object, "content");
    const overwrite = optionalBoolean(object, "overwrite", false);
    const contentBytes = Buffer.byteLength(content);
    if (contentBytes > MAX_FILE_WRITE_BYTES) {
      throw new ToolInputError(
        `content exceeds the ${MAX_FILE_WRITE_BYTES} byte limit`,
        "limit_exceeded",
      );
    }
    return {
      preview: `${overwrite ? "write" : "create"} ${safeDisplay(requestedPath)} (${contentBytes} bytes)`,
      execute: async (signal) =>
        await this.#execute(requestedPath, content, contentBytes, overwrite, signal),
    };
  }

  async #execute(
    requestedPath: string,
    content: string,
    contentBytes: number,
    overwrite: boolean,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      return failure("write was cancelled", "cancelled");
    }
    let resolved: string;
    try {
      resolved = await this.#workspace.resolveForWrite(requestedPath);
      await mkdir(path.dirname(resolved), { recursive: true, mode: 0o755 });
      // Check again after creating parents so newly introduced symlinks are
      // still subject to the workspace boundary.
      resolved = await this.#workspace.resolveForWrite(requestedPath);
    } catch (error) {
      return failure(`cannot resolve file: ${messageOf(error)}`, "path_error");
    }

    let mode = 0o644;
    try {
      const information = await stat(resolved);
      if (!information.isFile()) {
        return failure("target is not a regular file", "invalid_file_type");
      }
      if (!overwrite) {
        return failure(
          "target already exists; set overwrite=true or use edit_file",
          "already_exists",
        );
      }
      mode = information.mode & 0o777;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return failure(`cannot stat target: ${messageOf(error)}`, "io_error");
      }
    }

    if (signal.aborted) {
      return failure("write was cancelled", "cancelled");
    }
    try {
      await writeFileAtomic(resolved, content, mode, overwrite);
    } catch (error) {
      if (!overwrite && errorCode(error) === "EEXIST") {
        return failure(
          "target already exists; set overwrite=true or use edit_file",
          "already_exists",
        );
      }
      return failure(`cannot write file: ${messageOf(error)}`, "io_error");
    }
    return success(`wrote ${contentBytes} bytes to ${this.#workspace.relative(resolved)}`, {
      path: this.#workspace.relative(resolved),
      bytes: contentBytes,
    });
  }
}
