package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	"github.com/TmkShink/nash-agent/internal/core"
)

type Effect string

const (
	EffectRead    Effect = "read"
	EffectWrite   Effect = "write"
	EffectExecute Effect = "execute"
)

type Result struct {
	Content  string         `json:"content"`
	IsError  bool           `json:"is_error"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

func Success(content string, metadata map[string]any) Result {
	return Result{Content: content, Metadata: metadata}
}

func Failure(content string, metadata map[string]any) Result {
	return Result{Content: content, IsError: true, Metadata: metadata}
}

type Tool interface {
	Definition() core.ToolDefinition
	Effect() Effect
	Preview(arguments string) string
	Execute(ctx context.Context, arguments string) Result
}

type ApprovalRequest struct {
	ToolName string
	Effect   Effect
	Preview  string
}

type Approver interface {
	Approve(ctx context.Context, request ApprovalRequest) (bool, error)
}

type AllowAll struct{}

func (AllowAll) Approve(context.Context, ApprovalRequest) (bool, error) {
	return true, nil
}

type ReadOnly struct{}

func (ReadOnly) Approve(_ context.Context, request ApprovalRequest) (bool, error) {
	return request.Effect == EffectRead, nil
}

type Registry struct {
	tools map[string]Tool
}

var toolNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func NewRegistry(tools ...Tool) (*Registry, error) {
	r := &Registry{tools: make(map[string]Tool, len(tools))}
	for _, current := range tools {
		if current == nil {
			return nil, errors.New("register nil tool")
		}
		definition := current.Definition()
		if !toolNamePattern.MatchString(definition.Name) {
			return nil, fmt.Errorf("invalid tool name %q", definition.Name)
		}
		if strings.TrimSpace(definition.Description) == "" {
			return nil, fmt.Errorf("tool %q has no description", definition.Name)
		}
		if definition.InputSchema == nil {
			return nil, fmt.Errorf("tool %q has no input schema", definition.Name)
		}
		if _, exists := r.tools[definition.Name]; exists {
			return nil, fmt.Errorf("duplicate tool %q", definition.Name)
		}
		r.tools[definition.Name] = current
	}
	return r, nil
}

func (r *Registry) Definitions() []core.ToolDefinition {
	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		names = append(names, name)
	}
	sort.Strings(names)

	definitions := make([]core.ToolDefinition, 0, len(names))
	for _, name := range names {
		definitions = append(definitions, r.tools[name].Definition())
	}
	return definitions
}

func (r *Registry) Execute(ctx context.Context, call core.ToolCall, approver Approver) Result {
	current, ok := r.tools[call.Name]
	if !ok {
		return Failure(fmt.Sprintf("unknown tool %q", call.Name), map[string]any{"kind": "unknown_tool"})
	}
	if approver == nil {
		return Failure("tool approval policy is unavailable", map[string]any{"kind": "approval_error"})
	}
	if !json.Valid([]byte(call.Arguments)) {
		return Failure("tool arguments are not valid JSON", map[string]any{"kind": "invalid_arguments"})
	}

	allowed, err := approver.Approve(ctx, ApprovalRequest{
		ToolName: call.Name,
		Effect:   current.Effect(),
		Preview:  current.Preview(call.Arguments),
	})
	if err != nil {
		return Failure("tool approval failed: "+err.Error(), map[string]any{"kind": "approval_error"})
	}
	if !allowed {
		return Failure("tool call was denied by the approval policy", map[string]any{"kind": "denied"})
	}

	result := current.Execute(ctx, call.Arguments)
	if strings.TrimSpace(result.Content) == "" {
		result.Content = "tool returned no content"
	}
	return result
}

func DecodeArguments(raw string, destination any) error {
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func objectSchema(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}
