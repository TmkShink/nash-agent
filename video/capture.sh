#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
video_root="$repo_root/.nash/video"
latest_file="$video_root/latest-live-run.txt"

latest_run_root() {
  test -f "$latest_file" || {
    printf 'no prepared live demo; run: bash video/capture.sh prepare\n' >&2
    exit 1
  }
  local run_id
  run_id="$(sed -n '1p' "$latest_file")"
  [[ "$run_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
    printf 'invalid live demo id: %s\n' "$run_id" >&2
    exit 1
  }
  printf '%s/%s\n' "$video_root" "$run_id"
}

start_capture() {
  local run_directory raw_directory output pid_file log_file seconds display name capture_pid capture_status
  run_directory="$(latest_run_root)"
  raw_directory="$run_directory/raw"
  seconds="${1:-150}"
  name="${2:-live}"
  display="${NASH_VIDEO_DISPLAY:-1}"
  [[ "$name" =~ ^[a-z][a-z0-9-]*$ ]] || {
    printf 'capture name must contain lowercase letters, digits, or hyphens\n' >&2
    exit 2
  }
  output="$raw_directory/$name.mov"
  pid_file="$run_directory/$name.pid"
  log_file="$run_directory/$name.log"

  [[ "$seconds" =~ ^[0-9]+$ ]] && (( seconds >= 30 && seconds <= 300 )) || {
    printf 'capture duration must be an integer from 30 to 300 seconds\n' >&2
    exit 2
  }
  if test -f "$pid_file" && kill -0 "$(sed -n '1p' "$pid_file")" 2>/dev/null; then
    printf 'screen capture is already running\n' >&2
    exit 1
  fi

  mkdir -p -m 700 "$raw_directory"
  test ! -e "$output" || {
    printf 'raw recording already exists: %s\n' "$output" >&2
    exit 1
  }
  screencapture -v -x -D"$display" -V"$seconds" "$output" \
    >"$log_file" 2>&1 &
  capture_pid=$!
  printf '%s\n' "$capture_pid" >"$pid_file"
  chmod 600 "$pid_file" "$log_file"
  printf 'recording: %s\n' "$output"
  printf 'maximum duration: %s seconds\n' "$seconds"
  printf 'show the complete command for two seconds before pressing Return\n'

  capture_status=0
  wait "$capture_pid" || capture_status=$?
  for _ in {1..50}; do
    kill -0 "$capture_pid" 2>/dev/null || break
    sleep 0.2
  done
  if ! test -s "$output"; then
    printf 'screen capture failed with status %s; see %s\n' "$capture_status" "$log_file" >&2
    exit 1
  fi
  printf 'raw recording: %s\n' "$output"
}

case "${1:-}" in
  prepare)
    bash "$repo_root/video/demo.sh" prepare
    ;;
  start)
    start_capture "${2:-150}" "${3:-live}"
    ;;
  status)
    run_directory="$(latest_run_root)"
    printf 'run: %s\n' "$(basename "$run_directory")"
    find "$run_directory/raw" -maxdepth 1 -type f -name '*.mov' -print 2>/dev/null || true
    ;;
  *)
    printf 'usage: %s {prepare|start [seconds] [name]|status}\n' "$0" >&2
    exit 2
    ;;
esac
