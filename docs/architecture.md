# Nash 架构说明

## 设计结论

Nash 选择“自由循环 + 受约束 runtime”。模型在每次 observation 后决定下一步，runtime 只负责协议、权限、预算、执行和记录。真实编程任务的步骤会被测试结果和代码结构改变，固定 planner graph 容易把早期错误一直带下去。

这个选择介于三种常见路线之间：没有复制 Claude Code 的完整产品面，也没有把所有能力都交给一个自由 shell；核心规模接近精简 harness，同时保留审批、硬预算和可审计轨迹。面试时可以完整解释每条关键路径，也能录出清楚的两分钟演示。

## 主循环

```text
user task
   |
   v
CodingAgent ---- request ----> ModelClient ----> DeepSeek
   ^                               |
   |                               | assistant / tool calls
   |                               v
   +---- tool results ------- ToolRegistry
                                   |
                         prepare -> approve -> execute
                                   |
                                   v
                               Workspace

Every transition ----> EventBus ----> console + JSONL
```

一次 turn 先完成一个模型响应。响应没有工具调用时，runtime 检查 `finish_reason` 和正文，再决定是否接受 final answer。响应包含工具调用时，assistant message 会连同不透明的 `reasoning_content` 进入历史，随后工具按模型给出的顺序执行，结果也按原顺序写回。

DeepSeek 可以一次返回多个工具调用。Nash 当前串行执行整个 batch。这样能保持确定的副作用顺序，也避免两个并行编辑基于同一份旧文件。代价是独立读取无法并发，延迟会更高。以后若做并发，只会先放开无副作用的读取，并需要在事件中记录调度关系。

## 副作用提交边界

每个工具调用经过三个阶段：

1. `prepare` 严格解析 JSON、拒绝未知字段、检查类型和大小，并生成不含完整文件内容的安全预览。
2. `approve` 根据 `read / write / execute` effect 决定是否允许。交互模式自动允许读取，写入和命令默认拒绝。
3. `execute` 在工作区内执行，并把成功或结构化错误都转换成 tool result。

模型重试只发生在任何本地工具开始之前。provider 的 429、5xx、网络错误或超时可以重试；一旦某轮响应被接受并开始执行工具，后续请求失败不会回放这批副作用。这个边界提供的是“模型请求可重试、工具不因 HTTP 重试重复执行”，没有承诺跨进程 exactly-once。

批量工具调用会在执行前整体检查剩余工具预算。如果一个 batch 已经超过上限，runtime 不执行其中任何一个。通过预算检查后，前面的工具可能成功、后面的工具仍可能失败；结果会逐个记录，模型下一轮决定如何恢复。

## 模块边界

### ModelClient

Agent 只认识统一的 `Message`、`ToolDefinition`、`ToolCall` 和 `Usage`。DeepSeek 的字段名、HTTP 状态和 response schema 都留在 provider。新增其他厂商时不需要修改循环。

### ToolRegistry 与工具

`LocalTool` 有真实的多态需求：每个工具提供 schema、effect 和 `prepare`。registry 统一处理未知工具、参数错误、审批异常和执行异常。当前工具包括：

- `list_files`
- `read_file`
- `write_file`
- `edit_file`
- `run_command`

`edit_file` 只接受唯一的精确旧文本。文件已变化或匹配不唯一时会拒绝，让模型重新读取。创建文件采用临时文件、`fsync` 和 hard link，避免并发 create-only 写入互相覆盖。

### Workspace

路径检查同时处理词法路径和真实路径。已有文件通过 `realpath` 验证；新文件寻找最近的已存在父目录，再确认它的真实位置仍在工作区。`.env*` 凭据文件、`.git` 和 `.nash` 控制目录由文件工具直接拒绝，模板文件 `.env.example / sample / template` 仍可读取。

### EventBus

EventBus 在 `emit` 调用时对数据做 JSON snapshot，再把并发事件串成单调 sequence。FileEventSink 使用 `wx` 创建权限为 `0600` 的 JSONL 文件，每次追加后同步到磁盘。任一 sink 失败会变成 sticky failure，Agent 停止继续产生不可审计的副作用。

trace schema v1 对顶层字段做 exact-key 校验，并要求同一 session ID、从 1 开始连续递增的 sequence、规范 ISO 时间和合法终止位置。`inspect` 不会宽松吞掉未知字段。

## 终止与预算

Runtime 当前会返回以下 stop reason：

- `final_answer`
- `cancelled`
- `max_duration`
- `max_turns`
- `max_tool_calls`
- `token_budget`
- `repeated_tool_failure`
- `model_error`
- `incomplete_model_output`
- `content_filtered`
- `invalid_model_response`
- `runtime_error`
- `trace_error`

turn、工具调用、累计输入输出 token 和 wall-clock deadline 是硬预算。模型响应到达后、任何工具执行前再次检查 token 预算。相同工具名和语义等价 JSON 参数连续失败时，参数会先规范化再计算 SHA-256，避免模型只改空白或 key 顺序绕过重复失败上限。

## 上下文与 DeepSeek thinking

当前版本保留完整消息历史，工具输出在进入历史前已经有文件大小、行数和 head-tail byte 上限。DeepSeek thinking 模式返回的 `reasoning_content` 被当作 provider 要求的不透明状态：完整续传，不解析，不展示，也不把正文写进 trace。

完整历史让首版的正确性容易验证，也让 token 随 turn 增长。真实评测中 prompt cache 覆盖了大部分重复输入，但 cache 只能降低费用和推理开销，不能消除客户端传输、context 上限和隐私风险。后续 compaction 需要保证 tool call/result 成对、最新目标不丢失、未解决错误保留，并用评测证明摘要没有改写约束。

## 崩溃与 replay

执行工具前记录 `tool_started`，完成后记录 `tool_finished`。如果进程在两者之间崩溃，`inspect` 会显示 unfinished tool。文件系统副作用和 JSONL 无法原子提交，runtime 不能从悬空事件断定工具是否已经执行，恢复时也不能盲目重试写入或命令。

`replay` 只按事件时间重放终端视图，不读取模型，也不执行工具。执行级确定性 replay 需要工作区快照、依赖版本、环境和外部服务记录，当前版本没有提供。

## 明确不做的部分

首版不做多 Agent、向量数据库、IDE 插件、复杂 TUI、流式 tool call 和 OS 级沙箱。它们会扩大实现和演示的故障面。shell 命令仍是宿主机进程，`--yes` 只适用于隔离评测目录。完整威胁模型见 [`security.md`](security.md)。

## 技术栈

项目使用 TypeScript 和 Node.js 20.11 以上版本。runtime 优先使用 Node 标准库；测试使用 `node:test`，`tsx` 只负责开发期执行 TypeScript。DeepSeek 请求使用原生 `fetch`，没有引入模型 SDK。
