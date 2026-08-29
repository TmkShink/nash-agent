package tool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/TmkShink/nash-agent/internal/core"
	"github.com/TmkShink/nash-agent/internal/workspace"
)

type WriteFile struct {
	workspace *workspace.Workspace
}

func NewWriteFile(workspace *workspace.Workspace) *WriteFile {
	return &WriteFile{workspace: workspace}
}

func (t *WriteFile) Definition() core.ToolDefinition {
	return core.ToolDefinition{
		Name:        "write_file",
		Description: "Create a UTF-8 text file inside the workspace. Existing files require overwrite=true. Writes are atomic within the target directory.",
		InputSchema: objectSchema(map[string]any{
			"path":      map[string]any{"type": "string", "description": "Workspace-relative file path"},
			"content":   map[string]any{"type": "string", "description": "Complete file content"},
			"overwrite": map[string]any{"type": "boolean", "description": "Allow replacing an existing file, default false"},
		}, "path", "content"),
	}
}

func (*WriteFile) Effect() Effect { return EffectWrite }

func (*WriteFile) Preview(arguments string) string {
	var args struct {
		Path      string `json:"path"`
		Content   string `json:"content"`
		Overwrite bool   `json:"overwrite"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return "write file"
	}
	action := "create"
	if args.Overwrite {
		action = "write"
	}
	return fmt.Sprintf("%s %s (%d bytes)", action, args.Path, len(args.Content))
}

func (t *WriteFile) Execute(ctx context.Context, arguments string) Result {
	if err := ctx.Err(); err != nil {
		return Failure("write cancelled: "+err.Error(), map[string]any{"kind": "cancelled"})
	}
	var args struct {
		Path      string `json:"path"`
		Content   string `json:"content"`
		Overwrite bool   `json:"overwrite"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return Failure("invalid write_file arguments: "+err.Error(), map[string]any{"kind": "invalid_arguments"})
	}
	if strings.TrimSpace(args.Path) == "" {
		return Failure("path is required", map[string]any{"kind": "invalid_arguments"})
	}
	if len(args.Content) > maxFileWriteBytes {
		return Failure(fmt.Sprintf("content exceeds the %d byte limit", maxFileWriteBytes), map[string]any{"kind": "limit_exceeded"})
	}

	path, err := t.workspace.ResolveForWrite(args.Path)
	if err != nil {
		return Failure("cannot resolve file: "+err.Error(), map[string]any{"kind": "path_error"})
	}
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		if info.IsDir() {
			return Failure("target is a directory", map[string]any{"kind": "invalid_file_type"})
		}
		if !args.Overwrite {
			return Failure("target already exists; set overwrite=true or use edit_file", map[string]any{"kind": "already_exists"})
		}
		mode = info.Mode()
	} else if !os.IsNotExist(err) {
		return Failure("cannot stat target: "+err.Error(), map[string]any{"kind": "io_error"})
	}

	if err := ctx.Err(); err != nil {
		return Failure("write cancelled: "+err.Error(), map[string]any{"kind": "cancelled"})
	}
	if err := writeFileAtomic(path, []byte(args.Content), mode, args.Overwrite); err != nil {
		if !args.Overwrite && errors.Is(err, os.ErrExist) {
			return Failure("target already exists; set overwrite=true or use edit_file", map[string]any{"kind": "already_exists"})
		}
		return Failure("cannot write file: "+err.Error(), map[string]any{"kind": "io_error"})
	}
	return Success(fmt.Sprintf("wrote %d bytes to %s", len(args.Content), t.workspace.Relative(path)), map[string]any{
		"path":  t.workspace.Relative(path),
		"bytes": len(args.Content),
	})
}
