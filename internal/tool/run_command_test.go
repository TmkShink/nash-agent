package tool

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestRunCommandUsesWorkspaceAndReportsNonzeroExit(t *testing.T) {
	current, root := newTestWorkspace(t)
	runner := NewRunCommand(current)

	cwd := runner.Execute(context.Background(), `{"command":"pwd"}`)
	if cwd.IsError {
		t.Fatalf("pwd failed: %#v", cwd)
	}
	if !strings.Contains(cwd.Content, root) {
		t.Fatalf("command output %q does not contain workspace %q", cwd.Content, root)
	}

	failed := runner.Execute(context.Background(), `{"command":"printf boom; exit 7"}`)
	if !failed.IsError {
		t.Fatalf("expected nonzero exit result, got %#v", failed)
	}
	if got, ok := failed.Metadata["exit_code"].(int); !ok || got != 7 {
		t.Fatalf("exit code = %#v, want 7", failed.Metadata["exit_code"])
	}
	if got := resultKind(t, failed); got != "command_failed" {
		t.Fatalf("failure kind = %q, want command_failed", got)
	}
	if !strings.Contains(failed.Content, "boom") {
		t.Fatalf("missing command output: %q", failed.Content)
	}
}

func TestRunCommandTimesOut(t *testing.T) {
	current, _ := newTestWorkspace(t)
	runner := NewRunCommand(current)

	result := runner.Execute(context.Background(), `{"command":"sleep 2","timeout_seconds":1}`)
	if !result.IsError || resultKind(t, result) != "timeout" {
		t.Fatalf("expected timeout result, got %#v", result)
	}
}

func TestRunCommandStripsSensitiveEnvironment(t *testing.T) {
	t.Setenv("NASH_TEST_API_KEY", "do-not-leak")
	t.Setenv("NASH_TEST_TOKEN", "do-not-leak-either")
	t.Setenv("NASH_SAFE_VALUE", "visible")
	current, _ := newTestWorkspace(t)
	runner := NewRunCommand(current)

	command := `printf '%s|%s|%s|%s' "${NASH_TEST_API_KEY-unset}" "${NASH_TEST_TOKEN-unset}" "${NASH_SAFE_VALUE-unset}" "${NASH_AGENT-unset}"`
	result := runner.Execute(context.Background(), fmt.Sprintf(`{"command":%q}`, command))
	if result.IsError {
		t.Fatalf("environment probe failed: %#v", result)
	}
	if !strings.Contains(result.Content, "unset|unset|visible|1") {
		t.Fatalf("unexpected sanitized environment: %q", result.Content)
	}
	if strings.Contains(result.Content, "do-not-leak") {
		t.Fatalf("sensitive value leaked in output: %q", result.Content)
	}
}

func TestRunCommandTruncatesOutput(t *testing.T) {
	current, _ := newTestWorkspace(t)
	runner := NewRunCommand(current)

	command := `awk 'BEGIN { for (i=0; i<70000; i++) printf "x" }'`
	result := runner.Execute(context.Background(), fmt.Sprintf(`{"command":%q}`, command))
	if result.IsError {
		t.Fatalf("large output command failed: %#v", result)
	}
	if truncated, ok := result.Metadata["truncated"].(bool); !ok || !truncated {
		t.Fatalf("expected truncation metadata, got %#v", result.Metadata)
	}
	if bytes, ok := result.Metadata["output_bytes"].(int64); !ok || bytes != 70000 {
		t.Fatalf("output bytes = %#v, want 70000", result.Metadata["output_bytes"])
	}
	if !strings.Contains(result.Content, "bytes omitted") {
		t.Fatalf("missing truncation marker in output")
	}
}
