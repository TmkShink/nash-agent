# Nash

Nash 是一个用 TypeScript 从零实现的 Coding Agent。模型负责选择下一步，Nash 在本地完成流式协议解析、工具参数校验、文件与命令执行、预算控制和会话持久化。项目没有使用 Agent framework、Agent SDK，也没有调用服务端托管的文件或代码执行工具。

终端会实时显示模型阶段、可见正文和工具参数增量；List、Read、Write、Edit、Bash 使用不同卡片，执行状态和耗时持续更新。流式画面只负责反馈，真正的执行边界仍由完整响应决定：工具参数全部聚合、协议校验通过后，runtime 才会开始本地副作用。

当前主评测要求 Agent 从需求和公开测试出发，独立完成一个可在浏览器运行的 2048 游戏。一次固定条件的正式运行在 61.719 秒内完成 12 个 turn 和 15 次工具调用，独立 grader 的 21 项公开与隐藏测试全部通过，四个受保护输入文件没有变化。这是一条可复核的端到端样本，不代表 Nash 对任意仓库的总体成功率。

## 为什么这样设计

Nash 使用自由的 model-tool loop，不预设固定的“规划、编码、测试”图。测试结果和代码结构会改变后续动作，模型需要在每次 observation 后重新判断。自主性之外的约束交给 runtime：

- 文件只能访问工作区，真实路径和 symlink 都会检查。
- `.env*`、`.git`、`.nash` 等凭据或控制路径不会暴露给文件工具。
- 读取自动放行；写文件和 shell 命令默认需要审批。
- 命令有工作目录、超时、进程组终止、敏感环境变量剥离和输出上限。
- turn、工具数、token、总时长、重复失败都有硬预算。
- 每次运行写入 append-only JSONL，可检查，也可做无副作用界面回放。

```text
DeepSeek Chat Completions (SSE)
              |
              v
         ModelClient
          /       \
         v         v
  ephemeral UI   complete response
  status/cards          |
                       v
                  CodingAgent -----> EventBus -----> JSONL
                       |
                       v
                  ToolRegistry
            prepare -> approve -> execute
                       |
                       v
                    Workspace
```

流式 observer 是 best-effort 的展示通道，失败不能改变 Agent 的语义。完整响应聚合器才是权威状态；持久化 trace 只记录稳定的模型响应摘要和工具生命周期，不把每个 token 增量写入 JSONL。

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

可以为单次运行覆盖模型参数：

```bash
npm run dev -- run \
  --reasoning-effort low \
  --max-output-tokens 16384 \
  --workspace /path/to/project \
  "实现 README.md 中的任务并运行测试"
```

读取操作会自动执行。写入和命令会显示安全预览，并等待 `y`、默认拒绝的 `N`，或本会话后续全部放行的 `a`。`--yes` 会跳过审批，但 shell 没有 OS 级沙箱，只应在临时目录或容器中使用。

常用命令：

```bash
# 查看严格校验后的会话摘要和时间线
npm run dev -- inspect --workspace /path/to/project <session-id>

# 按记录时间重放终端事件；不会重新执行工具
npm run dev -- replay --workspace /path/to/project --speed 8 <session-id>

# 运行两个确定性评测
npm run eval:2048
npm run eval:stale-timer
```

构建和测试：

```bash
npm run check
npm run build
```

## 评测

### 2048 网页任务

`game-2048` 要求 Agent 交付完整网页，同时保持需求、依赖描述、启动脚本和公开测试不变。实现需要分离纯游戏引擎与浏览器控制层，覆盖合并规则、得分、胜负状态、键盘和指针输入、New Game、Best 持久化及响应式布局。

Agent 运行期间只能看到 7 项公开测试。停止后，runner 才复制 14 项 hidden tests，并复核四个输入文件的 SHA-256。正式样本结果为 `21/21`，详细指标和复现方式见 [评测记录](docs/evaluation.md)。视频另有一次从输入指令到浏览器操作的现场运行，用于展示真实交互，不替代独立 grader。

### stale-timer 代码修复

第二个 case 验证旧租约回调不能误删 replacement。固定提交连续五次，四次通过独立 grader，一次仍错误依赖 timer handle 唯一性。它用于说明重复运行、反例和失败分类的价值，不能外推为任意任务的成功率。

## 已知边界

- shell 作为宿主机进程运行，不具备安全沙箱隔离；审批只提供授权边界。
- shell pipeline 默认返回最后一个命令的退出码，`npm test | tail` 可能掩盖测试失败；关键验证应直接执行，或显式启用 pipefail。
- 流式 tool arguments 只用于即时展示；SSE 完整结束、参数聚合并校验后才会执行。
- JSONL replay 重放界面和事件，不重做文件、命令或网络副作用。
- 崩溃可能发生在副作用完成、`tool_finished` 尚未落盘的窗口，此时只能标记悬空调用并请求人工确认。
- 当前上下文策略保留完整消息历史，仅限制工具输出大小；还没有做 compaction。
- 2048 grader 能验证引擎、DOM 契约和关键样式，但静态检查不能代替逐像素视觉测试与多浏览器自动化。
- 相同用户下的恶意并发进程仍可能利用文件检查与执行之间的 TOCTOU 窗口。

更完整的威胁模型见 [安全边界](docs/security.md)。

## 代码与文档

- [`src/agent/coding-agent.ts`](src/agent/coding-agent.ts)：循环、预算、续写和终止。
- [`src/provider/deepseek-chat-client.ts`](src/provider/deepseek-chat-client.ts)：DeepSeek SSE、协议聚合和响应校验。
- [`src/cli/terminal-ui.ts`](src/cli/terminal-ui.ts)：流式状态和工具卡片。
- [`src/tools`](src/tools)：文件与命令工具。
- [`src/trace`](src/trace)：有序事件和 JSONL 持久化。
- [`src/session`](src/session)：inspect、replay 和 trace 校验。
- [架构说明](docs/architecture.md)
- [DeepSeek 接入](docs/provider-deepseek.md)
- [面试追问手册](docs/interview-guide.md)
- [视频脚本](docs/video-plan.md)
- [视频制作与验收](video/README.md)
- [题目要求与验收](docs/requirements.md)

## License

[MIT](LICENSE)
