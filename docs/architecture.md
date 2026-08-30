# Nash 架构说明

## 设计结论

Nash 选择“自由循环 + 受约束 runtime”。模型在每次 observation 后决定下一步，runtime 负责协议、权限、预算、执行和记录。真实编程任务的步骤会被测试结果和代码结构改变，固定 planner graph 容易把早期错误继续带入后续节点。

这个选择介于三种常见路线之间：没有复制 Claude Code 的完整产品面，也没有把所有能力交给一个自由 shell；核心规模接近精简 harness，同时保留实时反馈、审批、硬预算和可检查轨迹。关键路径都在仓库内，可以沿着一次模型请求、一个工具调用和一条 trace 解释到底。

## 主循环

```text
user task
   |
   v
CodingAgent ---- request ----> ModelClient ---- SSE ----> DeepSeek
   ^                               |       \
   |                               |        +--> TerminalUI progress
   |                               v
   +---- tool results ------- complete response
                                   |
                                   v
                              ToolRegistry
                         prepare -> approve -> execute
                                   |
                                   v
                               Workspace

Stable transitions ----> EventBus ----> terminal + JSONL
```

一次 turn 对应一个经过完整校验的模型响应。响应没有工具调用时，runtime 检查 `finish_reason` 和正文，再决定是否接受 final answer。响应包含工具调用时，assistant message 会连同不透明的 `reasoning_content` 进入历史，随后工具按模型给出的顺序执行，结果也按原顺序写回。

DeepSeek 可以一次返回多个工具调用。Nash 当前串行执行整个 batch，以保持确定的副作用顺序，并避免两个编辑基于同一份旧文件。代价是独立读取无法并发，延迟会更高。若以后放开并发，应先限制在无副作用读取，并在事件中记录调度关系。

## 流式反馈与语义提交

SSE 流同时进入两个用途不同的通道：

- `StreamingResponseAccumulator` 按 choice index 聚合 `content`、`reasoning_content` 和每个 tool call 的 ID、名称、参数。这是权威状态。
- `ModelStreamObserver` 把增量交给 TerminalUI。它只影响即时画面，异常会被隔离，不能改变 Agent 的控制流。

UTF-8 字符、SSE 行和 JSON payload 都可能跨网络 chunk。解析器分别维护字节解码、SSE `data:` 行和响应字段状态，直到收到 `[DONE]` 才提交。流提前结束会作为可重试网络错误处理；JSON 无效、索引不连续、ID 重复或 finish reason 冲突属于协议错误。

工具参数增量只用于显示“正在准备什么”。Nash 不解析半段 JSON，也不会根据流式片段启动工具。只有 `[DONE]` 到达、完整响应通过 provider 校验、整批工具预算充足后，调用才会进入本地执行阶段。网络重试因此不会遇到“半个 tool call 已经执行”的状态。

TerminalUI 会即时写出可见正文；思考阶段只显示累计字符数，不展示原始思维链。频繁状态变化按 80ms 间隔重绘，阶段切换立即刷新，避免每个 token 都触发终端改写。非 TTY 输出保留稳定的语义事件，不输出依赖光标控制的动画。

流式 delta 不进入 JSONL。trace 记录完整的 `model_response` 摘要、最终 tool calls 和工具生命周期，避免 token 级事件放大会话文件，也让 inspect 和 replay 只依赖稳定状态。

## 副作用提交边界

每个工具调用经过三个阶段：

1. `prepare` 严格解析 JSON、拒绝未知字段、检查类型和大小，并生成不含完整文件内容的安全预览。
2. `approve` 根据 `read / write / execute` effect 决定是否允许。交互模式自动允许读取，写入和命令默认拒绝。
3. `execute` 在工作区内执行，并把成功或结构化错误都转换成 tool result。

模型重试只发生在任何本地工具开始之前。provider 的 408、429、部分 5xx、网络错误、流提前结束或超时可以重试；一旦某轮响应被接受并开始执行工具，后续请求失败不会回放这批副作用。这个边界提供“模型请求可重试、工具不因 HTTP 重试重复执行”，没有承诺跨进程 exactly-once。

