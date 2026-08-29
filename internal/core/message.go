package core

// Role identifies the sender of a message in the model conversation.
type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// ToolCall is a provider-neutral request from the model to a local tool.
// Arguments keeps the original JSON string so malformed model output can be
// returned as a tool error instead of failing provider response decoding.
type ToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Message is the normalized conversation format used by the agent loop.
type Message struct {
	Role       Role       `json:"role"`
	Content    string     `json:"content,omitempty"`
	Name       string     `json:"name,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

// ToolDefinition describes a local tool to a model that supports native tool
// calling.
type ToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"input_schema"`
}

// ModelRequest contains everything the model needs for one turn.
type ModelRequest struct {
	Messages []Message        `json:"messages"`
	Tools    []ToolDefinition `json:"tools"`
}

// Usage contains provider-reported token counts when available.
type Usage struct {
	InputTokens  int `json:"input_tokens,omitempty"`
	OutputTokens int `json:"output_tokens,omitempty"`
}

// ModelResponse is the provider-neutral output consumed by the agent loop.
type ModelResponse struct {
	Message      Message `json:"message"`
	FinishReason string  `json:"finish_reason,omitempty"`
	Usage        Usage   `json:"usage,omitempty"`
}
