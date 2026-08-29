package textlimit

import (
	"fmt"
	"strings"
	"sync"
)

// HeadTailBuffer keeps the beginning and end of an unbounded byte stream. It
// never returns a short write, so a noisy child process cannot fail merely
// because Nash stopped retaining its complete output.
type HeadTailBuffer struct {
	mu        sync.Mutex
	headLimit int
	tailLimit int
	head      []byte
	tail      []byte
	total     int64
}

func NewHeadTailBuffer(headLimit, tailLimit int) *HeadTailBuffer {
	if headLimit < 0 || tailLimit < 0 {
		panic("textlimit: negative limit")
	}
	return &HeadTailBuffer{headLimit: headLimit, tailLimit: tailLimit}
}

func (b *HeadTailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	n := len(p)
	b.total += int64(n)

	if remaining := b.headLimit - len(b.head); remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		b.head = append(b.head, p[:remaining]...)
		p = p[remaining:]
	}

	if b.tailLimit > 0 && len(p) > 0 {
		b.tail = append(b.tail, p...)
		if extra := len(b.tail) - b.tailLimit; extra > 0 {
			copy(b.tail, b.tail[extra:])
			b.tail = b.tail[:b.tailLimit]
		}
	}

	return n, nil
}

func (b *HeadTailBuffer) TotalBytes() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.total
}

func (b *HeadTailBuffer) Truncated() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.total > int64(len(b.head)+len(b.tail))
}

func (b *HeadTailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	head := strings.ToValidUTF8(string(b.head), "�")
	if b.total <= int64(len(b.head)+len(b.tail)) {
		return head + strings.ToValidUTF8(string(b.tail), "�")
	}

	omitted := b.total - int64(len(b.head)+len(b.tail))
	tail := strings.ToValidUTF8(string(b.tail), "�")
	return fmt.Sprintf("%s\n... [%d bytes omitted] ...\n%s", head, omitted, tail)
}
