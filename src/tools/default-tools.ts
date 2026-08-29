import type { Workspace } from "../workspace/workspace.js";
import { EditFileTool } from "./edit-file.js";
import { ListFilesTool } from "./list-files.js";
import { ReadFileTool } from "./read-file.js";
import { RunCommandTool } from "./run-command.js";
import type { LocalTool } from "./types.js";
import { WriteFileTool } from "./write-file.js";

export function createDefaultTools(workspace: Workspace): readonly LocalTool[] {
  return [
    new ReadFileTool(workspace),
    new ListFilesTool(workspace),
    new WriteFileTool(workspace),
    new EditFileTool(workspace),
    new RunCommandTool(workspace),
  ];
}
