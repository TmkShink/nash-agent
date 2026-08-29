# 面试追问手册

回答顺序固定为三步：先说 Nash 当前怎么做，再解释为什么这样取舍，最后主动给出失效条件。没有实现的能力直接说明，不把计划说成现状。

## 一分钟介绍

Nash 是我用 TypeScript 从零实现的 Coding Agent。核心是自由的 model-tool loop：DeepSeek 根据当前对话选择读文件、改文件或执行命令，runtime 负责严格解析参数、限制工作区、审批副作用、控制预算，并把每次状态转换写入 JSONL。

我没有追求 Claude Code 那样完整的产品面，也没有只做一个把 shell 暴露给模型的最小循环。Nash 的重点是三条可解释边界：第一，provider 重试不能重放本地副作用；第二，文件和命令必须经过 `prepare → approve → execute`；第三，失败、预算和崩溃窗口必须能从 trace 中看见。

真实评测里，DeepSeek 修复了一个旧计时回调误删新值的竞态。第一版修复通过公开测试，但 hidden grader 用 timer handle 复用击穿了它；强化契约后，模型改用 generation，公开和 hidden 测试 `7/7` 通过。这个过程也说明我的 eval 会检验实现依赖的假设，不只看演示是否成功。

## 方案选择

**问：为什么选自由循环，没有先生成完整计划再按图执行？**

测试错误、搜索结果和代码结构都会改变后续动作。预先生成的计划很快会过时，还可能把错误假设固化到后面的节点。Nash 让模型在每个 observation 后重新选择动作，runtime 只约束权限、预算和终止。固定 planner graph 更适合步骤稳定、领域规则明确的流程；通用代码修改的分支数量不固定。

**追问：自由循环不会漫无目的地调用工具吗？**

会有这个风险，所以约束不能只写进 prompt。Nash 有 turn、工具数、token、wall-clock 和重复失败预算。相同工具和语义等价 JSON 参数连续失败时，先规范化参数再计算 hash；只改变空白或 key 顺序无法逃过上限。trace 可以继续区分是模型没有进展，还是工具反馈不够。

**问：为什么没有做 Claude Code 那样大而全？**

题目考查的是能否解释 Agent 为什么运转。完整 TUI、IDE 集成、多 Agent、MCP 市场和远程 sandbox 会扩大代码面，也会稀释核心决策。Nash 借鉴精简 harness 的自由循环和 pi 风格的小核心，再补上审批、预算、审计和 deterministic eval。现在每个关键路径都能在面试里从代码讲到底。

**问：为什么不用 LangChain 或 Agent SDK？**

原题明确禁止。更重要的是，本项目要展示的正是框架通常隐藏的部分：消息历史、thinking 续传、tool call 解析、执行边界、重试和终止条件。Provider 使用原生 `fetch`，工具和状态机都在仓库内。

## Agent 状态机

**问：一轮的提交点在哪里？**

非流式模型响应完整到达并通过 schema 校验后，才算模型提交。没有 tool call 时检查 finish reason 和 final content；有 tool call 时先检查整批工具预算，再把 assistant message 加入历史并依次执行。每个 tool result 按原 call ID 写回。

**问：DeepSeek 为什么需要保存 `reasoning_content`？**

thinking 模式下，DeepSeek 要求后续工具轮次把 assistant 的 `reasoning_content` 原样传回，遗漏会得到 400。Nash 把它当作不透明 continuation state，只存储和续传，不解释、不显示，trace 只记字符数。控制逻辑不能依赖隐藏推理文本。

**问：为什么先做非流式？**

非流式给出完整 tool-call envelope，网络重试边界容易证明。流式 tool arguments 可能跨 chunk，断线后要处理 partial JSON、call ID 去重和是否已经执行。当前视频更需要稳定的动作时间线，首字延迟收益不够覆盖这套复杂度。

**问：finish reason 和正文冲突怎么办？**

runtime 不猜。`length` 映射为 incomplete，`content_filter` 单独终止；finish reason 是 `tool_calls` 但没有 call，或有 call 却不是 `tool_calls`，都视为无效响应。正文为空且没有工具也不会当成成功。

## 重试与 exactly-once

**问：怎样防止网络重试重复写文件？**

模型请求的 retry loop 只包围 provider call，工具执行在 loop 外。响应尚未完整收到时，429、5xx、网络错误和 timeout 可以重试；一旦接受响应并开始工具，本地副作用不会因为下一次 HTTP 失败而重放。

