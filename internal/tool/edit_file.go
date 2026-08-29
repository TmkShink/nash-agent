package tool

import (
	"context"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/TmkShink/nash-agent/internal/core"
	"github.com/TmkShink/nash-agent/internal/workspace"
)

type EditFile struct {
	workspace *workspace.Workspace
}

func NewEditFile(workspace *workspace.Workspace) *EditFile {
	return &EditFile{workspace: workspace}
}

func (t *EditFile) Definition() core.ToolDefinition {
	return core.ToolDefinition{
		Name:        "edit_file",
		Description: "Replace one exact, unique text fragment in an existing workspace file. The edit fails when the old text is missing or ambiguous.",
		InputSchema: objectSchema(map[string]any{
			"path":     map[string]any{"type": "string", "description": "Workspace-relative file path"},
			"old_text": map[string]any{"type": "string", "description": "Exact text that must occur once"},
			"new_text": map[string]any{"type": "string", "description": "Replacement text"},
		}, "path", "old_text", "new_text"),
	}
}

func (*EditFile) Effect() Effect { return EffectWrite }

func (*EditFile) Preview(arguments string) string {
	var args struct {
		Path    string `json:"path"`
		OldText string `json:"old_text"`
		NewText string `json:"new_text"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return "edit file"
	}
	return fmt.Sprintf("edit %s (-%d +%d bytes)", args.Path, len(args.OldText), len(args.NewText))
}

func (t *EditFile) Execute(ctx context.Context, arguments string) Result {
	if err := ctx.Err(); err != nil {
		return Failure("edit cancelled: "+err.Error(), map[string]any{"kind": "cancelled"})
	}
	var args struct {
		Path    string `json:"path"`
		OldText string `json:"old_text"`
		NewText string `json:"new_text"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return Failure("invalid edit_file arguments: "+err.Error(), map[string]any{"kind": "invalid_arguments"})
	}
	if args.OldText == "" {
		return Failure("old_text must not be empty", map[string]any{"kind": "invalid_arguments"})
	}
	if len(args.OldText)+len(args.NewText) > maxFileWriteBytes {
		return Failure("edit text exceeds the size limit", map[string]any{"kind": "limit_exceeded"})
	}

	path, err := t.workspace.ResolveExisting(args.Path)
	if err != nil {
		return Failure("cannot resolve file: "+err.Error(), map[string]any{"kind": "path_error"})
	}
	info, err := os.Stat(path)
	if err != nil {
		return Failure("cannot stat file: "+err.Error(), map[string]any{"kind": "io_error"})
	}
	if !info.Mode().IsRegular() {
		return Failure("path is not a regular file", map[string]any{"kind": "invalid_file_type"})
	}
	if info.Size() > int64(maxFileWriteBytes) {
		return Failure("file exceeds the editable size limit", map[string]any{"kind": "limit_exceeded"})
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return Failure("cannot read file: "+err.Error(), map[string]any{"kind": "io_error"})
	}
	if !utf8.Valid(content) {
		return Failure("file is not valid UTF-8", map[string]any{"kind": "invalid_encoding"})
	}
	count := strings.Count(string(content), args.OldText)
	if count == 0 {
		return Failure("old_text was not found; read the file again before editing", map[string]any{"kind": "stale_edit"})
	}
	if count > 1 {
		return Failure(fmt.Sprintf("old_text occurs %d times; include more context", count), map[string]any{"kind": "ambiguous_edit", "matches": count})
	}

	updated := strings.Replace(string(content), args.OldText, args.NewText, 1)
	if len(updated) > maxFileWriteBytes {
		return Failure("edited file exceeds the size limit", map[string]any{"kind": "limit_exceeded"})
	}
	if err := ctx.Err(); err != nil {
		return Failure("edit cancelled: "+err.Error(), map[string]any{"kind": "cancelled"})
	}
	if err := writeFileAtomic(path, []byte(updated), info.Mode(), true); err != nil {
		return Failure("cannot edit file: "+err.Error(), map[string]any{"kind": "io_error"})
	}
	return Success(fmt.Sprintf("updated %s", t.workspace.Relative(path)), map[string]any{
		"path":         t.workspace.Relative(path),
		"bytes_before": len(content),
		"bytes_after":  len(updated),
	})
}
