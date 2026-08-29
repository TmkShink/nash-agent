# 题目约束与验收标准

这份文档把原题转换为可核对的交付清单。2026 年 8 月 30 日已重新检查仓库外的原始 PDF，包括第二页的面试说明。

## 原题硬约束

- 独立设计并实现一个 Coding Agent，能与大语言模型交互，自主读写文件、执行命令并完成真实编程任务。
- 不得套壳现成 Agent 产品，也不得使用 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等 Agent 框架或 SDK。
- 可以使用模型厂商客户端、OpenAI 兼容网关和模型原生 tool calling，但不能依赖服务端托管的代码执行或文件工具。
- 对话历史、上下文管理、工具定义与本地执行、模型输出解析、循环终止和错误处理等重要逻辑需要自行实现。
- API key 只能来自环境变量或未入库配置，不能出现在仓库、`README.txt` 或视频中。密钥一旦误提交，需要立即作废并更换。
- 截止时间为 2026 年 9 月 2 日 24:00，北京时间。截止后不能再向仓库推送新提交。

## 三项提交物

1. 题目发布后新建的公开 Git 仓库，保留完整提交历史，不能压缩或改写已经推送的历史。
2. 不超过 1000 个汉字的 `README.txt`，写明仓库地址、运行方式和特色功能。
3. 不超过 2 分钟、200 MB 的 mp4 视频，展示 Agent 完成真实编程任务，并简要说明功能实现。

最终只提交一个以真实姓名命名的 zip 文件，压缩包内包含 `README.txt` 和视频。原题给出的提交表单允许重复提交，以最后一次为准。

## 实现对照

| 原题关注点 | Nash 中的实现 | 证据 |
| --- | --- | --- |
| 对话与上下文 | 完整 message history，保留 DeepSeek thinking 续传字段 | `src/agent`、`src/provider` |
| 工具定义与本地执行 | 五个本地工具，严格参数解析，工作区路径策略 | `src/tools`、`src/workspace` |
| 模型输出解析 | 手写 Chat Completions 请求和响应校验 | `src/provider/deepseek-chat-client.ts` |
| 循环与终止 | 自由工具循环、七类硬预算、明确 stop reason | `src/agent/coding-agent.ts` |
| 错误处理 | provider、协议、审批、工具、命令和 trace 错误分层 | 对应单元测试与 JSONL 事件 |
| 真实任务 | stale-timer 五次固定提交评测，`4/5` 通过；成功样本 grader `7/7` | `evals/cases/stale-timer`、`docs/evaluation.md` |

项目没有引入模型厂商 SDK，provider 直接使用 Node 原生 `fetch`。这比题目要求更严格，但属于实现选择，不作为额外规则要求其他方案。

## 提交前检查

- [ ] GitHub 仓库保持 public，remote 为 `https://github.com/TmkShink/nash-agent`。
- [ ] `git status` 干净，最终提交和 push 早于截止时间。
- [ ] 对 Git 历史、已跟踪文件、`README.txt` 和视频画面做一次密钥扫描。
- [ ] `README.txt` 少于 1000 个汉字，运行命令已经在干净环境验证。
- [ ] 视频时长不超过 2 分钟，mp4 文件不超过 200 MB。
- [ ] 视频中的运行结果来自真实会话；剪辑只裁停顿或加速，不伪造成功。
- [ ] 压缩包以报名使用的真实姓名命名，并且只放 `README.txt` 和视频。

## 面试验收

原题说明会先现场播放视频，再由候选人介绍设计并回答问题。评委重点判断两件事：是否理解 Agent 为什么这样运转，能否为设计决策辩护。因此最终准备不能只记功能列表，还要能说清故障模型、替代方案和当前边界。对应答案整理在 [`interview-guide.md`](interview-guide.md)。
