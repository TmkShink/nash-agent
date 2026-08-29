package tool

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/TmkShink/nash-agent/internal/core"
	"github.com/TmkShink/nash-agent/internal/workspace"
)

var errEntryLimit = errors.New("entry limit reached")

type ListFiles struct {
	workspace *workspace.Workspace
}

func NewListFiles(workspace *workspace.Workspace) *ListFiles {
	return &ListFiles{workspace: workspace}
}

func (t *ListFiles) Definition() core.ToolDefinition {
	return core.ToolDefinition{
		Name:        "list_files",
		Description: "List files and directories under a workspace-relative directory without following symlinked directories.",
		InputSchema: objectSchema(map[string]any{
			"path":        map[string]any{"type": "string", "description": "Directory to list, default ."},
			"max_depth":   map[string]any{"type": "integer", "minimum": 1, "maximum": 5, "description": "Maximum recursive depth, default 2"},
			"max_entries": map[string]any{"type": "integer", "minimum": 1, "maximum": 500, "description": "Maximum entries, default 200"},
		}),
	}
}

func (*ListFiles) Effect() Effect { return EffectRead }

func (*ListFiles) Preview(arguments string) string {
	var args struct {
		Path string `json:"path"`
	}
	if err := DecodeArguments(arguments, &args); err != nil || args.Path == "" {
		return "list ."
	}
	return "list " + args.Path
}

func (t *ListFiles) Execute(ctx context.Context, arguments string) Result {
	var args struct {
		Path       string `json:"path"`
		MaxDepth   int    `json:"max_depth"`
		MaxEntries int    `json:"max_entries"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return Failure("invalid list_files arguments: "+err.Error(), map[string]any{"kind": "invalid_arguments"})
	}
	if args.Path == "" {
		args.Path = "."
	}
	if args.MaxDepth == 0 {
		args.MaxDepth = 2
	}
	if args.MaxEntries == 0 {
		args.MaxEntries = 200
	}
	if args.MaxDepth < 1 || args.MaxDepth > 5 || args.MaxEntries < 1 || args.MaxEntries > 500 {
		return Failure("max_depth must be 1..5 and max_entries must be 1..500", map[string]any{"kind": "invalid_arguments"})
	}

	root, err := t.workspace.ResolveExisting(args.Path)
	if err != nil {
		return Failure("cannot resolve directory: "+err.Error(), map[string]any{"kind": "path_error"})
	}
	info, err := os.Stat(root)
	if err != nil {
		return Failure("cannot stat directory: "+err.Error(), map[string]any{"kind": "io_error"})
	}
	if !info.IsDir() {
		return Failure("path is not a directory", map[string]any{"kind": "invalid_file_type"})
	}
	var output strings.Builder
	entries := 0
	truncated := false
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == root {
			return nil
		}

		relFromRoot, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		depth := strings.Count(filepath.ToSlash(relFromRoot), "/") + 1
		if depth > args.MaxDepth {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() && (entry.Name() == ".git" || entry.Name() == ".nash") {
			return filepath.SkipDir
		}
		if entries >= args.MaxEntries {
			truncated = true
			return errEntryLimit
		}

		display := t.workspace.Relative(path)
		if entry.IsDir() {
			display += "/"
		} else if entry.Type()&fs.ModeSymlink != 0 {
			display += "@"
		}
		output.WriteString(display)
		output.WriteByte('\n')
		entries++
		return nil
	})
	if err != nil && !errors.Is(err, errEntryLimit) {
		return Failure("cannot list directory: "+err.Error(), map[string]any{"kind": "io_error"})
	}
	if entries == 0 {
		output.WriteString("(directory is empty)\n")
	}
	if truncated {
		output.WriteString(fmt.Sprintf("... listing truncated after %d entries ...\n", entries))
	}
	return Success(output.String(), map[string]any{"entries": entries, "truncated": truncated})
}
