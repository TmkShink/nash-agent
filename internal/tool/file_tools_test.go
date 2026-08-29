package tool

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadFileRangeAndLimits(t *testing.T) {
	current, root := newTestWorkspace(t)
	writeFixture(t, root, "lines.txt", "one\ntwo\nthree\nfour\n")
	reader := NewReadFile(current)

	result := reader.Execute(context.Background(), `{"path":"lines.txt","start_line":2,"end_line":3}`)
	if result.IsError {
		t.Fatalf("read range failed: %#v", result)
	}
	if !strings.Contains(result.Content, "     2 | two\n") || !strings.Contains(result.Content, "     3 | three\n") {
		t.Fatalf("unexpected ranged output: %q", result.Content)
	}
	if strings.Contains(result.Content, "one") || strings.Contains(result.Content, "four") {
		t.Fatalf("output escaped requested range: %q", result.Content)
	}

	tooMany := reader.Execute(context.Background(), `{"path":"lines.txt","start_line":1,"end_line":501}`)
	if !tooMany.IsError || resultKind(t, tooMany) != "limit_exceeded" {
		t.Fatalf("expected line limit error, got %#v", tooMany)
	}

	longLine := strings.Repeat("x", 1000)
	writeFixture(t, root, "large.txt", strings.Repeat(longLine+"\n", 100))
	large := reader.Execute(context.Background(), `{"path":"large.txt","start_line":1,"end_line":100}`)
	if large.IsError {
		t.Fatalf("large bounded read failed: %#v", large)
	}
	if truncated, ok := large.Metadata["truncated"].(bool); !ok || !truncated {
		t.Fatalf("expected byte truncation metadata, got %#v", large.Metadata)
	}
	if !strings.Contains(large.Content, "output truncated by byte limit") {
		t.Fatalf("missing truncation marker: %q", large.Content[len(large.Content)-100:])
	}
}

func TestReadFileRejectsInvalidUTF8(t *testing.T) {
	current, root := newTestWorkspace(t)
	path := filepath.Join(root, "invalid.txt")
	if err := os.WriteFile(path, []byte{0xff, 0xfe, 'a', '\n'}, 0o600); err != nil {
		t.Fatal(err)
	}

	result := NewReadFile(current).Execute(context.Background(), `{"path":"invalid.txt"}`)
	if !result.IsError || resultKind(t, result) != "invalid_encoding" {
		t.Fatalf("expected invalid_encoding result, got %#v", result)
	}
}

func TestListFilesDepthAndEntryLimits(t *testing.T) {
	current, root := newTestWorkspace(t)
	writeFixture(t, root, "a.txt", "a")
	writeFixture(t, root, "b.txt", "b")
	writeFixture(t, root, "nested/child.txt", "child")
	writeFixture(t, root, ".git/hidden", "hidden")
	lister := NewListFiles(current)

	depthOne := lister.Execute(context.Background(), `{"path":".","max_depth":1,"max_entries":20}`)
	if depthOne.IsError {
		t.Fatalf("list depth one failed: %#v", depthOne)
	}
	if !strings.Contains(depthOne.Content, "nested/\n") {
		t.Fatalf("missing first-level directory: %q", depthOne.Content)
	}
	if strings.Contains(depthOne.Content, "nested/child.txt") || strings.Contains(depthOne.Content, ".git") {
		t.Fatalf("listing exceeded depth or included ignored directory: %q", depthOne.Content)
	}

	entryLimited := lister.Execute(context.Background(), `{"path":".","max_depth":2,"max_entries":2}`)
	if entryLimited.IsError {
		t.Fatalf("entry-limited list failed: %#v", entryLimited)
	}
	if truncated, ok := entryLimited.Metadata["truncated"].(bool); !ok || !truncated {
		t.Fatalf("expected entry truncation metadata, got %#v", entryLimited.Metadata)
	}
	if !strings.Contains(entryLimited.Content, "listing truncated after 2 entries") {
		t.Fatalf("missing entry truncation marker: %q", entryLimited.Content)
	}

	regularFile := lister.Execute(context.Background(), `{"path":"a.txt"}`)
	if !regularFile.IsError || resultKind(t, regularFile) != "invalid_file_type" {
		t.Fatalf("expected regular file path to fail, got %#v", regularFile)
	}

	for _, arguments := range []string{
		`{"max_depth":6}`,
		`{"max_entries":501}`,
	} {
		result := lister.Execute(context.Background(), arguments)
		if !result.IsError || resultKind(t, result) != "invalid_arguments" {
			t.Fatalf("arguments %s: expected invalid argument result, got %#v", arguments, result)
		}
	}
}

