# DeepSeek 接入决策

这份文档记录 Nash 首个 provider 的协议和故障处理。信息按 2026 年 8 月 30 日的官方文档核对，正式录制前仍要复查模型名称和参数。

## Chat Completions

Nash 直接调用 `POST /chat/completions`，没有使用 OpenAI SDK。当前配置支持 `deepseek-v4-flash`、`deepseek-v4-pro` 和原生 tool calls。Agent 只依赖统一的 `ModelClient`，模型名和 endpoint 都来自配置。

开发与重复评测默认使用 `deepseek-v4-flash`，减少等待和费用。是否在正式视频改用 `deepseek-v4-pro` 要由稳定性实测决定，不能只因为名字更强就更换。视频需要可复现，临时切模型会改变工具选择、耗时和输出。

## 为什么先用非流式响应

首版设置 `stream: false`。一个完整 HTTP 响应构成清晰的模型提交点：只有 response schema、finish reason 和全部 tool calls 都通过校验后，Agent 才开始本地副作用。此时网络重试不会碰到“已经收到半个 tool call，是否执行过”的歧义。

流式输出可以降低首字等待，但 tool call arguments 可能跨 chunk，断线后还涉及 partial envelope、去重 ID 和断点恢复。两分钟视频中，终端动作摘要比逐字输出更重要，首版不为流式增加第二套状态机。

## thinking 状态续传

DeepSeek thinking 模式返回 `reasoning_content`。带 tools 的后续请求必须把此前 assistant message 中的该字段原样带回，否则服务端会返回 400。Nash 将它视为 provider 的不透明 continuation state：

- 原样存入 assistant message，并在后续轮次续传。
- Agent 不读取它，也不根据其中的文字做控制判断。
- 终端和 JSONL 只记录字符数，不写入推理正文。

本地 mock 集成测试会执行两轮完整 CLI：第一轮返回 reasoning 和 `write_file`，第二轮在返回 final 前检查 assistant reasoning、tool call 和 tool result 是否完整续传。

## 请求与响应校验

Provider 在发送前完成统一消息到 DeepSeek wire schema 的转换。收到响应后会检查：

- `choices[0]`、assistant role、content 和 finish reason 的类型。
- tool call ID 非空且不重复。
- tool type 必须为 function，name 非空，arguments 必须是字符串。
- usage token 是非负安全整数。
- 成功 body 不超过 8 MiB，错误 body 读取不超过 64 KiB。

通过 provider 校验的 arguments 仍然只是字符串。ToolRegistry 会再次解析 JSON、拒绝未知字段，并执行类型、范围、路径和审批检查。模型原生 schema 能降低格式错误，不能充当本地授权。

## 超时和重试

请求 timeout 从发起 fetch 一直覆盖到 body 完整读取。官方说明非流式请求可能先发送空白 keepalive 行，所以只在收到 response headers 时清除 timer 会留下永久挂起风险；对应测试专门模拟了 headers 已到、body 不结束的情况。

400、401、402 和 422 需要修改请求、凭据或账户状态，自动重试没有帮助。408、429、500、502、503、504 和网络中断可按指数退避重试，并尊重有上限的 `Retry-After`。DeepSeek 的 `insufficient_system_resource` finish reason 也按可重试 provider error 处理。

重试只包围当前模型请求。工具不会放在这个 retry block 中，因此 provider 失败不会重做已经执行的文件写入或命令。

## 真实运行数据

固定提交 `b537d34`、`deepseek-v4-flash`、thinking high 和相同预算连续运行五次，结果如下：

| 指标 | 数值 |
| --- | ---: |
| grader PASS | 4 / 5 |
| wall-clock p50 / p95 | 45.840 / 63.078 秒 |
| turns 中位数 | 8 |
| tool calls 中位数 | 12 |
| input / output tokens 合计 | 311,413 / 29,196 |
| prompt cache hit / miss 合计 | 283,008 / 28,405 |

输入 token 中约 90.9% 命中 prompt cache。这个数据说明完整历史在短任务上能得到较高缓存复用，也暴露了 turn 增长带来的上下文成本。缓存不是 compaction 的替代品。唯一失败来自模型违反 README 中的 handle 复用约束；provider 与协议链路正常，独立 grader 正确拒绝了它。

## 密钥与 endpoint

密钥只从 `DEEPSEEK_API_KEY` 或兼容变量 `NASH_API_KEY` 读取。本地开发文件 `.env.local` 权限设为 `0600`，并被 Git 忽略。Agent 文件工具拒绝读取 `.env*` 凭据文件，命令环境会移除 API key、token、password、cookie 等常见敏感变量。

错误 body 在展示前会移除当前 API key 并转义终端控制字符。远程 endpoint 必须使用 HTTPS，只有 `localhost` 和 `127.0.0.1` 的 mock server 可以使用 HTTP。

## 官方资料

- [首次调用与模型名称](https://api-docs.deepseek.com/)
- [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)
