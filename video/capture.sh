#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
raw_dir="$repo_root/.nash/video/$run_id/raw"
mkdir -p "$raw_dir"

segments=(intro architecture replay diff grader inspect stats end)
raw_durations=(8 10 32 16 16 16 16 10)

osascript -e 'tell application "Terminal"' \
  -e 'activate' \
  -e 'do script "clear"' \
  -e 'end tell' >/dev/null
sleep 1

terminal_window_id="$(osascript -e 'tell application "Terminal" to get id of front window')"
osascript \
  -e 'tell application "Terminal"' \
  -e "set targetWindow to first window whose id is $terminal_window_id" \
  -e 'set current settings of selected tab of targetWindow to settings set "Pro"' \
  -e 'set font size of selected tab of targetWindow to 20' \
  -e 'set number of columns of selected tab of targetWindow to 118' \
  -e 'set number of rows of selected tab of targetWindow to 28' \
  -e 'set position of targetWindow to {80, 80}' \
  -e 'end tell'
osascript -e 'tell application "Terminal" to activate'
# 首次切换 Space 的动画可能持续数秒；正式录制前先让专用窗口稳定下来。
sleep 4

for index in "${!segments[@]}"; do
  segment="${segments[$index]}"
  duration="${raw_durations[$index]}"
  output="$raw_dir/$segment.mov"
  printf 'recording %-12s %2ss\n' "$segment" "$duration"

  screencapture -v -x -D1 -V"$duration" "$output" &
  capture_pid=$!
  sleep 0.4
  osascript -e 'tell application "Terminal" to activate'
  sleep 0.4
  osascript \
    -e 'tell application "Terminal"' \
    -e "set targetWindow to first window whose id is $terminal_window_id" \
    -e "do script \"cd $repo_root && bash video/demo.sh $segment\" in selected tab of targetWindow" \
    -e 'end tell' >/dev/null
  wait "$capture_pid"
done

osascript \
  -e 'tell application "Terminal"' \
  -e "close (first window whose id is $terminal_window_id)" \
  -e 'end tell' >/dev/null || true

printf '%s\n' "$run_id" >"$repo_root/.nash/video/latest-run.txt"
printf 'raw capture: %s\n' "$raw_dir"
