# 面试追问手册

回答顺序固定为三步：先说 Nash 当前怎么做，再解释为什么这样取舍，最后主动给出失效条件。没有实现的能力直接说明，不把计划说成现状。

## 一分钟介绍

Nash 是我用 TypeScript 从零实现的 Coding Agent。核心是自由的 model-tool loop：DeepSeek 根据当前上下文选择读文件、改文件或执行命令，runtime 负责解析流式响应、限制工作区、审批副作用、控制预算，并把稳定的状态转换写入 JSONL。

终端能实时显示模型阶段、可见正文和不同类型的工具卡片，但流式画面不等于执行提交。SSE 完整结束、tool arguments 聚合并校验通过后，Nash 才会执行工具。这样既有及时反馈，也保留清晰的重试和副作用边界。

主评测要求 Nash 从空白工作区完成一个 2048 网页。Agent 运行时只能看到需求和 7 项公开测试，停止后才加入 14 项 hidden tests。正式样本在 61.7 秒内完成 12 个 turn、15 次工具调用，最终 `21/21`，四个受保护输入文件没有变化。这个结果证明固定任务上的端到端链路成立，不代表任意仓库的总体成功率。

我会重点解释三条边界：流式反馈与权威状态分开；provider 重试不能重放本地副作用；模型自称完成必须再经过独立 grader。

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

收到 SSE 的 `[DONE]`，且聚合后的 response schema、finish reason 和全部 tool calls 都通过校验，才算模型提交。没有 tool call 时检查 final content；有 tool call 时先检查整批工具预算，再把 assistant message 加入历史并依次执行。每个 tool result 按原 call ID 写回。

**问：DeepSeek 为什么需要保存 `reasoning_content`？**

thinking 模式下，DeepSeek 要求后续工具轮次把 assistant 的 `reasoning_content` 原样传回，遗漏会得到 400。Nash 把它当作不透明 continuation state，只存储和续传，不解释、不显示，trace 只记字符数。控制逻辑不能依赖隐藏推理文本。

**问：tool call arguments 被拆到很多 chunk，怎样保证拼接正确？**

不能按网络 chunk 解析 JSON。Nash 先用增量 UTF-8 decoder 处理断开的多字节字符，再按 SSE 空行分发事件，最后按 `tool_call.index` 分别累加 ID、name 和 arguments。流结束后检查 index 从 0 连续、ID 非空且不重复，再把完整 arguments 交给 ToolRegistry 解析。测试会覆盖 UTF-8、SSE 行、多个交错 tool calls 和参数跨 chunk 的情况。

**追问：为什么流里已经看见完整 JSON，还要等 `[DONE]`？**

因为后续 chunk 仍可能追加参数、改变 finish reason，连接也可能在服务端正式提交前中断。以“当前看起来能 parse”为边界会把传输状态误当成协议状态。Nash 在 `[DONE]` 前只展示进度，不执行副作用。

**问：SSE 中断时，用户已经看到的正文怎么办？**

这段正文是 provisional UI。TerminalUI 会显示本次 attempt 失败和 retry，权威历史里不会加入残缺响应。这样可能出现少量视觉回退，但不会让半条 assistant message 或半个 tool call 污染状态。若产品要求完全无回退，可以先缓冲正文，代价是失去逐字反馈。

**问：为什么 ModelStreamObserver 失败不能让 Agent 停止？**

observer 只负责即时反馈；终端不支持光标控制、输出 pipe 关闭或 UI 代码出错，都不应改变编码任务结果。accumulator 不依赖 observer，回调异常会被吞掉。稳定事件进入 EventBus 后属于另一条路径，trace sink 失败会停止 Agent，因为此后继续执行副作用会失去记录。

**问：为什么不把每个 delta 都写进 JSONL？**

