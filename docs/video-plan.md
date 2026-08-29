# 两分钟视频脚本

## 只讲一条主线

视频要证明 Nash 能完成真实代码修复，并让观众同时看到执行边界和可验证结果。架构只解释画面里已经发生的动作，不在两分钟内罗列所有功能。

演示使用 `stale-timer`：旧 lease callback 已经出队，replacement 写入后再执行旧 callback，新值被误删。scheduler 还可能复用旧 handle，所以只比较 timer handle 仍然错误。这个任务短、确定、容易用一张时序图讲清，也能承接面试中的状态一致性追问。

固定提交 `b537d34` 已完成五次真实运行：五次都在预算内结束，四次通过 hidden grader，耗时 p50 为 45.8 秒、p95 为 63.1 秒。视频展示一个真实成功会话，同时用一张结果卡说明 `4/5`，不把失败样本藏起来。

## 最终分镜

| 时间 | 画面 | 旁白 |
| --- | --- | --- |
| 0:00–0:07 | 标题、仓库名、失败测试一句话 | “Nash 是我从零实现的 TypeScript Coding Agent。这里让它修一个旧计时回调误删新值的竞态。” |
| 0:07–0:17 | 极简架构图 | “模型自由选择动作；本地 runtime 负责工具、审批、硬预算和 JSONL 记录。” |
| 0:17–1:05 | 实时执行 `npm run eval:stale-timer` | “它先读实现、需求和测试，真实复现失败，再做精确编辑。命令在隔离 fixture 中执行，API key 不会传给子进程。” |
| 1:05–1:20 | 放大 generation diff | “修复没有依赖可复用的 timer handle，而是给每个 lease 分配单调 generation，旧 callback 只能删除自己那一代。” |
| 1:20–1:35 | hidden grader `7/7` 和 protected files unchanged | “Agent 看不到 hidden grader。独立验证覆盖 handle 复用，并确认需求、配置和公开测试没有被改。” |
| 1:35–1:52 | `nash inspect` 摘要和五次评测结果卡 | “这个会话的每次模型请求、工具结果和终止原因都能检查。固定条件五次有四次通过，一次违反契约也被 grader 留下。” |
| 1:52–2:00 | 仓库地址与核心目录 | “仓库保留完整实现和测试，面试中我会重点解释重试边界、崩溃窗口和评测设计。” |

旁白按正常语速约 230 至 260 个汉字。录制时不要逐行念终端，只在动作切换时补一句。

## 录制命令

先在单独终端进入 Nash 仓库，确认当前 commit、模型配置和测试：

```bash
git status --short
npm run check
npm run eval:stale-timer
```

runner 会打印 `<workspace>`、`<session-id>` 和 artifacts 路径。另开两个已经准备好的终端 tab：

```bash
# Tab 2：展示 baseline 与最终实现的差异
git diff --no-index \
  evals/cases/stale-timer/workspace/src/lease-cache.ts \
  <workspace>/src/lease-cache.ts

# Tab 3：展示会话摘要
npm run dev -- inspect --workspace <workspace> <session-id>
```

已经验证的备用成功会话是：

```bash
npm run dev -- inspect \
  --workspace .nash/evals/stale-timer-20260829T173748Z-ebf612bb/workspace \
  20260829T173748Z-5262d710

npm run dev -- replay \
  --workspace .nash/evals/stale-timer-20260829T173748Z-ebf612bb/workspace \
  --speed 2 \
  20260829T173748Z-5262d710
```

这个样本耗时 45.840 秒，包含 10 个 turn 和 13 次工具调用，使用 generation 修复，grader `7/7`。使用 replay 时，画面角标和旁白都要明确写“真实会话回放”。`.nash` 不入 Git，正式剪辑前不要清理这个本地 artifacts 目录。

`git diff --no-index` 发现差异时退出码为 1，这是正常行为。录屏不要把它和测试失败混在同一画面。

若需要剪去模型等待，可以对完整实时录屏的静止区间做 2 至 4 倍加速。保留 tool call 顺序和真实耗时摘要，不重新拼接一条不存在的运行轨迹。`replay --speed 8` 可作为备用素材，但画面和旁白必须明确写“会话回放”，不能冒充实时执行。

## 开场时序图

视频只保留下面这张图，展示 8 至 10 秒：

```text
DeepSeek -> CodingAgent -> ToolRegistry -> local workspace
                    |
                    +-> append-only JSONL -> inspect / replay
```

不在视频里展示完整类图。评委可以从 README 和现场提问进入代码细节。

## 稳定性结果

固定以下条件已经连续运行五次：

- 同一个 Git commit 和干净 fixture。
- `deepseek-v4-flash`、thinking enabled、reasoning effort high。
- 12 turns、24 tools、240 秒 wall-clock 上限。
- 同一版公开测试、hidden grader 和受保护文件列表。

结果为五次全部完成、四次 grader PASS，p50 45.840 秒，p95 63.078 秒，达到预设的 `4/5` 和 p95 不超过 90 秒门槛。失败样本公开测试 `5/5`，但错误依赖 timer handle 唯一性，hidden grader 将其判为 `6/7`。逐次数据和改进前的 `3/5` 探索组都记录在 [`evaluation.md`](evaluation.md)。

## 录制安全检查

- 录制前确认 `.env.local` 被 Git 忽略且权限为 `0600`。
- 不执行 `env`、`printenv`、`set`，不打开 `.env.local`，清空包含密钥的 shell history。
- 使用专门的测试 key；视频完成后可轮换。
- 关闭通知、浏览器密码提示和菜单栏中的个人信息。
- 终端宽度至少 110 列，字号保证 1080p 下可读，关闭会改变布局的自动换行插件。
- stderr 时间线与 stdout final answer 分开配色；不要使用会吞掉退出码的管道。
- 保留未剪辑原片、最终成功 workspace、JSONL 和 result.json，便于现场说明。

## 失败时怎么处理

真实运行失败可以重新录，但要先根据 trace 分类：provider 暂时失败、模型修复错误、工具拒绝、超预算或 grader 失败。只有确认原因后再决定重跑或改代码。备用画面使用已经验证的 `replay`，并标明它是回放。任何版本都不能手工改终端输出或把不同会话的步骤拼成一次成功运行。
