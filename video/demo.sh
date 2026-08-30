#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case_root="$repo_root/evals/cases/game-2048"
fixture="$case_root/workspace"
grader_fixture="$case_root/grader"
video_root="$repo_root/.nash/video"
latest_file="$video_root/latest-live-run.txt"
prompt="$(tr '\n' ' ' <"$case_root/task.txt" | sed 's/[[:space:]]*$//')"
protected_files=(README.md package.json scripts/serve.mjs test/game.test.js)

latest_run_id() {
  test -f "$latest_file" || {
    printf 'no live demo exists; run: bash video/demo.sh prepare\n' >&2
    exit 1
  }
  local run_id
  run_id="$(sed -n '1p' "$latest_file")"
  [[ "$run_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
    printf 'invalid live demo id: %s\n' "$run_id" >&2
    exit 1
  }
  printf '%s\n' "$run_id"
}

run_root() {
  printf '%s/%s\n' "$video_root" "$(latest_run_id)"
}

workspace_path() {
  printf '%s/workspace\n' "$(run_root)"
}

workspace_relative_path() {
  local workspace
  workspace="$(workspace_path)"
  printf '%s\n' "${workspace#"$repo_root/"}"
}

write_protected_manifest() {
  local destination="$1"
  : >"$destination"
  for file in "${protected_files[@]}"; do
    printf '%s\t%s\n' \
      "$(shasum -a 256 "$fixture/$file" | awk '{print $1}')" \
      "$file" >>"$destination"
  done
  chmod 600 "$destination"
}

prepare_demo() {
  local run_id run_directory workspace manifest
  run_id="$(date -u +%Y%m%dT%H%M%SZ)"
  run_directory="$video_root/$run_id"
  workspace="$run_directory/workspace"
  manifest="$run_directory/protected.sha256"

  mkdir -p -m 700 "$video_root"
  mkdir -m 700 "$run_directory"
  cp -R "$fixture" "$workspace"
  write_protected_manifest "$manifest"
  printf '%s\n' "$run_id" >"$latest_file"
  chmod 600 "$latest_file"

  printf 'live demo: %s\n' "$run_id"
  printf 'workspace: %s\n' "${workspace#"$repo_root/"}"
  printf 'command to type, then hold for two seconds before Return:\n\n'
  print_agent_command
}

print_agent_command() {
  printf 'npm run dev -- run --yes --reasoning-effort low --workspace %s "%s"\n' \
    "$(workspace_relative_path)" \
    "$prompt"
}

verify_demo() {
  local workspace manifest grader_status protected_status expected file actual
  workspace="$(workspace_path)"
  manifest="$(run_root)/protected.sha256"
  test -d "$workspace"
  test -f "$manifest"
  if test -e "$workspace/.grader"; then
    diff -qr "$grader_fixture" "$workspace/.grader" >/dev/null || {
      printf 'live workspace contains a different hidden grader\n' >&2
      exit 1
    }
  else
    cp -R "$grader_fixture" "$workspace/.grader"
  fi
  printf '\nIndependent grader (available only after the Agent stopped):\n\n'
  grader_status=0
  (
    cd "$workspace"
    node --test test/game.test.js .grader/game.hidden.test.js
  ) || grader_status=$?

  protected_status=0
  while IFS=$'\t' read -r expected file; do
    if ! test -f "$workspace/$file"; then
      protected_status=1
      continue
    fi
    actual="$(shasum -a 256 "$workspace/$file" | awk '{print $1}')"
    if [[ "$actual" != "$expected" ]]; then
      protected_status=1
    fi
  done <"$manifest"

  printf '\nprotected files: %s\n' "$([[ "$protected_status" -eq 0 ]] && printf unchanged || printf MODIFIED)"
  if [[ "$grader_status" -ne 0 || "$protected_status" -ne 0 ]]; then
    exit 1
  fi
}

inspect_demo() {
  local workspace trace session_id
  workspace="$(workspace_path)"
  trace="$(find "$workspace/.nash/sessions" -maxdepth 1 -type f -name '*.jsonl' -print | sort | tail -1)"
  test -n "$trace" || {
    printf 'no Nash trace found in %s\n' "$workspace" >&2
    exit 1
  }
  session_id="$(basename "$trace" .jsonl)"
  cd "$repo_root"
  npm run dev -- inspect --workspace "$(workspace_relative_path)" "$session_id"
}

serve_demo() {
  local port="${2:-4173}"
  [[ "$port" =~ ^[0-9]+$ ]] || {
    printf 'port must be an integer\n' >&2
    exit 2
  }
  cd "$(workspace_path)"
  exec env PORT="$port" npm start
}

case "${1:-}" in
  prepare)
    prepare_demo
    ;;
  command)
    print_agent_command
    ;;
  path)
    workspace_relative_path
    ;;
  verify)
    verify_demo
    ;;
  inspect)
    inspect_demo
    ;;
  serve)
    serve_demo "$@"
    ;;
  *)
    printf 'usage: %s {prepare|command|path|verify|inspect|serve [port]}\n' "$0" >&2
    exit 2
    ;;
esac
