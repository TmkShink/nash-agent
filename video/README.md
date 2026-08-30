# 视频制作

成片采用“现场 Agent 运行 + trace 摘要 + 独立 grader + 浏览器实操 + 中文字幕”。终端会话从完整指令开始，停留约两秒后执行；模型的 SSE 进度和工具卡片按真实时间录制，完成状态与运行数据直接读取同一次会话的 trace。视频没有配音和背景音乐，便于面试时现场讲解。

## 脚本职责

- `capture.sh`：创建现场 run，按指定时长录制整个显示器，并保存原始 `.mov`。
- `demo.sh`：准备隔离 workspace、打印 Agent 命令、在停止后加入 hidden grader、查看 trace 或启动网页。
- `render.sh`：从四段真实素材裁出终端、trace、grader 和浏览器画面，拼接并烧录字幕。
- `render-captions.swift`：把 SRT 渲染为透明 PNG 时间线。
- `subtitles.zh.srt`、`subtitles.zh.ass`：可编辑的中文字幕源文件。

## 准备现场运行

需要 macOS 屏幕录制权限、FFmpeg、Node.js 20.11 以上版本，以及只保存在 `.env.local` 中的 DeepSeek API key。

```bash
bash video/capture.sh prepare
bash video/demo.sh command
```

`prepare` 会把 `game-2048` fixture 复制到 `.nash/video/<run-id>/workspace`，记录四个受保护文件的初始哈希，并把当前 run ID 写到忽略目录。它不会把 hidden grader 放进 workspace。

## 录制终端

在录屏控制终端运行：

```bash
bash video/capture.sh start 150 terminal
```

在演示终端输入 `demo.sh command` 给出的完整命令。输入完后停留约两秒，再按 Return。终端素材保留任务开头和主要工具交互，完成状态与运行数据在下一段通过同一次会话的 trace 展示。

录制状态可用下面的命令查看：

```bash
bash video/capture.sh status
```

## 录制 trace 摘要

Agent 停止后，在演示终端运行：

```bash
bash video/demo.sh inspect
```

把终端滚动到摘要顶部，再在录屏控制终端运行：

```bash
bash video/capture.sh start 30 summary-submit
```

## 录制 grader

Agent 停止后，在录屏控制终端运行：

```bash
bash video/capture.sh start 30 evidence-submit
```

随后在演示终端执行：

```bash
bash video/demo.sh verify
```

`verify` 才会复制 hidden grader，运行 7 项公开测试和 14 项 hidden tests，并检查受保护文件。验证命令可以重复执行；如果 workspace 中出现不同的 grader，脚本会拒绝继续。

## 录制浏览器

启动 Nash 生成的页面：

```bash
bash video/demo.sh serve 4173
```

在浏览器打开 `http://127.0.0.1:4173`，隐藏收藏夹栏和其他无关元素。先在录屏控制终端运行：

```bash
bash video/capture.sh start 35 browser-submit
```

录屏时依次检查键盘移动、pointer swipe、Score、New Game 和 Best。

## 渲染

```bash
bash video/render.sh
```

渲染脚本默认读取 `.nash/video/latest-live-run.txt`。当前裁切起点按照已验收素材校准；重新录制后如果窗口位置或操作时机变化，需要先抽帧确认 `render.sh` 中的起点和裁切坐标。

输出位于：

```text
.nash/video/<run-id>/nash-demo-submission.mp4
```

成片参数为 1920×1080、30fps、H.264、`yuv420p`，并带 AAC 48kHz 双声道静音轨。底部预留 168 像素黑色字幕区域，字幕不覆盖终端和游戏内容。

## 验收

```bash
ffprobe -v error \
  -show_entries format=duration,size \
  -show_entries stream=index,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels \
  -of json \
  .nash/video/<run-id>/nash-demo-submission.mp4

ffmpeg -v error \
  -i .nash/video/<run-id>/nash-demo-submission.mp4 \
  -f null -
```

还需要人工检查开头完整命令、两秒停留、工具卡片、`21/21`、浏览器操作和全部字幕。字幕只介绍 Nash 当前能力与画面事实，不写研发过程、问题复盘或后续计划。画面中不能出现密钥、通知、浏览器历史或其他个人信息。

本次交付成片为 101.433 秒、3,759,078 字节，完整解码无错误。视频轨为 1920×1080、30fps、H.264、`yuv420p`；音轨为 AAC、48kHz、双声道静音。

原始录屏和成片位于 `.nash/`，不会进入 Git；仓库只保留可复现的录制、渲染和字幕源文件。
