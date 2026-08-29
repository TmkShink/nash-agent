package tool

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TmkShink/nash-agent/internal/workspace"
)

func newTestWorkspace(t *testing.T) (*workspace.Workspace, string) {
	t.Helper()
	root := t.TempDir()
	current, err := workspace.New(root)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	return current, root
}

func writeFixture(t *testing.T, root, name, content string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create fixture directory: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func resultKind(t *testing.T, result Result) string {
	t.Helper()
	kind, ok := result.Metadata["kind"].(string)
	if !ok {
		t.Fatalf("result metadata has no string kind: %#v", result.Metadata)
	}
	return kind
}
