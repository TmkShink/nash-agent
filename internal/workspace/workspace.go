package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var ErrOutsideRoot = errors.New("path escapes the workspace root")

// Workspace resolves model-provided paths against a canonical root.
type Workspace struct {
	root string
}

func New(root string) (*Workspace, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("workspace root is empty")
	}

	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("make workspace root absolute: %w", err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	info, err := os.Stat(real)
	if err != nil {
		return nil, fmt.Errorf("stat workspace root: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("workspace root is not a directory: %s", real)
	}

	return &Workspace{root: filepath.Clean(real)}, nil
}

func (w *Workspace) Root() string {
	return w.root
}

// ResolveExisting resolves a path that must already exist. Symlinks are fully
// evaluated before the workspace boundary is checked.
func (w *Workspace) ResolveExisting(path string) (string, error) {
	candidate, err := w.lexicalCandidate(path)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	if err := w.requireInside(real); err != nil {
		return "", err
	}
	return filepath.Clean(real), nil
}

// ResolveForWrite resolves an existing target or checks the nearest existing
// ancestor of a new target. The check narrows accidental escapes but cannot
// remove filesystem TOCTOU races caused by another concurrent process.
func (w *Workspace) ResolveForWrite(path string) (string, error) {
	candidate, err := w.lexicalCandidate(path)
	if err != nil {
		return "", err
	}
	if candidate == w.root {
		return "", errors.New("workspace root cannot be used as a file")
	}

	if _, err := os.Lstat(candidate); err == nil {
		return w.ResolveExisting(path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	ancestor := filepath.Dir(candidate)
	for {
		if _, err := os.Lstat(ancestor); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", ErrOutsideRoot
		}
		ancestor = parent
	}

	realAncestor, err := filepath.EvalSymlinks(ancestor)
	if err != nil {
		return "", err
	}
	if err := w.requireInside(realAncestor); err != nil {
		return "", err
	}

	remainder, err := filepath.Rel(ancestor, candidate)
	if err != nil {
		return "", err
	}
	resolved := filepath.Join(realAncestor, remainder)
	if err := w.requireInside(resolved); err != nil {
		return "", err
	}
	return filepath.Clean(resolved), nil
}

func (w *Workspace) Relative(path string) string {
	rel, err := filepath.Rel(w.root, path)
	if err != nil {
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(rel)
}

func (w *Workspace) lexicalCandidate(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("path is empty")
	}
	if filepath.IsAbs(path) || filepath.VolumeName(path) != "" {
		return "", ErrOutsideRoot
	}
	candidate := filepath.Join(w.root, filepath.Clean(path))
	if err := w.requireInside(candidate); err != nil {
		return "", err
	}
	return candidate, nil
}

func (w *Workspace) requireInside(path string) error {
	rel, err := filepath.Rel(w.root, filepath.Clean(path))
	if err != nil {
		return ErrOutsideRoot
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return ErrOutsideRoot
	}
	return nil
}
