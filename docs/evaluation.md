# Nash 评测记录

评测和演示解决两个不同问题：演示说明交互是否清楚，评测判断产物是否满足契约。Nash 的 runner 会固定初始 fixture、任务、模型配置和预算；Agent 停止后再加入 hidden grader，并对受保护文件做 SHA-256 对比。final answer 只是一条模型消息，不参与 PASS 判定。

## game-2048：完整网页任务

### 任务范围

`game-2048` 要求 Agent 在空白工作区中交付可离线运行的网页游戏。输入规格固定了文件边界和纯引擎 API，浏览器层需要支持键盘、WASD、pointer swipe、New Game、Best 持久化、可访问标签和窄屏布局。

这个任务同时检查四层能力：

- 从 README 和公开测试恢复完整契约。
- 把状态算法与 DOM 控制分开，避免浏览器依赖污染单元测试。
- 处理一次移动只能合并一次、随机数调用次数、胜负状态等精确语义。
- 交付可以直接启动并由人操作的最终页面。

### 隔离与 grader

`npm run eval:2048` 会把 fixture 复制到 `.nash/evals/<run-id>/workspace`，只在这个自动创建的目录中启用 `--yes`。Agent 能看到 7 项公开引擎测试，看不到 14 项 hidden tests。Agent 停止后，runner 才复制 hidden grader，并在独立 Node 进程中运行全部 21 项测试。

hidden grader 覆盖：

- 四个方向的移动、输入不可变性、单次合并、得分与无效移动。
- 空位顺序、`0.9` 阈值、随机数调用次数、生成新 tile 的条件。
- `playing / won / lost` 状态转换。
- 原生 module 入口、DOM 契约、键盘与 pointer 事件、localStorage 和窄屏 CSS。

runner 同时核对 `README.md`、`package.json`、`scripts/serve.mjs` 和 `test/game.test.js` 的 SHA-256。hidden grader 子进程使用和 Agent 命令相同的敏感环境变量剥离逻辑，不继承 DeepSeek API key。

### 正式样本

正式样本固定使用 `deepseek-v4-flash`、thinking enabled、reasoning effort low、20 turns、48 tools 和 360 秒 wall-clock 上限。结果保存在本地 run `game-2048-20260830T102528Z-e5a1b3e9`：

| 指标 | 数值 |
| --- | ---: |
| Agent stop reason | `final_answer` |
| 独立 grader | 21 / 21 |
| 受保护文件 | 4 / 4 未变化 |
| wall-clock | 61.719 秒 |
| turns / model attempts | 12 / 12 |
| tool calls | 15 |
| input / output tokens | 121,215 / 8,971 |
| cache hit / miss | 113,408 / 7,807 |

这个样本证明 Nash 能把流式模型请求、多轮工具、文件创建、命令验证和外部 grader 连成一条真实链路。它只有一次正式运行，不能据此估计总体成功率。DOM 与 CSS 的 hidden tests 检查结构和关键语义，也不能替代逐像素视觉回归；视频中的浏览器实操用于补充可用性证据。

### 如何复现

```bash
npm run eval:2048
```

runner 会打印隔离 workspace、session ID、trace 和 result 路径。运行需要真实 DeepSeek API，因此耗时和模型行动可能变化；grader 输入和 PASS 标准保持固定。

## stale-timer：状态竞态修复

### 任务为什么这样选

演示任务需要在一分钟左右完成，又要有足够深的状态问题。`LeaseCache` 的旧租约 callback 已经从 scheduler 队列取出，此时同一个 key 写入 replacement；旧 callback 随后执行，但不能删除新值。单纯调用 `cancel` 无法解决，因为取消对已出队 callback 无效。

这个 case 具备四个特点：

- Agent 必须读取已有实现、需求和测试，不能只生成新文件。
- baseline 只有一个确定性失败，不受真实 timer 抖动影响。
- 结果有可执行 grader，不依赖模型自述。
- 状态代际、回调竞态和测试充分性都适合面试追问。

### 评测隔离

`npm run eval:stale-timer` 会把 fixture 复制到 `.nash/evals/<run-id>/workspace`。`--yes` 只在这个自动创建的目录中启用。Agent 运行结束后，runner 会：

1. 把 Agent 运行时不可见的 hidden grader 加入临时 workspace。
2. 用独立 Node 进程执行公开测试和 hidden test。
3. 对 `README.md`、`package.json`、`tsconfig.json` 和公开测试做 SHA-256 对比。
4. 保存 result、最终 workspace 和 session trace。

grader 子进程使用和 Agent 命令相同的敏感环境变量剥离逻辑，不会继承 DeepSeek API key。

### Baseline

公开测试共 5 个，baseline 为 `4 pass / 1 fail`。唯一失败是：旧 callback 已经出队，replacement 写入后再执行旧 callback，replacement 被误删。

hidden grader 另外检查 scheduler 对排队任务的正常取消，以及已出队 callback 的 handle 被新任务复用。它不会在 Agent 运行前复制到 workspace。

### 第一轮：公开测试通过，设计仍有漏洞

第一轮真实 DeepSeek 运行读取代码和公开测试，先复现失败，再把 callback 改为：只有 `current.timer === timer` 时才删除。公开测试 `5/5` 通过，当时的旧 runner 因而报告 PASS。

复盘时发现 timer handle 没有被契约保证永久唯一。callback 已经出队后，scheduler 可以回收它的 handle。把这个场景写入 hidden grader 后，第一轮产物为 `1 pass / 1 fail`：旧 callback 和 replacement 恰好持有相同 handle，仍会误删新值。

第一轮运行数据：

