package trace

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestBusWritesOrderedParseableJSONL(t *testing.T) {
	directory := t.TempDir()
	sink, err := OpenFileSink(directory, "ordered-session")
	if err != nil {
		t.Fatal(err)
	}
	path := sink.Path()
	bus, err := NewBus("ordered-session", sink)
	if err != nil {
		t.Fatal(err)
	}

	const events = 24
	var wait sync.WaitGroup
	wait.Add(events)
	for index := range events {
		go func() {
			defer wait.Done()
			if err := bus.Emit(context.Background(), "probe", map[string]int{"index": index}); err != nil {
				t.Errorf("emit: %v", err)
			}
		}()
	}
	wait.Wait()
	if err := bus.Close(); err != nil {
		t.Fatal(err)
	}

	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	count := 0
	for scanner.Scan() {
		count++
		var event Event
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatalf("line %d is not valid JSON: %v", count, err)
		}
		if event.Version != SchemaVersion {
			t.Fatalf("line %d version = %d, want %d", count, event.Version, SchemaVersion)
		}
		if event.SessionID != "ordered-session" {
			t.Fatalf("line %d session = %q", count, event.SessionID)
		}
		if event.Sequence != uint64(count) {
			t.Fatalf("line %d sequence = %d", count, event.Sequence)
		}
		if event.Type != "probe" || len(event.Data) == 0 || event.Time.IsZero() {
			t.Fatalf("line %d has incomplete event: %#v", count, event)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if count != events {
		t.Fatalf("event count = %d, want %d", count, events)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("trace permissions = %o, want 600", got)
	}
}

func TestOpenFileSinkRejectsInvalidOrDuplicateSession(t *testing.T) {
	directory := t.TempDir()
	invalid := []string{"", "../escape", "has/slash", "-leading", "has space", strings.Repeat("a", 129)}
	for _, sessionID := range invalid {
		t.Run("invalid_"+sessionID, func(t *testing.T) {
			if sink, err := OpenFileSink(directory, sessionID); err == nil {
				sink.Close()
				t.Fatalf("expected invalid session ID %q to fail", sessionID)
			}
		})
	}

	sink, err := OpenFileSink(directory, "duplicate")
	if err != nil {
		t.Fatal(err)
	}
	if err := sink.Close(); err != nil {
		t.Fatal(err)
	}
	if duplicate, err := OpenFileSink(directory, "duplicate"); err == nil {
		duplicate.Close()
		t.Fatal("expected reopening the same session to fail")
	}
}

func TestNewSessionIDProducesFileSafeID(t *testing.T) {
	first, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("session IDs unexpectedly match: %q", first)
	}
	if !sessionIDPattern.MatchString(first) || !sessionIDPattern.MatchString(second) {
		t.Fatalf("session IDs are not file safe: %q, %q", first, second)
	}
}
