# DeepSeek 接入决策

这份文档记录 Nash 首个 provider 的协议和故障处理。信息按 2026 年 8 月 30 日的 DeepSeek 官方文档核对；模型名称和参数仍应在正式运行前复查。

## Chat Completions

Nash 直接调用 `POST /chat/completions`，没有使用 OpenAI SDK。当前配置支持 `deepseek-v4-flash`、`deepseek-v4-pro` 和原生 tool calls。Agent 只依赖统一的 `ModelClient`，模型名、endpoint、thinking 和输出上限都来自配置，也可由单次 `run` 命令覆盖。

开发和重复评测默认使用 `deepseek-v4-flash`，减少等待与费用。模型选择属于评测条件；切换模型会改变工具选择、耗时和输出，不能把不同配置的结果放在同一组统计中。

## 流式传输与提交边界

请求设置 `stream: true` 和 `stream_options.include_usage: true`。DeepSeek Chat Completions 以 SSE 发送增量，并用 `data: [DONE]` 结束。Nash 没有把网络 chunk 当成消息边界：UTF-8、SSE 行、多行 `data:`、JSON 和 tool call arguments 都可以分段到达。

`StreamingResponseAccumulator` 按 tool call index 聚合以下字段：

- 可见 `content`
- 不透明的 `reasoning_content`
- tool call ID、函数名和参数字符串
- `finish_reason` 与 usage

同时，best-effort observer 把正文、思考字符数和工具参数进度交给 TerminalUI。observer 抛错会被隔离，完整聚合结果不受影响。终端看到半段参数时，runtime 还没有解析或执行它；只有 `[DONE]` 到达、finish reason 与完整结构通过校验后，响应才提交给 Agent。

如果连接在 `[DONE]` 前结束，Nash 把它视为可重试网络错误。已经显示的临时进度会被下一次 attempt 取代，但没有本地工具需要回滚。非法 UTF-8、畸形 JSON、重复 call ID、非连续 index 或冲突的 finish reason 属于协议错误，不会盲目重试。

这个设计同时保留低首字延迟和明确的副作用边界。JSONL 不记录 token 级 delta，只记录聚合后的 `model_response` 摘要，避免把显示状态误当成持久状态。

## thinking 状态续传

DeepSeek thinking 模式返回 `reasoning_content`。官方文档要求：请求带 tools 时，后续轮次必须把 assistant message 中的该字段完整带回，即使那一轮没有实际工具调用，否则服务端可能返回 400。Nash 将它视为 provider 的不透明 continuation state：

- 原样存入 assistant message，并在后续轮次续传。
- Agent 不读取它，也不根据其中的文字做控制判断。
- 终端只显示累计字符数；JSONL 只记录字符数，不写入推理正文。

本地 mock 集成测试执行多轮完整 CLI，检查 assistant reasoning、tool call 和 tool result 是否完整续传。

## 请求与响应校验

Provider 在发送前完成统一消息到 DeepSeek wire schema 的转换。流结束后会检查：

- choice index、assistant role、content 和 finish reason 的类型。
- tool call index 从 0 连续，ID 非空且不重复。
- tool type 必须为 function，name 非空，arguments 保持完整字符串。
- usage token 是非负安全整数。
- 成功 stream 总量不超过 8 MiB，错误 body 读取不超过 64 KiB。

通过 provider 校验的 arguments 仍然只是一段字符串。ToolRegistry 会再次解析 JSON、拒绝未知字段，并执行类型、范围、路径和审批检查。模型原生 schema 能降低格式错误，不能代替本地授权。

## 输出上限续写

官方文档说明 `finish_reason=length` 表示输出达到 `max_tokens` 或上下文上限，内容可能被截断。Nash 不会把这类响应直接当成成功。

当响应只有 `reasoning_content`、没有可见正文和 tool call 时，模型可能只是用完了当前思考额度。Nash 会把这条 assistant 状态加入历史，再发送一条简短续写请求；默认最多一次，并计入新的 turn 与 token 预算。只要已经出现正文或 tool call，或者续写再次触顶，就以 `incomplete_model_output` 停止，避免猜测残缺参数。

输出续写是语义层的新请求，和传输层 retry 不同。前者保留完整模型状态并明确要求继续，后者只在当前响应尚未提交且没有本地副作用时重试同一请求。

## 超时和重试

请求 timeout 从发起 fetch 一直覆盖到 `[DONE]`。只有收到 response headers 不会清除 timer；body 永不结束仍会被中止。对应测试会模拟 headers 已到但 stream 不结束的情况。

400、401、402 和 422 通常需要修改请求、凭据或账户状态，自动重试没有帮助。408、429、500、502、503、504、网络中断和 `[DONE]` 缺失可按指数退避重试，并尊重有上限的 `Retry-After`。DeepSeek 的 `insufficient_system_resource` finish reason 也作为可重试 provider error 处理。

重试只包围当前模型请求。工具不在 retry block 中，因此 provider 失败不会重做已经执行的文件写入或命令。

## 真实运行数据

`game-2048` 的正式样本使用 `deepseek-v4-flash`、thinking enabled、reasoning effort low 和 16,384 output token 上限：

| 指标 | 数值 |
| --- | ---: |
| 独立 grader | 21 / 21 |
| wall-clock | 61.719 秒 |
| turns / tool calls | 12 / 15 |
| input / output tokens | 121,215 / 8,971 |
| prompt cache hit / miss | 113,408 / 7,807 |

约 93.6% 的 input token 命中 prompt cache。这个样本说明流式传输、thinking 续传、多轮工具、输出续写保护和外部 grader 能连成完整链路；它不构成跨任务成功率。完整历史仍带来随 turn 增长的输入成本，缓存不能替代 compaction。

## 密钥与 endpoint

密钥只从 `DEEPSEEK_API_KEY` 或兼容变量 `NASH_API_KEY` 读取。本地开发文件 `.env.local` 权限设为 `0600`，并被 Git 忽略。Agent 文件工具拒绝读取 `.env*` 凭据文件，命令环境会移除 API key、token、password、cookie 等常见敏感变量。

错误 body 在展示前会移除当前 API key 并转义终端控制字符。远程 endpoint 必须使用 HTTPS，只有 `localhost` 和 `127.0.0.1` 的 mock server 可以使用 HTTP。

## 官方资料

- [DeepSeek API 文档](https://api-docs.deepseek.com/zh-cn/)
- [Chat Completions API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)
- [Tool Calls](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)
- [Thinking Mode](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)
- [错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)