**追问：这能保证 exactly-once 吗？**

不能。进程可能在写文件完成后、`tool_finished` 落盘前崩溃。trace 只会留下 started，无法知道副作用是否完成。跨进程 exactly-once 需要事务存储、幂等 key 或工具自己的确认协议。当前恢复策略应停下来让用户检查，不能自动重试非幂等工具。

**问：模型一次返回三个工具，第二个失败怎么办？**

整批工具先做数量预算检查，超预算时一个都不执行。通过后按顺序执行；第一个成功、第二个失败、第三个仍会继续执行，每个结果按调用顺序写回，下一轮模型看到完整 batch。这里提供确定的顺序，没有跨工具事务。若未来需要 all-or-nothing，只能为特定工具设计预检和补偿，通用 shell 无法回滚。

**问：为什么不并行执行多个 tool call？**

并行写入会引入旧读、覆盖和不确定顺序。首版串行执行，优先保证可解释和可重放的事件顺序。以后可以先并行纯读取，但需要 effect-aware scheduler，并明确多个结果仍按原 call 顺序进入消息。

## 工具设计

**问：为什么是 `prepare → approve → execute`？**

审批前必须先知道请求是否合法，也要生成不会把完整写入内容刷到终端的预览。`prepare` 只解析和检查，不产生副作用；`approve` 只回答授权；`execute` 才触碰文件或启动进程。这样拒绝请求时不会留下半完成状态。

**问：tool arguments 已经通过模型的 JSON Schema，为什么还要本地检查？**

模型输出仍可能是非法 JSON、带未知字段、超范围整数或越界路径。服务端 schema 是生成约束，runtime schema 是信任边界。即使服务端提供 strict mode，本地授权和路径检查也不能删除。

**问：为什么编辑使用唯一精确替换？**

模型通常基于刚读到的上下文修改代码。旧文本不存在说明上下文过期，出现多次说明定位不明确，两种情况都拒绝并要求重新读取。整个文件覆盖更简单，但更容易抹掉用户并行修改。创建新文件仍使用完整内容，覆盖已有文件则需要显式 `overwrite=true`。

**追问：精确替换也有竞态吧？**

有。工具读取并验证后，到原子 rename 之间仍可能有人修改目标。当前实现会在读取后检查大小和编码，并用临时文件同步后替换，但没有 compare-and-swap inode 或内容 hash。面对并发编辑器，可以把预期文件 hash 加入参数，并在提交前再次验证。

**问：为什么不用一个 shell 工具包办所有操作？**

专用文件工具能返回稳定的路径、编码、大小和 stale-context 错误，也能自动允许低风险读取。全交给 shell 会让边界依赖命令文本和 prompt。Nash 仍保留 shell 处理构建、测试和复杂搜索，因为不可能为所有开发工具重写专用接口。

## 安全

**问：命令黑名单能阻止危险操作吗？**

不能。shell 可以重定向、启动解释器、编码命令或创建子进程。Nash 的命令边界是人工审批和外部隔离；timeout、输出上限和环境变量剥离负责缩小事故，不构成沙箱。`--yes` 只用于 runner 自动创建的 fixture。

**问：路径检查如何防 symlink 越界？**

词法检查拒绝绝对路径和 `..` 越界，已有路径再用 `realpath` 验证。新文件寻找最近的已存在父目录，检查真实位置，创建父目录后再检查一次。安全名字的 symlink 指向 `.env.local` 时，第二次按真实目标路径执行凭据策略。

**追问：是否还有 TOCTOU？**

有。检查和最终 open 不是同一个 descriptor-relative 原子操作，同一用户下的恶意进程可以竞争替换路径。严肃多租户场景需要容器或基于 `openat` 的文件能力系统，不能把当前 workspace jail 说成强隔离。

**问：API key 怎样保护？**

密钥只在未跟踪、`0600` 的 `.env.local` 或进程环境中。文件工具拒绝 `.env*` 凭据文件；命令子进程移除 API key、token、password、cookie、SSH agent 等变量；provider 错误展示前按当前 key 做替换。trace 仍可能记录用户主动放进任务或命令输出里的秘密，所以分享前要审查。

**问：如何防工具输出中的 prompt injection？**

system prompt 明确普通文件和命令输出是数据，不能覆盖用户或 system 指令。真正可依赖的仍是 runtime：schema、路径、审批和预算。Prompt 不能提供形式化隔离。当前没有 taint tracking；处理不可信仓库时应逐次审批并在容器中运行。

## Trace、inspect 与 replay

