package trace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

const SchemaVersion = 1

type Event struct {
	Version   int             `json:"version"`
	SessionID string          `json:"session_id"`
	Sequence  uint64          `json:"sequence"`
	Time      time.Time       `json:"time"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
}

type Sink interface {
	WriteEvent(ctx context.Context, event Event) error
	Close() error
}

type Emitter interface {
	Emit(ctx context.Context, eventType string, data any) error
}

type Bus struct {
	mu        sync.Mutex
	sessionID string
	sequence  uint64
	now       func() time.Time
	sinks     []Sink
	closed    bool
}

func NewBus(sessionID string, sinks ...Sink) (*Bus, error) {
	if sessionID == "" {
		return nil, errors.New("session ID is empty")
	}
	for _, sink := range sinks {
		if sink == nil {
			return nil, errors.New("event sink is nil")
		}
	}
	return &Bus{sessionID: sessionID, now: time.Now, sinks: sinks}, nil
}

func (b *Bus) Emit(ctx context.Context, eventType string, data any) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return errors.New("event bus is closed")
	}
	if eventType == "" {
		return errors.New("event type is empty")
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal event %s: %w", eventType, err)
	}
	b.sequence++
	event := Event{
		Version:   SchemaVersion,
		SessionID: b.sessionID,
		Sequence:  b.sequence,
		Time:      b.now().UTC(),
		Type:      eventType,
		Data:      payload,
	}
	for _, sink := range b.sinks {
		if err := sink.WriteEvent(ctx, event); err != nil {
			return fmt.Errorf("write event %s to sink: %w", eventType, err)
		}
	}
	return nil
}

func (b *Bus) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil
	}
	b.closed = true
	var joined error
	for _, sink := range b.sinks {
		joined = errors.Join(joined, sink.Close())
	}
	return joined
}

func NewSessionID() (string, error) {
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate session suffix: %w", err)
	}
	return time.Now().UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(random), nil
}
