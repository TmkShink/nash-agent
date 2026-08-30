#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_id="${1:-$(sed -n '1p' "$repo_root/.nash/video/latest-live-run.txt")}"
run_root="$repo_root/.nash/video/$run_id"
raw_dir="$run_root/raw"
clip_dir="$run_root/clips"
caption_dir="$run_root/captions"
output="$run_root/nash-demo-submission.mp4"
mkdir -p "$clip_dir" "$caption_dir"

terminal_input="$raw_dir/terminal.mov"
summary_input="$raw_dir/summary-submit.mov"
evidence_input="$raw_dir/evidence-submit.mov"
browser_input="$raw_dir/browser-submit.mov"
test -s "$terminal_input"
test -s "$summary_input"
test -s "$evidence_input"
test -s "$browser_input"

encode_clip() {
  local input="$1"
  local start="$2"
  local duration="$3"
  local filter="$4"
  local output_path="$5"

  ffmpeg -y -hide_banner -loglevel error \
    -ss "$start" -i "$input" -t "$duration" \
    -vf "$filter,fps=30,format=yuv420p" \
    -an -c:v libx264 -preset medium -crf 18 \
    "$output_path"
}

# 终端内容会自然向下滚动。前 12 秒缓慢下移裁剪窗口，既保留完整指令，
# 也能在后半段持续看到当前工具卡片。
encode_clip \
  "$terminal_input" 89 60.5 \
  "crop=4096:1946:0:'180+min(t/12,1)*320',scale=1920:912:flags=lanczos,pad=1920:1080:0:0:black" \
  "$clip_dir/terminal.mp4"

encode_clip \
  "$summary_input" 0 6 \
  "crop=4096:1946:0:300,scale=1920:912:flags=lanczos,pad=1920:1080:0:0:black" \
  "$clip_dir/summary.mp4"

encode_clip \
  "$evidence_input" 0 8 \
  "crop=4096:1946:0:300,scale=1920:912:flags=lanczos,pad=1920:1080:0:0:black" \
  "$clip_dir/evidence.mp4"

encode_clip \
  "$browser_input" 8 27 \
  "crop=4096:1946:0:250,scale=1920:912:flags=lanczos,pad=1920:1080:0:0:black" \
  "$clip_dir/browser.mp4"

concat_file="$run_root/concat.txt"
: >"$concat_file"
for clip in terminal summary evidence browser; do
  printf "file '%s'\n" "$clip_dir/$clip.mp4" >>"$concat_file"
done

joined="$run_root/joined.mp4"
ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$concat_file" -c copy "$joined"
total_duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$joined")"

export CLANG_MODULE_CACHE_PATH="$run_root/swift-module-cache"
export SWIFT_MODULECACHE_PATH="$run_root/swift-module-cache"
xcrun swift "$repo_root/video/render-captions.swift" \
  "$repo_root/video/subtitles.zh.srt" \
  "$caption_dir" \
  "$total_duration"

caption_video="$caption_dir/caption-timeline.mp4"
ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$caption_dir/caption-timeline.ffconcat" \
  -t "$total_duration" -vf "fps=30,format=yuv420p" \
  -an -c:v libx264 -preset veryfast -crf 18 \
  "$caption_video"

ffmpeg -y -hide_banner -loglevel error \
  -i "$joined" \
  -i "$caption_video" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -filter_complex "[0:v][1:v]overlay=0:912:shortest=1[video]" \
  -map "[video]" -map 2:a:0 -t "$total_duration" \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -shortest -movflags +faststart \
  "$output"

printf 'video: %s\n' "$output"
