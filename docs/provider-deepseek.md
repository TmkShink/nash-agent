# DeepSeek 接入决策

这份文档记录 Nash 首个 provider 的协议选择。信息按 2026 年 8 月 30 日的官方文档核对，模型能力和名称仍需在正式录制前复查。

## 首版使用 Chat Completions

Nash 通过 `POST /chat/completions` 调用 DeepSeek，不依赖 OpenAI SDK。Chat Completions 同时支持 `deepseek-v4-flash`、`deepseek-v4-pro` 和原生 tool calls，协议也便于以后接入其他兼容服务。Responses API 目前仍有模型与参数兼容差异，首版不额外维护第二套消息转换。

开发默认使用 `deepseek-v4-flash`，减少反复评测的等待和费用。正式视频可以把 `NASH_MODEL` 改为 `deepseek-v4-pro`，不改 Agent loop。模型名称不能写死在业务代码中。

## thinking 模式的消息不变量

DeepSeek 在 thinking 模式下返回 `reasoning_content`。只要请求包含 tools，后续请求就必须把此前 assistant message 中的 `reasoning_content` 原样带回；遗漏会导致 400。Nash 因此把它作为 provider 的不透明续传状态保存在消息历史中，Agent 不解析、不展示，也不把正文写进轨迹。

轨迹只记录 reasoning 的字符数、工具调用和可见答复。这样既能证明协议状态被保留，也不会把隐藏推理当作产品输出或调试依据。

## 本地仍要校验工具参数

官方文档明确说明，模型生成的 tool arguments 可能不是合法 JSON，也可能包含 schema 中没有的字段。即使以后启用 beta strict mode，本地 runtime 仍会做类型、范围、路径和副作用检查。服务端 schema 约束用于减少格式错误，不能替代执行边界。

## 重试范围

400、401、402 和 422 通常需要修改请求、密钥或账户状态，自动重试不会解决问题。429、500 和 503 可以在短暂退避后重试。网络中断也只在尚未收到完整模型响应时重试；工具一旦开始执行，就不会因为 provider 重试而重复触发。

## 密钥规则

密钥只从 `DEEPSEEK_API_KEY` 或兼容变量 `NASH_API_KEY` 读取。本地开发放在权限为 `0600` 的 `.env.local`，该文件被 Git 忽略。日志、JSONL、错误信息和配置摘要都不能包含密钥。远程 endpoint 必须使用 HTTPS，本地 mock server 才允许 HTTP。

## 官方资料

- [首次调用与模型名称](https://api-docs.deepseek.com/)
- [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)
