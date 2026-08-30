#!/usr/bin/env bash

set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace_rel=".nash/evals/stale-timer-20260829T173748Z-ebf612bb/workspace"
workspace="$repo_root/$workspace_rel"
session_id="20260829T173748Z-5262d710"
section="${1:-}"

blue=$'\033[38;5;75m'
green=$'\033[38;5;78m'
yellow=$'\033[38;5;221m'
dim=$'\033[2m'
reset=$'\033[0m'

cd "$repo_root"
printf '\033]0;Nash Demo\007'

heading() {
  clear
  printf '%sNASH%s  /  %s\n' "$blue" "$reset" "$1"
  printf '%s────────────────────────────────────────────────────────────────────────────%s\n\n' "$dim" "$reset"
}

case "$section" in
  intro)
    heading "TYPESCRIPT CODING AGENT"
    printf '\n  %sNash%s\n' "$blue" "$reset"
    printf '  TypeScript Coding Agent\n\n'
    printf '  真实会话回放  ·  独立验证  ·  可审计轨迹\n\n'
    printf '  evaluation commit  '
    git show -s --format='%h  %s' b537d34
    ;;

  architecture)
    heading "RUNTIME BOUNDARY"
    printf '\n'
    printf '  DeepSeek Chat Completions\n'
    printf '             │\n'
    printf '             ▼\n'
    printf '        CodingAgent  ──────▶  append-only JSONL\n'
    printf '             │                         │\n'
    printf '             ▼                         ▼\n'
    printf '        ToolRegistry              inspect / replay\n'
    printf '     prepare → approve → execute\n'
    printf '             │\n'
    printf '             ▼\n'
    printf '       local workspace\n'
    ;;

  replay)
    heading "REAL SESSION REPLAY"
    printf '%s真实会话回放：按原始时间顺序重放，不重新执行工具。%s\n\n' "$yellow" "$reset"
    printf '%s$ npm run dev -- replay --workspace %s --speed 2 %s%s\n\n' \
      "$dim" "$workspace_rel" "$session_id" "$reset"
    npm run dev -- replay \
      --workspace "$workspace_rel" \
      --speed 2 \
      "$session_id"
    ;;

  diff)
    heading "VERIFIED CODE CHANGE"
    printf '%s$ git diff --no-index baseline final%s\n\n' "$dim" "$reset"
    git diff --no-index --color=always --unified=3 -- \
      evals/cases/stale-timer/workspace/src/lease-cache.ts \
      "$workspace/src/lease-cache.ts" 2>/dev/null | sed -n '5,27p'
    ;;

  grader)
    heading "INDEPENDENT GRADER"
    cd "$workspace"
    printf '%s$ node --test public.test.ts hidden.test.ts%s\n\n' "$dim" "$reset"
    node --import tsx --test \
      test/lease-cache.test.ts \
      .grader/lease-cache.hidden.test.ts
    printf '\n'
    jq -r 'if .protectedFilesIntact then "protected files: unchanged" else "protected files: MODIFIED" end' \
      ../result.json
    ;;

  inspect)
    heading "AUDITABLE SESSION"
    printf '%s$ nash inspect %s%s\n\n' "$dim" "$session_id" "$reset"
    npm run dev -- inspect \
      --workspace "$workspace_rel" \
      "$session_id" 2>&1 | sed -n '1,18p'
    ;;

  stats)
    heading "FIXED-COMMIT EVALUATION"
    printf '%s$ sed -n 72,93p docs/evaluation.md%s\n\n' "$dim" "$reset"
    sed -n '72,93p' docs/evaluation.md
    ;;

  end)
    heading "SOURCE AND EVIDENCE"
    printf '\n  Repository\n'
    printf '  %shttps://github.com/TmkShink/nash-agent%s\n\n' "$blue" "$reset"
    printf '  Core implementation\n'
    printf '  %ssrc/agent%s       model-tool loop and budgets\n' "$green" "$reset"
    printf '  %ssrc/provider%s    DeepSeek protocol\n' "$green" "$reset"
    printf '  %ssrc/tools%s       local tools and approvals\n' "$green" "$reset"
    printf '  %ssrc/trace%s       append-only session record\n' "$green" "$reset"
    printf '  %sevals/%s          deterministic grader\n' "$green" "$reset"
    ;;

  *)
    printf 'usage: %s {intro|architecture|replay|diff|grader|inspect|stats|end}\n' "$0" >&2
    exit 2
    ;;
esac
