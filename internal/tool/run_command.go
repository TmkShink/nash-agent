package tool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/TmkShink/nash-agent/internal/core"
	"github.com/TmkShink/nash-agent/internal/textlimit"
	"github.com/TmkShink/nash-agent/internal/workspace"
)

const (
	defaultCommandTimeout = 60 * time.Second
	maxCommandTimeout     = 120 * time.Second
)

type RunCommand struct {
	workspace *workspace.Workspace
}

func NewRunCommand(workspace *workspace.Workspace) *RunCommand {
	return &RunCommand{workspace: workspace}
}

func (t *RunCommand) Definition() core.ToolDefinition {
	return core.ToolDefinition{
		Name:        "run_command",
		Description: "Run a shell command in the workspace and return combined stdout/stderr, exit status, and duration. Execution is time- and output-bounded but not an OS sandbox.",
		InputSchema: objectSchema(map[string]any{
			"command":         map[string]any{"type": "string", "description": "Shell command to run"},
			"timeout_seconds": map[string]any{"type": "integer", "minimum": 1, "maximum": 120, "description": "Timeout in seconds, default 60"},
		}, "command"),
	}
}

func (*RunCommand) Effect() Effect { return EffectExecute }

func (*RunCommand) Preview(arguments string) string {
	var args struct {
		Command string `json:"command"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return "run command"
	}
	const maxPreview = 240
	preview := strings.TrimSpace(args.Command)
	if len(preview) > maxPreview {
		preview = preview[:maxPreview] + "..."
	}
	return preview
}

func (t *RunCommand) Execute(ctx context.Context, arguments string) Result {
	var args struct {
		Command        string `json:"command"`
		TimeoutSeconds int    `json:"timeout_seconds"`
	}
	if err := DecodeArguments(arguments, &args); err != nil {
		return Failure("invalid run_command arguments: "+err.Error(), map[string]any{"kind": "invalid_arguments"})
	}
	if strings.TrimSpace(args.Command) == "" {
		return Failure("command is required", map[string]any{"kind": "invalid_arguments"})
	}
	timeout := defaultCommandTimeout
	if args.TimeoutSeconds != 0 {
		timeout = time.Duration(args.TimeoutSeconds) * time.Second
	}
	if timeout <= 0 || timeout > maxCommandTimeout {
		return Failure("timeout_seconds must be between 1 and 120", map[string]any{"kind": "invalid_arguments"})
	}

	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(commandCtx, "/bin/sh", "-lc", args.Command)
	command.Dir = t.workspace.Root()
	command.Env = sanitizedEnvironment(os.Environ())
	// A killed shell can leave descendants holding stdout or stderr open. Bound
	// that pipe-drain wait even though process-tree isolation is out of scope.
	command.WaitDelay = 2 * time.Second
	output := textlimit.NewHeadTailBuffer(48*1024, 16*1024)
	command.Stdout = output
	command.Stderr = output

	started := time.Now()
	err := command.Run()
	duration := time.Since(started)
	exitCode := 0
	kind := ""
	if err != nil {
		exitCode = -1
		kind = "command_failed"
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		}
		if errors.Is(commandCtx.Err(), context.DeadlineExceeded) {
			kind = "timeout"
		}
	}

	content := output.String()
	if strings.TrimSpace(content) == "" {
		content = "(command produced no output)"
	}
	summary := fmt.Sprintf("exit=%d duration=%s\n%s", exitCode, duration.Round(time.Millisecond), content)
	metadata := map[string]any{
		"exit_code":    exitCode,
		"duration_ms":  duration.Milliseconds(),
		"output_bytes": output.TotalBytes(),
		"truncated":    output.Truncated(),
	}
	if err != nil {
		metadata["kind"] = kind
		return Failure(summary, metadata)
	}
	return Success(summary, metadata)
}

func sanitizedEnvironment(environment []string) []string {
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		key, _, found := strings.Cut(entry, "=")
		if !found || sensitiveEnvironmentKey(key) {
			continue
		}
		result = append(result, entry)
	}
	return append(result, "NASH_AGENT=1")
}

func sensitiveEnvironmentKey(key string) bool {
	upper := strings.ToUpper(key)
	if upper == "SSH_AUTH_SOCK" || upper == "GIT_ASKPASS" || upper == "NASH_API_KEY" {
		return true
	}
	for _, fragment := range []string{"API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"} {
		if strings.Contains(upper, fragment) {
			return true
		}
	}
	return false
}
