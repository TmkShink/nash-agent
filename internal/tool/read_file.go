package tool

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/TmkShink/nash-agent/internal/core"
	"github.com/TmkShink/nash-agent/internal/workspace"
)

const (
	defaultReadLines = 200
	maxReadLines     = 500
	maxReadBytes     = 64 * 1024
)

type ReadFile struct {
	workspace *workspace.Workspace
}

func NewReadFile(workspace *workspace.Workspace) *ReadFile {
	return &ReadFile{workspace: workspace}
}

func (t *ReadFile) Definition() core.ToolDefinition {
	return core.ToolDefinition{
		Name:        "read_file",
		Description: "Read a bounded line range from a UTF-8 text file inside the workspace. Lines are returned with line numbers.",
		InputSchema: objectSchema(map[string]any{
			"path":       map[string]any{"type": "string", "description": "Workspace-relative file path"},
			"start_line": map[string]any{"type": "integer", "minimum": 1, "description": "First line to return, default 1"},
			"end_line":   map[string]any{"type": "integer", "minimum": 1, "description": "Last line to return, inclusive"},
		}, "path"),
	}
}

func (*ReadFile) Effect() Effect { return EffectRead }

func (*ReadFile) Preview(arguments string) string {
	var args struct {
		Path string `json:"path"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return "read file"
	}
	return "read " + args.Path
}

func (t *ReadFile) Execute(ctx context.Context, arguments string) Result {
	if err := ctx.Err(); err != nil {
		return Failure("read cancelled: "+err.Error(), map[string]any{"kind": "cancelled"})
	}
	var args struct {
		Path      string `json:"path"`
		StartLine int    `json:"start_line"`
		EndLine   int    `json:"end_line"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return Failure("invalid read_file arguments: "+err.Error(), map[string]any{"kind": "invalid_arguments"})
	}
	if args.StartLine == 0 {
		args.StartLine = 1
	}
	if args.EndLine == 0 {
		args.EndLine = args.StartLine + defaultReadLines - 1
	}
	if args.StartLine < 1 || args.EndLine < args.StartLine {
		return Failure("start_line and end_line must describe a positive line range", map[string]any{"kind": "invalid_arguments"})
	}
	if args.EndLine-args.StartLine+1 > maxReadLines {
		return Failure(fmt.Sprintf("read range exceeds the %d line limit", maxReadLines), map[string]any{"kind": "limit_exceeded"})
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

	file, err := os.Open(path)
	if err != nil {
		return Failure("cannot open file: "+err.Error(), map[string]any{"kind": "io_error"})
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var output strings.Builder
	lineNumber := 0
	returned := 0
	truncated := false
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return Failure("read cancelled: "+err.Error(), map[string]any{"kind": "cancelled"})
		}
		if !utf8.Valid(scanner.Bytes()) {
			return Failure("file is not valid UTF-8", map[string]any{"kind": "invalid_encoding"})
		}
		lineNumber++
		if lineNumber < args.StartLine {
			continue
		}
		if lineNumber > args.EndLine {
			break
		}
		line := scanner.Text()
		if strings.IndexByte(line, 0) >= 0 {
			return Failure("file appears to be binary", map[string]any{"kind": "binary_file"})
		}
		formatted := fmt.Sprintf("%6d | %s\n", lineNumber, line)
		if output.Len()+len(formatted) > maxReadBytes {
			truncated = true
			break
		}
		output.WriteString(formatted)
		returned++
	}
	if err := scanner.Err(); err != nil {
		return Failure("cannot read file: "+err.Error(), map[string]any{"kind": "io_error"})
	}
	if output.Len() == 0 {
		output.WriteString("(no lines in requested range)\n")
	}
	if truncated {
		output.WriteString("... output truncated by byte limit ...\n")
	}

	return Success(output.String(), map[string]any{
		"path":           t.workspace.Relative(path),
		"start_line":     args.StartLine,
		"lines_returned": returned,
		"truncated":      truncated,
	})
}
