package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceRejectsEscapes(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideFile, filepath.Join(root, "file-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "dir-link")); err != nil {
		t.Fatal(err)
	}

	workspace, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		resolve func() (string, error)
	}{
		{
			name: "parent traversal",
			resolve: func() (string, error) {
				return workspace.ResolveExisting("../outside.txt")
			},
		},
		{
			name: "absolute path",
			resolve: func() (string, error) {
				return workspace.ResolveExisting(outsideFile)
			},
		},
		{
			name: "existing symlink",
			resolve: func() (string, error) {
				return workspace.ResolveExisting("file-link")
			},
		},
		{
			name: "write through symlinked parent",
			resolve: func() (string, error) {
				return workspace.ResolveForWrite("dir-link/new.txt")
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := test.resolve()
			if !errors.Is(err, ErrOutsideRoot) {
				t.Fatalf("expected ErrOutsideRoot, got %v", err)
			}
		})
	}
}

func TestWorkspaceResolvesPathsInsideRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(root, "nested", "existing.txt")
	if err := os.WriteFile(existing, []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}

	workspace, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	resolvedExisting, err := workspace.ResolveExisting("nested/existing.txt")
	if err != nil {
		t.Fatalf("resolve existing path: %v", err)
	}
	wantExisting := filepath.Join(workspace.Root(), "nested", "existing.txt")
	if resolvedExisting != wantExisting {
		t.Fatalf("resolved existing path = %q, want %q", resolvedExisting, wantExisting)
	}

	resolvedNew, err := workspace.ResolveForWrite("nested/more/new.txt")
	if err != nil {
		t.Fatalf("resolve new path: %v", err)
	}
	wantNew := filepath.Join(workspace.Root(), "nested", "more", "new.txt")
	if resolvedNew != wantNew {
		t.Fatalf("resolved new path = %q, want %q", resolvedNew, wantNew)
	}
}
