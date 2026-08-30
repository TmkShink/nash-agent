#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_id="${1:-$(sed -n '1p' "$repo_root/.nash/video/latest-run.txt")}"
run_root="$repo_root/.nash/video/$run_id"
raw_dir="$run_root/raw"
clip_dir="$run_root/clips"
caption_dir="$run_root/captions"
output="$run_root/nash-demo-submission.mp4"
mkdir -p "$clip_dir" "$caption_dir"

segments=(intro architecture replay diff grader inspect stats end)
clip_durations=(6 8 30 14 14 14 14 8)

for index in "${!segments[@]}"; do
  segment="${segments[$index]}"
  duration="${clip_durations[$index]}"
  input="$raw_dir/$segment.mov"
  clip="$clip_dir/$segment.mp4"
  test -s "$input"

  ffmpeg -y -hide_banner -loglevel error \
    -ss 1 -i "$input" -t "$duration" \
    -vf "crop=2872:1490:160:210,scale=1760:-2:flags=lanczos,pad=1920:1080:80:0:black,fps=30,format=yuv420p" \
    -an -c:v libx264 -preset medium -crf 18 \
    "$clip"
done

concat_file="$run_root/concat.txt"
: >"$concat_file"
for segment in "${segments[@]}"; do
  printf "file '%s'\n" "$clip_dir/$segment.mp4" >>"$concat_file"
done

joined="$run_root/joined.mp4"
ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$concat_file" -c copy "$joined"

export CLANG_MODULE_CACHE_PATH="$run_root/swift-module-cache"
export SWIFT_MODULECACHE_PATH="$run_root/swift-module-cache"
xcrun swift "$repo_root/video/render-captions.swift" \
  "$repo_root/video/subtitles.zh.srt" \
  "$caption_dir"

caption_video="$caption_dir/caption-timeline.mp4"
ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$caption_dir/caption-timeline.ffconcat" \
  -t 108 -vf "fps=30,format=yuv420p" \
  -an -c:v libx264 -preset veryfast -crf 18 \
  "$caption_video"

ffmpeg -y -hide_banner -loglevel error \
  -i "$joined" \
  -i "$caption_video" \
  -loop 1 -framerate 1 -i "$caption_dir/replay-label.png" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -filter_complex "[0:v][1:v]overlay=0:912:shortest=1[captioned];[captioned][2:v]overlay=1570:24:enable='between(t,14,44)'[video]" \
  -map "[video]" -map 3:a:0 -t 108 \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -shortest -movflags +faststart \
  "$output"

printf 'video: %s\n' "$output"