批量工具调用会在执行前整体检查剩余工具预算。一个 batch 超过上限时，其中任何工具都不会执行。通过预算检查后，前面的工具可能成功、后面的工具仍可能失败；结果逐个记录，模型下一轮决定怎样恢复。

## 模块边界

### ModelClient

Agent 只认识统一的 `Message`、`ToolDefinition`、`ToolCall`、`Usage` 和可选 `ModelStreamObserver`。DeepSeek 的字段、SSE、HTTP 状态和 response schema 都留在 provider。新增其他厂商时不需要修改循环。

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

EventBus 在 `emit` 调用时对数据做 JSON snapshot，再把并发事件串成单调 sequence。FileEventSink 使用 `wx` 创建权限为 `0600` 的 JSONL 文件，每次追加后同步到磁盘。当前任一稳定事件 sink 失败都会变成 sticky failure，Agent 停止继续产生无法记录的副作用；流式 observer 不经过这条严格路径。

trace schema v1 对顶层字段做 exact-key 校验，并要求同一 session ID、从 1 开始连续递增的 sequence、规范 ISO 时间和合法终止位置。`inspect` 不会宽松吞掉未知字段。

## 终止、预算与输出续写

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

turn、工具调用、累计输入输出 token 和 wall-clock deadline 是硬预算。模型响应到达后、任何工具执行前会再次检查 token 预算。相同工具名和语义等价 JSON 参数连续失败时，参数先规范化再计算 SHA-256，模型只改变空白或 key 顺序不能绕过重复失败上限。

`finish_reason=length` 有两种含义：响应可能真的被截断，也可能只消耗完当前思考额度。只有“存在 reasoning、没有可见正文、没有 tool call”时，Nash 才会追加一个明确的续写请求，且最多一次。其他 `length` 响应直接以 `incomplete_model_output` 停止。这里是新的语义 turn，会计入预算；它与同一 HTTP 请求的传输重试是两套机制。

## 上下文与 DeepSeek thinking

当前版本保留完整消息历史，工具输出在进入历史前已有文件大小、行数和 head-tail byte 上限。DeepSeek thinking 模式返回的 `reasoning_content` 被当作 provider 要求的不透明状态：完整续传，不解析，不展示，也不把正文写进 trace。

完整历史便于验证消息配对，也会让 token 随 turn 增长。评测中 prompt cache 覆盖了大部分重复输入，但 cache 只能降低部分费用和推理开销，不能消除客户端传输、context 上限和隐私风险。后续 compaction 需要保证 tool call/result 成对、最新目标不丢失、未解决错误保留，并用评测证明摘要没有改写约束。

## 崩溃与 replay

执行工具前记录 `tool_started`，完成后记录 `tool_finished`。如果进程在两者之间崩溃，`inspect` 会显示 unfinished tool。文件系统副作用和 JSONL 无法原子提交，runtime 不能从悬空事件断定工具是否已经执行，恢复时也不能盲目重试写入或命令。

`replay` 只按事件时间重放终端视图，不读取模型，也不执行工具。执行级确定性 replay 需要工作区快照、依赖版本、环境和外部服务记录，当前版本没有提供。

## 明确不做的部分

当前版本不做多 Agent、向量数据库、IDE 插件、MCP 市场、全屏 TUI 和 OS 级沙箱。这些能力会扩大实现和演示的故障面。shell 命令仍是宿主机进程，`--yes` 只适用于隔离评测目录。完整威胁模型见 [`security.md`](security.md)。

## 技术栈

项目使用 TypeScript 和 Node.js 20.11 以上版本。runtime 优先使用 Node 标准库；测试使用 `node:test`，`tsx` 只负责开发期执行 TypeScript。DeepSeek 请求使用原生 `fetch`，没有引入模型 SDK。
