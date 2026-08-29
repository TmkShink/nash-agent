package trace

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

type FileSink struct {
	mu      sync.Mutex
	path    string
	file    *os.File
	buffer  *bufio.Writer
	encoder *json.Encoder
	closed  bool
}

var sessionIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

func OpenFileSink(directory, sessionID string) (*FileSink, error) {
	if !sessionIDPattern.MatchString(sessionID) {
		return nil, fmt.Errorf("invalid session ID %q", sessionID)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create session directory: %w", err)
	}
	path := filepath.Join(directory, sessionID+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create session trace: %w", err)
	}
	buffer := bufio.NewWriter(file)
	return &FileSink{
		path:    path,
		file:    file,
		buffer:  buffer,
		encoder: json.NewEncoder(buffer),
	}, nil
}

func (s *FileSink) Path() string {
	return s.path
}

func (s *FileSink) WriteEvent(ctx context.Context, event Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("trace file is closed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.encoder.Encode(event); err != nil {
		return err
	}
	if err := s.buffer.Flush(); err != nil {
		return err
	}
	return s.file.Sync()
}

func (s *FileSink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	flushErr := s.buffer.Flush()
	closeErr := s.file.Close()
	if flushErr != nil {
		return flushErr
	}
	return closeErr
}