token 级事件会显著放大文件和 fsync 次数，也把刷新频率耦合进 trace schema。inspect 和恢复判断只需要完整模型响应、最终 tool calls 和工具生命周期。Nash 因此把 delta 定义为临时显示状态，聚合后的 `model_response` 才是持久状态。代价是 replay 不能逐 token 还原原始输出速度。

**追问：流式输出有 backpressure 吗？**

状态行按 80ms 节流，避免每个 reasoning delta 都重绘；可见正文仍直接写终端，当前没有为超长正文建立完整的异步 backpressure 队列。8 MiB response cap 能限制内存和协议输入，不能完全替代 stdout 流控。这是当前 UI 的边界，服务化时应让 observer 返回可等待结果，或在独立 ring buffer 中降采样显示事件。

**问：finish reason 和正文冲突怎么办？**

runtime 不猜。`length` 通常映射为 incomplete，只有窄条件下允许一次 reasoning-only 续写；`content_filter` 单独终止。finish reason 是 `tool_calls` 但没有 call，或有 call 却不是 `tool_calls`，都视为无效响应。正文为空且没有工具也不会当成成功。

**追问：模型只输出了 reasoning，随后因为长度上限停止，为什么不立刻失败？**

这可能是思考额度用完、最终动作还没开始。Nash 只在“有 reasoning、无正文、无 tool call”的窄条件下追加一次明确续写请求，并把它计为新的 turn。已经出现残缺正文或工具参数时不续写，避免把两段语义不明的输出拼成一次调用。传输 retry 重做未提交的同一请求，语义续写保留前一条 assistant 状态，两者不能混用。

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

**追问：为什么有时 `npm test | tail` 显示 exit 0，前面的测试其实失败了？**

shell pipeline 默认返回最后一个命令的退出码，`tail` 成功会掩盖 `npm test` 的失败。Nash 如实记录 shell 返回值和完整的有界输出，不根据文本猜退出状态。关键验证应直接运行命令，或显式启用 pipefail；后续可以在检测到 pipeline 时增加警告，但不能把启发式文本匹配当成可靠状态。

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

如果稳定事件无法持久化还继续执行副作用，最终无法解释系统做过什么。sink failure 会变成 sticky，后续 emit 继续失败，Agent 返回 `trace_error`。流式进度走独立 observer，显示失败会降级；终端中的稳定事件仍属于 EventBus，当前与文件 sink 共享严格策略。生产版可以再把 console sink 和 durable sink 分组，只有持久化失败才阻止执行。

**问：JSONL 能做确定性 replay 吗？**

当前 replay 只重放 UI 事件，明确不会执行工具。执行级 replay 还需要初始工作区快照、依赖版本、环境、时间和外部服务响应。把两者都叫 replay 会误导，所以 CLI 帮助里写明无副作用。

**问：trace 能证明没有被篡改吗？**

不能。权限是 `0600`，schema 和 sequence 会校验，但拥有本地写权限的人可以离线改文件。若用于外部证明，需要 hash chain、签名和可信时间源。

**追问：既然不保存 reasoning 正文，能否从 trace 恢复会话继续跑？**

当前不能保证。inspect 和 replay 的目标是检查稳定事件，不是进程恢复。DeepSeek 带 tools 的后续请求可能需要完整 `reasoning_content`，而 trace 只记字符数；悬空工具也无法仅凭 started 事件判断副作用是否完成。若要支持 resume，需要单独的加密 checkpoint，保存完整 message state、workspace revision、provider 配置和 pending action，并对非幂等工具要求人工确认。

**问：线上应该看哪些指标？**

顶层指标是独立 grader 或用户验收通过率，不能用 final answer 率代替。诊断指标包括 time-to-first-feedback、每 turn 延迟、模型 retry、tool error、重复失败停止、token 与 cache、人工拒绝率、预算终止率和悬空工具数。指标要按模型、版本、任务族和预算切分；只看平均耗时会掩盖长尾与失败样本。

## 预算和上下文

**问：token 已经超预算，为什么请求还是发出去了？**