func TestWriteFileOverwriteGatePreservesExistingFile(t *testing.T) {
	current, root := newTestWorkspace(t)
	path := writeFixture(t, root, "existing.txt", "original")
	writer := NewWriteFile(current)

	tests := []struct {
		name      string
		arguments string
		wantKind  string
	}{
		{
			name:      "overwrite not allowed",
			arguments: `{"path":"existing.txt","content":"replacement"}`,
			wantKind:  "already_exists",
		},
		{
			name:      "oversized replacement",
			arguments: `{"path":"existing.txt","content":"` + strings.Repeat("x", maxFileWriteBytes+1) + `","overwrite":true}`,
			wantKind:  "limit_exceeded",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := writer.Execute(context.Background(), test.arguments)
			if !result.IsError || resultKind(t, result) != test.wantKind {
				t.Fatalf("expected %s error, got %#v", test.wantKind, result)
			}
			content, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(content) != "original" {
				t.Fatalf("failed write changed existing content to %q", content)
			}
		})
	}

	result := writer.Execute(context.Background(), `{"path":"existing.txt","content":"replacement","overwrite":true}`)
	if result.IsError {
		t.Fatalf("overwrite failed: %#v", result)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "replacement" {
		t.Fatalf("overwritten content = %q", content)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("overwritten mode = %o, want 600", got)
	}

	created := writer.Execute(context.Background(), `{"path":"new/nested.txt","content":"new"}`)
	if created.IsError {
		t.Fatalf("create nested file failed: %#v", created)
	}
	if content, err := os.ReadFile(filepath.Join(root, "new", "nested.txt")); err != nil || string(content) != "new" {
		t.Fatalf("created content = %q, err = %v", content, err)
	}
}

func TestEditFileRequiresUniqueFreshContext(t *testing.T) {
	tests := []struct {
		name        string
		initial     string
		oldText     string
		newText     string
		wantContent string
		wantKind    string
	}{
		{
			name:        "success",
			initial:     "alpha beta gamma",
			oldText:     "beta",
			newText:     "BETA",
			wantContent: "alpha BETA gamma",
		},
		{
			name:        "missing stale context",
			initial:     "alpha beta gamma",
			oldText:     "delta",
			newText:     "DELTA",
			wantContent: "alpha beta gamma",
			wantKind:    "stale_edit",
		},
		{
			name:        "ambiguous context",
			initial:     "same and same",
			oldText:     "same",
			newText:     "changed",
			wantContent: "same and same",
			wantKind:    "ambiguous_edit",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			current, root := newTestWorkspace(t)
			path := writeFixture(t, root, "edit.txt", test.initial)
			editor := NewEditFile(current)
			arguments := `{"path":"edit.txt","old_text":` + quoteJSON(test.oldText) + `,"new_text":` + quoteJSON(test.newText) + `}`
			result := editor.Execute(context.Background(), arguments)
			if test.wantKind == "" {
				if result.IsError {
					t.Fatalf("edit failed: %#v", result)
				}
			} else if !result.IsError || resultKind(t, result) != test.wantKind {
				t.Fatalf("expected %s error, got %#v", test.wantKind, result)
			}
			content, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(content) != test.wantContent {
				t.Fatalf("file content = %q, want %q", content, test.wantContent)
			}
		})
	}
}

func TestEditFileRejectsResultLargerThanLimit(t *testing.T) {
	current, root := newTestWorkspace(t)
	initial := strings.Repeat("a", maxFileWriteBytes-1) + "Z"
	path := writeFixture(t, root, "near-limit.txt", initial)

	result := NewEditFile(current).Execute(context.Background(), `{"path":"near-limit.txt","old_text":"Z","new_text":"ZZ"}`)
	if !result.IsError || resultKind(t, result) != "limit_exceeded" {
		t.Fatalf("expected replacement size limit error, got %#v", result)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != initial {
		t.Fatal("oversized edit changed the original file")
	}
}

func TestEditFileRejectsInvalidUTF8WithoutChangingFile(t *testing.T) {
	current, root := newTestWorkspace(t)
	initial := []byte{0xff, 0xfe, 'a', '\n'}
	path := filepath.Join(root, "invalid.txt")
	if err := os.WriteFile(path, initial, 0o600); err != nil {
		t.Fatal(err)
	}

	result := NewEditFile(current).Execute(context.Background(), `{"path":"invalid.txt","old_text":"a","new_text":"b"}`)
	if !result.IsError || resultKind(t, result) != "invalid_encoding" {
		t.Fatalf("expected invalid_encoding result, got %#v", result)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(initial) {
		t.Fatalf("invalid UTF-8 edit changed bytes from %v to %v", initial, content)
	}
}

func quoteJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
