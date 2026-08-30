# Nash

Nash 是一个从零实现的 TypeScript Coding Agent。模型负责判断下一步，Nash 在本地完成参数校验、文件操作、命令执行、终止控制和事件持久化。项目没有使用 Agent framework、Agent SDK，也没有调用服务端托管的文件或代码执行工具。

当前版本已经能用 DeepSeek 完成真实代码修复。在固定提交 `b537d34` 上连续运行五次，五次都在预算内结束，四次通过独立 hidden grader，一次被 handle 复用反例判错；成功率为 `4/5`，耗时 p50 为 45.8 秒，p95 为 63.1 秒。所有运行的受保护文件都没有变化。

## 为什么这样设计

Nash 采用自由的 model-tool loop，不预设固定的“规划、编码、测试”图。测试结果和代码结构会改变后续动作，模型应在每次 observation 后重新判断。自主性之外的约束由 runtime 提供：

- 文件只能访问工作区，真实路径和 symlink 都会检查。
- `.env*`、`.git`、`.nash` 等凭据或控制路径不会暴露给文件工具。
- 读取自动放行；写文件和 shell 命令默认需要审批。
- 命令有工作目录、超时、进程组终止、敏感环境变量剥离和输出上限。
- turn、工具数、token、总时长、重复失败都有硬预算。
- 每次运行写入 append-only JSONL，可检查，也可做无副作用界面回放。

```text
DeepSeek Chat Completions
           |
           v
      ModelClient
           |
           v
      CodingAgent  ------>  EventBus  ------>  JSONL + terminal
           |
           v
      ToolRegistry  -- prepare --> approve --> execute
           |
           v
        Workspace
```

## 快速开始

需要 Node.js 20.11 或更高版本。

```bash
npm install
cp .env.example .env.local
chmod 600 .env.local
```

只在 `.env.local` 中填写 `DEEPSEEK_API_KEY`。该文件已被 Git 忽略，不要把密钥写进命令、任务描述、文档或录屏。

在一个目标仓库中运行：

```bash
npm run dev -- run --workspace /path/to/project "修复失败的测试，保持现有 API，并运行验证"
```

读取操作会自动执行。写入和命令会显示安全预览，并等待 `y`、默认拒绝的 `N`，或本会话后续全部放行的 `a`。`--yes` 会跳过审批，但 shell 没有 OS 级沙箱，只应在临时目录或容器中使用。

常用命令：

```bash
# 查看严格校验后的会话摘要和时间线
npm run dev -- inspect --workspace /path/to/project <session-id>

# 按记录时间重放终端事件；不会重新执行工具
npm run dev -- replay --workspace /path/to/project --speed 8 <session-id>

# 运行仓库内置的确定性代码修复评测
npm run eval:stale-timer
```

构建和测试：

```bash
npm run check
npm run build
```

## 真实评测

`stale-timer` case 的旧租约回调已经出队，随后同一个 key 被重新写入。即使 scheduler 复用了 timer handle，旧回调也不能删除新值。Agent 能看到需求和公开测试，看不到独立 grader。

首轮公开测试通过后，复盘发现模型把 timer handle 当成代际标识，hidden grader 用 handle 复用击穿了这个假设。探索组五次运行中，模型读取 README 的三次全部通过，没有读取的两次全部失败。任务提示明确要求先读验收规格后，固定提交再跑五次，结果从 `3/5` 提升到 `4/5`；剩余一次失败说明读到契约也不等于遵守契约。这段过程保留在 [评测记录](docs/evaluation.md) 中，用来区分公开测试通过、设计成立和重复运行稳定性。

## 已知边界

- shell 作为宿主机进程运行，不具备安全沙箱隔离；审批只提供授权边界。
- shell pipeline 默认返回最后一个命令的退出码，`npm test | tail` 可能掩盖测试失败；关键验证应直接执行，或显式启用 pipefail。
- JSONL replay 重放界面和事件，不重做文件、命令或网络副作用。
- 崩溃可能发生在副作用完成、`tool_finished` 尚未落盘的窗口，此时只能标记悬空调用并请求人工确认。
- 当前上下文策略保留完整消息历史，仅限制工具输出大小；还没有做 compaction。
- 相同用户下的恶意并发进程仍可能利用文件检查与执行之间的 TOCTOU 窗口。

更完整的威胁模型见 [安全边界](docs/security.md)。

## 代码与文档

- [`src/agent/coding-agent.ts`](src/agent/coding-agent.ts)：循环、预算、重试和终止。
- [`src/provider/deepseek-chat-client.ts`](src/provider/deepseek-chat-client.ts)：DeepSeek 协议转换。
- [`src/tools`](src/tools)：文件与命令工具。
- [`src/trace`](src/trace)：有序事件和 JSONL 持久化。
- [`src/session`](src/session)：inspect、replay 和 trace 校验。
- [架构说明](docs/architecture.md)
- [DeepSeek 接入](docs/provider-deepseek.md)
- [面试追问手册](docs/interview-guide.md)
- [两分钟视频脚本](docs/video-plan.md)
- [视频制作与验收](video/README.md)
- [题目要求与验收](docs/requirements.md)

## License

[MIT](LICENSE)