下一轮实际 usage 在响应前无法精确知道。Nash 在响应回来后累计 usage，并在任何工具副作用前检查上限，所以可能为最后一个响应付费，但不会让超预算响应继续操作本地。更严格的费用预算需要预估输入 token、设置 provider max tokens 和实时价格表。

**问：当前为什么没有 context compaction？**

先保证消息协议和 tool call/result 配对正确。完整历史配合有界工具输出容易验证；2048 正式样本约 93.6% 的 input token 命中 prompt cache。缺点是 input 仍会快速增长，该样本 12 个 turn 已累计 121,215 input token。Compaction 需要保留最新目标、未解决错误、tool 配对和 DeepSeek reasoning 续传，还要用差分 eval 证明摘要没有改变约束。

**追问：如果现在让你实现 compaction，边界放在哪里？**

只在一次完整模型响应和整批 tool results 都写回后压缩，不能切在悬空 tool call 中间。保留 system、原始用户目标、最近未解决的错误、当前文件事实和最近若干原始轮次；更早历史转成带来源的结构化摘要。DeepSeek 带 tools 时要求续传 reasoning，因此需要在压缩点结束当前用户交互段，或确认新请求不再依赖被删掉的 thinking 状态。上线前用同一任务集做 full-history 与 compacted-history 配对实验，重点检查约束遗漏和重复工具调用。

**追问：摘要本身被模型写错怎么办？**

摘要不能成为唯一事实源。文件内容可重新读取，测试结果可重新执行，用户约束应保留原文或结构化字段；摘要只压缩可再生的过程信息。可以记录摘要覆盖的 sequence 区间和 source hash，便于定位偏差，但 hash 只能证明来源没换，不能证明摘要语义正确。

**问：prompt cache 命中高，是否不用 compaction？**

仍然需要。缓存主要影响费用和服务端计算，不能消除网络传输、context window、长历史干扰和隐私保留问题。命中率也由 provider 决定，不能作为 runtime 正确性的前提。

**问：工具输出被截断后，模型会不会基于残缺信息做错？**

会。输出上限是资源保护，不代表残缺 observation 足以决策。文件读取提供行数、大小和 head-tail 信息，命令结果保留退出码与截断元数据；模型可以缩小范围重新读取或换用更精确的命令。当前 runtime 没有自动判断“截断是否影响任务”，因为这需要理解语义。评测应加入大输出 case，检查模型是否主动收窄观察范围。

## 评测

**问：怎样区分模型问题和 harness 问题？**

固定模型、prompt、初始 fixture、预算和 grader，重复运行并比较成功率、turn、工具数、耗时和失败分类。模型从未提出正确行动，偏向模型或上下文；正确行动被参数层误拒、工具反馈被截断到无法使用、reasoning/tool result 没有续传，偏向 harness。外部 grader 必须独立于 final answer。

**问：为什么主演示选 2048？这不就是生成静态网页吗？**

任务的难点不在页面数量。纯引擎必须满足输入不可变、四方向变换、一次移动每个源 tile 只能合并一次、精确随机数调用次数和胜负状态；浏览器层还要接键盘、WASD、pointer swipe、localStorage、可访问状态和窄屏布局。Agent 需要从公开契约拆模块、实现、运行测试，再交付可操作页面。相比改一行代码，这条链路能同时展示推理、工具使用和最终产品体验。

**问：`21/21` 能证明页面做得好吗？**

它证明固定契约里的算法、DOM 入口、事件绑定、存储和关键 CSS 语义成立。hidden grader 使用静态 DOM/CSS 检查，没有证明逐像素质量、所有浏览器兼容性或真实触摸设备体验。视频里直接操作键盘、pointer、New Game 和 Best，补充了一个人工可用性样本；更强的版本应加入 Playwright 多 viewport 行为测试和视觉 diff。

**问：hidden grader 怎样隔离？**