**问：为什么选 JSONL？**

它可以逐事件追加，崩溃时保留此前记录，也方便人读和脚本处理。EventBus 在 emit 时做 JSON snapshot，用 promise tail 保证 sequence 单调；文件 sink 每次写后 sync。代价是吞吐较低，但 Agent 的模型延迟远高于单次 fsync，首版更重视审计完整性。

**问：trace 写失败为什么让 Agent 停止？**

如果审计已经失效还继续执行副作用，最终无法解释系统做过什么。sink failure 会变成 sticky，后续 emit 继续失败，Agent 返回 `trace_error`。Console sink 也属于 EventBus；生产版可以把 UI failure 降级，但当前选择了更严格的一致性。

**问：JSONL 能做确定性 replay 吗？**

当前 replay 只重放 UI 事件，明确不会执行工具。执行级 replay 还需要初始工作区快照、依赖版本、环境、时间和外部服务响应。把两者都叫 replay 会误导，所以 CLI 帮助里写明无副作用。

**问：trace 能证明没有被篡改吗？**

不能。权限是 `0600`，schema 和 sequence 会校验，但拥有本地写权限的人可以离线改文件。若用于外部证明，需要 hash chain、签名和可信时间源。

## 预算和上下文

**问：token 已经超预算，为什么请求还是发出去了？**

下一轮实际 usage 在响应前无法精确知道。Nash 在响应回来后累计 usage，并在任何工具副作用前检查上限，所以可能为最后一个响应付费，但不会让超预算响应继续操作本地。更严格的费用预算需要预估输入 token、设置 provider max tokens 和实时价格表。

**问：当前为什么没有 context compaction？**

先保证消息协议和 tool call/result 配对正确。完整历史配合有界工具输出容易验证，真实评测也有 91.3% prompt cache hit。缺点是 input 快速增长，第二轮 10 turns 累计 72,173 input tokens。Compaction 需要保留最新目标、未解决错误、tool 配对和 DeepSeek reasoning 续传，还要用差分 eval 证明摘要没有改变约束。

**问：prompt cache 命中高，是否不用 compaction？**

仍然需要。缓存主要影响费用和服务端计算，不能消除网络传输、context window、长历史干扰和隐私保留问题。命中率也由 provider 决定，不能作为 runtime 正确性的前提。

## 评测

**问：怎样区分模型问题和 harness 问题？**

固定模型、prompt、初始 fixture、预算和 grader，重复运行并比较成功率、turn、工具数、耗时和失败分类。模型从未提出正确行动，偏向模型或上下文；正确行动被参数层误拒、工具反馈被截断到无法使用、reasoning/tool result 没有续传，偏向 harness。外部 grader 必须独立于 final answer。

**问：hidden grader 会不会只是你事后加规则让第一版失败？**

新增的是 README 已经暗含但未覆盖的 scheduler 契约：取消对已出队 callback 无效，handle 在不再代表可取消任务后可以复用。第一版用 handle 充当 generation，依赖了未声明的永久唯一性。先用反例验证漏洞，再把契约写清并重跑，第二版使用 generation 通过 `7/7`。评测变严的历史被保留，没有删除第一次结果。

**问：一次演示成功能说明什么？**

只能证明这一条端到端链路在给定模型、fixture 和预算下成功。正式视频前要至少重复五次，报告成功率和延迟分布。更多能力需要加入不同任务族，例如跨文件接口修改、依赖错误和大输出截断，不能从一个 cache case 外推。

**问：如何防模型修改测试骗过 grader？**

runner 在执行前后对 README、package、tsconfig 和公开测试做 SHA-256 对比。hidden grader 在 Agent 结束后才复制进 workspace。它仍不是抗恶意模型的强隔离；模型可以改测试 runner 或源代码做环境探测。严肃 benchmark 应在独立容器中挂载只读 grader。

## 如果继续做

**问：下一步最值得加什么？**

优先级是：可复现任务集和统计报告、context compaction、容器化 command runner。多 Agent 和复杂 TUI 排在后面，因为它们不会先解决当前最重要的正确性、成本和隔离问题。

**问：如果要支持远程团队仓库，架构哪里会变化？**

ModelClient 和 CodingAgent 可以保留。Workspace 要换成 snapshot 或 worktree 管理；command tool 进入容器；approval 变成有身份和审计的 policy service；EventSink 写入持久存储并带 hash chain；外部副作用需要 idempotency key。不能直接把本地 `--yes` 搬到服务端。
