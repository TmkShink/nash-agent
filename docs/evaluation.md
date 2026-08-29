# stale-timer 评测记录

## 任务为什么这样选

演示任务需要在一分钟左右完成，又要有足够深的状态问题。`LeaseCache` 的旧租约 callback 已经从 scheduler 队列取出，此时同一个 key 写入 replacement；旧 callback 随后执行，但不能删除新值。单纯调用 `cancel` 无法解决，因为取消对已出队 callback 无效。

这个 case 具备四个特点：

- Agent 必须读取已有实现、需求和测试，不能只生成新文件。
- baseline 只有一个确定性失败，不受真实 timer 抖动影响。
- 结果有可执行 grader，不依赖模型自述。
- 状态代际、回调竞态和测试充分性都适合面试追问。

## 评测隔离

`npm run eval:stale-timer` 会把 fixture 复制到 `.nash/evals/<run-id>/workspace`。`--yes` 只在这个自动创建的目录中启用。Agent 运行结束后，runner 会：

1. 把 Agent 运行时不可见的 hidden grader 加入临时 workspace。
2. 用独立 Node 进程执行公开测试和 hidden test。
3. 对 `README.md`、`package.json`、`tsconfig.json` 和公开测试做 SHA-256 对比。
4. 保存 result、最终 workspace 和 session trace。

grader 子进程使用和 Agent 命令相同的敏感环境变量剥离逻辑，不会继承 DeepSeek API key。

## Baseline

公开测试共 5 个，baseline 为 `4 pass / 1 fail`。唯一失败是：旧 callback 已经出队，replacement 写入后再执行旧 callback，replacement 被误删。

hidden grader 另外检查 scheduler 对排队任务的正常取消，以及已出队 callback 的 handle 被新任务复用。它不会在 Agent 运行前复制到 workspace。

## 第一轮：公开测试通过，设计仍有漏洞

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

## 第二轮：generation 修复通过 hidden grader

强化 README 契约后再次运行。模型明确识别出 handle 可复用，给每个 lease 增加单调 generation。callback 只在当前 entry 的 generation 与自己捕获的 generation 相同时删除。

第二轮先复现公开测试失败，完成三次精确编辑，公开测试通过。中间一次组合验证命令因 fixture 没有安装 `@types/node` 而返回非零；模型没有声称 typecheck 通过，而是单独重跑公开测试并在 final answer 中说明原因。独立 grader 随后得到 `7/7`，受保护文件哈希未变化。

| 指标 | 数值 |
| --- | ---: |
| wall-clock | 49.260 秒 |
| turns / model attempts | 10 / 10 |
| tool calls | 13 |
| input / output tokens | 72,173 / 5,681 |
| cache hit / miss | 65,920 / 6,253 |
| 公开 + hidden grader | 7 / 7 |
| 受保护文件 | 未修改 |

约 91.3% 的 input token 命中 prompt cache。缓存命中让完整历史的重复输入更便宜，但总 input 仍随 turn 快速增长。

## 如何复现

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

这两轮证明了完整 CLI、DeepSeek thinking 续传、本地工具、错误反馈、精确编辑、命令执行、JSONL 和 grader 能连成一条真实链路。它们不能证明 Nash 对任意仓库都有稳定成功率。

正式录屏前还需要在同一 commit、模型、预算和 fixture 上重复运行，记录成功率、p50 / p95 耗时、turn、工具数和失败分类。若失败集中在模型没有提出正确修复，优先调整上下文或模型；若正确行动被工具拒绝、状态写回缺失或 grader 失真，则属于 harness 问题。