| 指标 | 数值 |
| --- | ---: |
| wall-clock | 30.490 秒 |
| turns / tool calls | 7 / 8 |
| input / output tokens | 37,917 / 3,294 |
| cache hit / miss | 32,256 / 5,661 |
| 当时公开测试 | 5 / 5 |
| 事后 hidden grader | 1 / 2 |

这次失败说明公开测试通过只能证明已覆盖场景，不能证明实现依赖的所有假设都成立。评测器也需要接受反例检验。

### 探索组 v2：3/5

README 明确补充 handle 可以复用后，使用同一模型、fixture、任务、grader 和预算运行五次。这个阶段用于发现失败模式，期间只有文档和 CLI 集成测试提交，Agent runtime 与评测输入没有变化，因此不作为“同一 Git commit”的正式稳定性数据。

| 样本 | grader | 秒 | turns / tools | input / output | cache hit / miss | 最终方案 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | PASS | 49.260 | 10 / 13 | 72,173 / 5,681 | 65,920 / 6,253 | generation |
| 2 | PASS | 30.988 | 7 / 10 | 38,155 / 3,675 | 32,640 / 5,515 | entry identity |
| 3 | FAIL | 25.908 | 6 / 7 | 26,937 / 3,082 | 22,784 / 4,153 | timer handle |
| 4 | FAIL | 43.241 | 6 / 7 | 35,569 / 5,434 | 31,616 / 3,953 | timer handle |
| 5 | PASS | 34.928 | 11 / 13 | 71,599 / 4,129 | 65,408 / 6,191 | generation |

五次都由 Agent 正常给出 final answer，受保护文件也都未变化；两个 FAIL 是公开测试 `5/5`、hidden grader `6/7`。耗时 p50 为 34.928 秒，p95 为 49.260 秒。

轨迹显示，三次 PASS 都读取了 README，两次 FAIL 都没有读取。这个相关性支持“模型没有稳定取得任务契约”的假设，但五个样本不足以证明因果关系。

### 任务提示改进

v3 只在任务开头增加一句：编辑前先读 README，因为它是验收规格。提示没有描述 handle 复用测试，也没有暴露 hidden grader。让 Agent 知道契约放在哪里属于正常任务上下文，不等于把答案写进 prompt。

改动单独提交为 `b537d34`，随后不再修改 runtime、fixture、任务或 grader，开始固定提交实验。

### 固定提交 v3：4/5

五次运行使用相同条件：

- Git commit `b537d34`，工作区在每次运行前从同一 fixture 复制。
- `deepseek-v4-flash`，thinking enabled，reasoning effort high。
- 12 turns、24 tools、240 秒 wall-clock，总 token 上限 2,000,000。
- 同一任务、公开测试、hidden grader 和受保护文件列表。

| 样本 | grader | 秒 | turns / tools | input / output | cache hit / miss | 最终方案 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | PASS | 41.995 | 9 / 13 | 67,337 / 4,998 | 61,440 / 5,897 | entry identity |
| 2 | PASS | 46.314 | 7 / 11 | 49,767 / 5,808 | 43,904 / 5,863 | entry identity |
| 3 | PASS | 45.840 | 10 / 13 | 77,341 / 5,555 | 71,168 / 6,173 | generation |
| 4 | FAIL | 40.922 | 7 / 11 | 46,749 / 5,043 | 41,984 / 4,765 | timer handle |
| 5 | PASS | 63.078 | 8 / 12 | 70,219 / 7,792 | 64,512 / 5,707 | entry identity |

五次都在预算内结束，受保护文件都未变化；grader 成功率为 `4/5`。耗时 p50 为 45.840 秒，p95 为 63.078 秒；turn 中位数为 8，工具调用中位数为 12。五次共使用 311,413 input token 和 29,196 output token，其中约 90.9% 的 input token 命中 prompt cache。p95 使用 nearest-rank；样本只有五个，因此它等于最大值，只适合作为录屏门槛，不是稳定的尾延迟估计。

失败样本也读取了 README，却仍断言 timer handle 唯一并提交 `current.timer === timer`。因此，提示改进解决了上下文发现问题，没有消除模型违反显式契约的风险。独立 grader 在 Agent 自称公开测试全部通过后仍将它判为 FAIL，这正是外部验证的价值。

v2 的 `3/5` 到 v3 的 `4/5` 只说明这组样本支持改进方向。样本量小、任务单一，不能据此声称对任意仓库有 80% 成功率。

### 如何复现

```bash
npm run eval:stale-timer
```

runner 会打印隔离 workspace、session ID、trace 和最终 artifacts 路径。查看轨迹：

```bash
npm run dev -- inspect --workspace <printed-workspace> <session-id>
npm run dev -- replay --workspace <printed-workspace> --speed 8 <session-id>
```

replay 只重放事件，不会再次写文件或运行命令。

## 当前证据能说明什么

2048 样本覆盖从空白工作区生成跨文件网页，stale-timer 样本覆盖既有代码中的状态竞态；两者共同验证了完整 CLI、DeepSeek thinking 续传、本地工具、错误反馈、精确编辑、命令执行、JSONL 和独立 grader。stale-timer 的失败样本还说明，模型自称完成和公开测试通过都不能代替外部契约验证。这些结果仍不能证明 Nash 对任意仓库都有稳定成功率。

下一步评测应扩展任务族，例如跨文件接口修改、依赖错误、大输出截断和预算耗尽，并为每个 case 记录相同指标。若失败集中在模型没有提出正确修复，优先调整上下文或模型；若正确行动被参数层拒绝、状态写回缺失或 grader 失真，则属于 harness 问题。
