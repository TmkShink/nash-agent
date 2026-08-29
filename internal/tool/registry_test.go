package tool

import (
	"context"
	"testing"

	"github.com/TmkShink/nash-agent/internal/core"
)

type stubTool struct {
	executed bool
}

func (*stubTool) Definition() core.ToolDefinition {
	return core.ToolDefinition{
		Name:        "probe",
		Description: "Test probe",
		InputSchema: objectSchema(map[string]any{}),
	}
}

func (*stubTool) Effect() Effect { return EffectWrite }

func (*stubTool) Preview(string) string { return "probe" }

func (s *stubTool) Execute(context.Context, string) Result {
	s.executed = true
	return Success("executed", nil)
}

type approverFunc func(context.Context, ApprovalRequest) (bool, error)

func (f approverFunc) Approve(ctx context.Context, request ApprovalRequest) (bool, error) {
	return f(ctx, request)
}

func TestRegistryReturnsRecoverableDispatchErrors(t *testing.T) {
	tests := []struct {
		name     string
		call     core.ToolCall
		approver Approver
		wantKind string
	}{
		{
			name:     "unknown tool",
			call:     core.ToolCall{Name: "missing", Arguments: `{}`},
			approver: AllowAll{},
			wantKind: "unknown_tool",
		},
		{
			name:     "malformed JSON",
			call:     core.ToolCall{Name: "probe", Arguments: `{`},
			approver: AllowAll{},
			wantKind: "invalid_arguments",
		},
		{
			name: "approval denied",
			call: core.ToolCall{Name: "probe", Arguments: `{}`},
			approver: approverFunc(func(context.Context, ApprovalRequest) (bool, error) {
				return false, nil
			}),
			wantKind: "denied",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := &stubTool{}
			registry, err := NewRegistry(probe)
			if err != nil {
				t.Fatal(err)
			}
			result := registry.Execute(context.Background(), test.call, test.approver)
			if !result.IsError {
				t.Fatalf("expected tool error, got %#v", result)
			}
			if got := resultKind(t, result); got != test.wantKind {
				t.Fatalf("error kind = %q, want %q", got, test.wantKind)
			}
			if probe.executed {
				t.Fatal("tool executed after dispatch failure")
			}
		})
	}
}

func TestRegistryRejectsUnknownArgumentFields(t *testing.T) {
	current, _ := newTestWorkspace(t)
	registry, err := NewRegistry(NewReadFile(current))
	if err != nil {
		t.Fatal(err)
	}

	result := registry.Execute(context.Background(), core.ToolCall{
		Name:      "read_file",
		Arguments: `{"path":"file.txt","unexpected":true}`,
	}, AllowAll{})
	if !result.IsError {
		t.Fatalf("expected unknown field error, got %#v", result)
	}
	if got := resultKind(t, result); got != "invalid_arguments" {
		t.Fatalf("error kind = %q, want invalid_arguments", got)
	}
}
