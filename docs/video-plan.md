# 两分钟视频脚本

## 主线

视频用一个真实代码修复会话说明 Nash 的三件事：模型能自主完成任务，runtime 能约束执行，结果能由独立 grader 和持久化轨迹复核。架构只解释画面里已经发生的动作，不在 107 秒内罗列全部功能。

演示任务是 `stale-timer`。旧 lease 的回调已经出队；同一个 key 写入新值后，旧回调才开始执行。scheduler 还可能复用 timer handle，因此 handle 不能充当 lease 的代际标识。这个任务能自然引出状态一致性、隐藏测试和 Agent 评测稳定性。

视频没有配音。中文字幕陈述画面事实，面试时的现场讲解补充设计原因和取舍。

## 最终分镜

| 时间 | 画面 | 现场讲解重点 |
| --- | --- | --- |
| 0:00–0:06 | 项目名、真实评测提交 | “Nash 是我从零实现的 TypeScript Coding Agent，这段演示只讲一条真实修复链路。” |
| 0:06–0:14 | runtime 边界图 | “模型选择下一步，本地 runtime 负责工具、审批、预算和持久化。” |
| 0:14–0:44 | 标有“真实会话回放”的 replay | “这里按原始事件顺序回放已完成会话，不会重新执行工具，也没有伪装成在线调用。” |
| 0:44–0:58 | baseline 与最终实现的 generation diff | “每次写入分配递增 generation，过期回调只删除自己创建的那一代。” |
| 0:58–1:12 | 公开测试、hidden grader 和受保护文件结果 | “Agent 执行时看不到隐藏测试。独立 grader 专门覆盖 timer handle 复用，结果是 7/7。” |
| 1:12–1:26 | `nash inspect` 摘要 | “JSONL 记录模型请求、工具结果和终止原因；这次运行是 45.8 秒、10 个 turn、13 次工具调用。” |
| 1:26–1:40 | 固定提交五次评测表 | “同一提交连续运行五次，四次通过。失败样本也保留，用来说明公开测试通过仍可能违反契约。” |
| 1:40–1:47.5 | 仓库地址与核心目录 | “代码、测试、评测脚本和提交历史都在仓库中，可以继续追问重试、崩溃窗口和安全边界。” |

播放时不用逐字念字幕。架构段讲清责任边界，回放段说明证据来源，评测段主动解释 `4/5` 的局限，这三处最能体现项目判断力。

## 真实会话

成片使用下面这条成功会话：

```bash
npm run dev -- inspect \
  --workspace .nash/evals/stale-timer-20260829T173748Z-ebf612bb/workspace \
  20260829T173748Z-5262d710

npm run dev -- replay \
  --workspace .nash/evals/stale-timer-20260829T173748Z-ebf612bb/workspace \
  --speed 2 \
  20260829T173748Z-5262d710
```

会话耗时 45.840 秒，包含 10 个 turn 和 13 次工具调用，最终采用 generation 修复，独立 grader `7/7`。回放只读取这条会话的 append-only JSONL，tool call 顺序和结果都来自原始运行。

`git diff --no-index` 发现差异时退出码为 1，录制脚本保留它的输出，不把这个退出码当成测试失败。

## 开场边界图

```text
DeepSeek Chat Completions
           |
           v
      CodingAgent  ------>  append-only JSONL
           |                         |
           v                         v
      ToolRegistry              inspect / replay
  prepare -> approve -> execute
           |
           v
     local workspace
```

这张图回答两个常见追问：自主决策发生在模型侧；工作区限制、审批、预算、工具执行和审计发生在 runtime 侧。

## 稳定性结果

固定提交 `b537d34` 的五次运行使用相同 fixture、任务、公开测试、hidden grader 和预算。模型配置为 `deepseek-v4-flash`、thinking enabled、reasoning effort high。

五次都在预算内结束，四次 grader PASS。耗时 p50 为 45.840 秒，p95 为 63.078 秒。失败样本公开测试 `5/5`，但错误依赖 timer handle 唯一性，hidden grader 将其判为 `6/7`。五个样本只能支持本任务上的改进方向，不能外推为任意仓库的 80% 成功率。逐次数据见 [`evaluation.md`](evaluation.md)。

## 制作与验收

```bash
bash video/capture.sh
bash video/render.sh
```

录制脚本创建固定位置、118 列、28 行的专用 Terminal 窗口。渲染脚本裁出终端内容，把 SRT 生成的底部字幕轨和回放标签烧录进视频，再加入 AAC 静音轨。脚本针对当前 Retina 显示器使用固定裁切坐标；换显示器后应先抽帧校准。

已验收成片参数：

- 107.533 秒，4,426,781 字节。
- 1920×1080、30fps、H.264、`yuv420p`。
- AAC、48kHz、双声道静音轨。
- 全片解码无错误，未检测到持续黑场。
- 回放标签只在 14–44 秒显示。

原始录屏和成片保存在 `.nash/video/<run-id>/`，不会进入 Git。可编辑字幕和制作脚本位于 [`video/`](../video)。

## 录制安全检查

- `.env.local` 必须被 Git 忽略，权限保持 `0600`。
- 不执行 `env`、`printenv`、`set`，不打开 `.env.local`。
- 画面只保留固定裁切后的 Terminal 内容，不显示菜单栏、通知、浏览器或其他桌面。
- 回放持续显示“真实会话回放”，避免把 replay 误解为实时模型调用。
- 保留原始 workspace、JSONL、result.json 和未剪辑素材，便于面试现场复核。

## 面试追问

- “为什么不录实时调用？”实时调用的等待时间和网络波动会挤占两分钟。回放来自一次完整真实运行，保留事件顺序和结果，同时明确标注 replay。实时性没有被当成项目能力来宣传。

- “为什么展示 `4/5`？”单次成功说明功能能跑，重复运行才能暴露模型方差。外部 grader 还能识别 Agent 自称成功却违反契约的样本。保留失败证据比只展示一次成功更能说明评测设计。

- “字幕会不会遮住关键输出？”终端裁切后专门保留 168 像素黑色区域，字幕轨只覆盖这块区域。代码、测试和统计表仍保持完整可读。
