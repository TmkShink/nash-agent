package textlimit

import (
	"strings"
	"sync"
	"testing"
)

func TestHeadTailBuffer(t *testing.T) {
	tests := []struct {
		name      string
		headLimit int
		tailLimit int
		writes    []string
		want      string
		wantTotal int64
		truncated bool
	}{
		{
			name:      "short input",
			headLimit: 5,
			tailLimit: 4,
			writes:    []string{"abc"},
			want:      "abc",
			wantTotal: 3,
		},
		{
			name:      "long input",
			headLimit: 5,
			tailLimit: 4,
			writes:    []string{"abcdefghijk"},
			want:      "abcde\n... [2 bytes omitted] ...\nhijk",
			wantTotal: 11,
			truncated: true,
		},
		{
			name:      "segmented writes",
			headLimit: 3,
			tailLimit: 3,
			writes:    []string{"ab", "cdef", "gh"},
			want:      "abc\n... [2 bytes omitted] ...\nfgh",
			wantTotal: 8,
			truncated: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			buffer := NewHeadTailBuffer(test.headLimit, test.tailLimit)
			for _, write := range test.writes {
				n, err := buffer.Write([]byte(write))
				if err != nil {
					t.Fatalf("write: %v", err)
				}
				if n != len(write) {
					t.Fatalf("write length = %d, want %d", n, len(write))
				}
			}
			if got := buffer.String(); got != test.want {
				t.Fatalf("String() = %q, want %q", got, test.want)
			}
			if got := buffer.TotalBytes(); got != test.wantTotal {
				t.Fatalf("TotalBytes() = %d, want %d", got, test.wantTotal)
			}
			if got := buffer.Truncated(); got != test.truncated {
				t.Fatalf("Truncated() = %v, want %v", got, test.truncated)
			}
		})
	}
}

func TestHeadTailBufferConcurrentWrites(t *testing.T) {
	const writers = 32
	const payload = "concurrent-write\n"
	buffer := NewHeadTailBuffer(32, 32)

	var wait sync.WaitGroup
	wait.Add(writers)
	for range writers {
		go func() {
			defer wait.Done()
			if _, err := buffer.Write([]byte(payload)); err != nil {
				t.Errorf("write: %v", err)
			}
		}()
	}
	wait.Wait()

	if got, want := buffer.TotalBytes(), int64(writers*len(payload)); got != want {
		t.Fatalf("TotalBytes() = %d, want %d", got, want)
	}
	if !buffer.Truncated() {
		t.Fatal("expected concurrent output to be truncated")
	}
	if got := buffer.String(); !strings.Contains(got, "bytes omitted") {
		t.Fatalf("String() = %q, want omission marker", got)
	}
}
