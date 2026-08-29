package tool

import (
	"fmt"
	"os"
	"path/filepath"
)

const maxFileWriteBytes = 1024 * 1024

func writeFileAtomic(path string, content []byte, mode os.FileMode, replace bool) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("create parent directory: %w", err)
	}

	temporary, err := os.CreateTemp(directory, ".nash-write-*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	if err := temporary.Chmod(mode.Perm()); err != nil {
		temporary.Close()
		return fmt.Errorf("set temporary file mode: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return fmt.Errorf("write temporary file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync temporary file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}
	if replace {
		if err := os.Rename(temporaryPath, path); err != nil {
			return fmt.Errorf("replace target file: %w", err)
		}
		return nil
	}

	// Linking a complete temporary file gives create-only writes an atomic
	// no-clobber guarantee that a pre-write Stat check cannot provide.
	if err := os.Link(temporaryPath, path); err != nil {
		return fmt.Errorf("create target file: %w", err)
	}
	return nil
}