Agent 启动前，workspace 里只有 README、package、启动脚本和 7 项公开测试。Agent 停止后，runner 才复制 14 项 hidden tests，并在新的 Node 进程里执行。README、package、启动脚本和公开测试的哈希也会复核。这个方案能防止直接读取 hidden 文件和简单改测试，仍不是对恶意进程的强隔离；严肃 benchmark 应把 grader 放进独立容器并只读挂载输入。

**问：一次 2048 PASS 能报告成功率吗？**

不能。正式样本只能说明这组模型、fixture、prompt 和预算下有一条成功链路：61.719 秒、12 turn、15 tools、`21/21`。成功率需要固定提交重复多次，并报告置信区间和失败分类。stale-timer 的五次实验用于展示这种做法，其中结果为 `4/5`，但任务不同，不能拿它替 2048 估计稳定性。

**问：hidden grader 会不会只是你事后加规则让第一版失败？**

第一版 runner 只覆盖已出队 callback，没有检验 handle 复用。模型用 handle 充当 generation，依赖了未声明的永久唯一性。发现反例后，我把 handle 可复用写进公开 README，再把对应测试放进 Agent 运行后才出现的 grader。评测变严的历史和首轮失败都保留，没有拿新规则伪装成旧成绩。

**追问：明确要求先读 README，是否等于把 hidden test 泄露给模型？**

没有。README 是公开验收规格，任务提示只说明规格位置；它没有描述 hidden test 的构造，更没有给出 generation 或 entry identity 的答案。hidden grader 验证公开契约在未见场景中是否成立。真实仓库也常把约束放在 README、CONTRIBUTING 或 ADR 中，Agent 找到并遵守这些文档属于任务能力。

**问：固定条件重复运行的结果怎样？**

提交 `b537d34` 上连续五次，五次都正常结束，四次通过公开与 hidden grader，一次公开测试 `5/5`、hidden grader `6/7`。p50 为 45.840 秒，p95 为 63.078 秒。p95 按 nearest-rank 计算；五个样本时就是最大值，只能作为录屏门槛。失败运行读过 README，却仍选择 timer handle identity，所以归类为模型推理和自检不足，不是 provider、工具或轨迹故障。

**追问：从 `3/5` 提升到 `4/5`，能证明 prompt 改进有效吗？**

不能下因果结论。两个实验各五个样本，只有一个任务，采样误差很大。它只能作为支持性证据：显式指出规格位置后，README 读取率从 `3/5` 变为 `5/5`，grader 通过率从 `3/5` 变为 `4/5`。要得出更强结论，需要更多随机种子、任务族和置信区间。

**问：一次演示成功能说明什么？**

只能证明这条端到端链路在给定模型、fixture 和预算下成功过。它不代表总体成功率，也不能从一个网页任务外推到任意仓库。更完整的评测要加入跨文件接口修改、依赖错误、大输出截断和预算耗尽，并分别报告样本量、通过率和失败分类。

**问：如何防模型修改测试骗过 grader？**

2048 runner 在执行前后对 README、package、启动脚本和公开测试做 SHA-256 对比。hidden grader 在 Agent 结束后才复制进 workspace。它仍不是抗恶意模型的强隔离；模型可以修改其他运行入口或尝试环境探测。严肃 benchmark 应在独立容器中只读挂载输入，并把 grader 放在容器外执行。

## 如果继续做

**问：下一步最值得加什么？**

优先级是：扩展可复现任务集和统计报告、context compaction、容器化 command runner。当前单 case 已有重复数据，下一步要验证结论能否跨任务成立。多 Agent 和复杂 TUI 排在后面，因为它们不会先解决正确性、成本和隔离问题。

**问：如果要支持远程团队仓库，架构哪里会变化？**

ModelClient 和 CodingAgent 可以保留。Workspace 要换成 snapshot 或 worktree 管理；command tool 进入容器；approval 变成有身份和审计的 policy service；EventSink 写入持久存储并带 hash chain；外部副作用需要 idempotency key。不能直接把本地 `--yes` 搬到服务端。
