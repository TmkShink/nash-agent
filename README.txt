Nash 编程智能体

Git 仓库：https://github.com/TmkShink/nash-agent

运行环境：Node.js 20.11 以上。执行 npm install，复制 .env.example 为 .env.local，在其中填写 DEEPSEEK_API_KEY，再运行：

npm run dev -- run --workspace /path/to/project "你的编程任务"

读取操作自动执行；写文件和 shell 命令默认需要人工确认。运行结束后可用下面的命令查看严格校验的会话轨迹：

npm run dev -- inspect --workspace /path/to/project <session-id>

项目使用 TypeScript 从零实现 model-tool loop、DeepSeek thinking 状态续传、工具参数解析、本地文件与命令执行、重试、预算、终止条件和 append-only JSONL 轨迹，没有使用 Agent 框架或服务端托管工具。文件访问受工作区和 symlink 检查约束；命令具备超时、进程组终止、敏感环境变量剥离和输出上限。replay 只重放记录，不会再次执行副作用。

仓库内置 deterministic stale-timer 评测。Agent 需要修复旧计时回调误删新值的竞态，并接受运行时不可见的 handle 复用测试。一次真实 DeepSeek 运行在 49.3 秒内完成 10 个 turn 和 13 次工具调用，公开测试与 hidden grader 共 7/7 通过，受保护文件未被修改。可用 npm run eval:stale-timer 复现；该命令只在自动创建的隔离目录中启用 --yes。
