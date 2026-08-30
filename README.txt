Nash 编程智能体

Git 仓库：https://github.com/TmkShink/nash-agent

运行环境：Node.js 20.11 以上。执行 npm install，复制 .env.example 为 .env.local，只在其中填写 DEEPSEEK_API_KEY，然后运行：

npm run dev -- run --workspace /path/to/project "你的编程任务"

读取操作自动执行；写文件和 shell 命令默认需要人工确认。运行结束后，可用下面的命令查看经过严格校验的会话轨迹：

npm run dev -- inspect --workspace /path/to/project <session-id>

项目使用 TypeScript 从零实现 model-tool loop、DeepSeek SSE 聚合、thinking 状态续传、工具参数解析、本地文件与命令执行、重试、预算、终止条件和 append-only JSONL，没有使用 Agent 框架或服务端托管工具。

终端实时显示模型阶段和可见输出，List、Read、Write、Edit、Bash 使用不同工具卡片。流式参数只用于即时反馈；收到完整响应并通过本地校验后，runtime 才执行工具。文件访问受工作区和 symlink 检查约束，命令具备超时、进程组终止、敏感环境变量剥离和输出上限。

仓库内置 2048 网页评测。Agent 只能看到需求和 7 项公开测试，停止后才加入 14 项 hidden tests。正式样本在 61.719 秒内完成 12 个 turn、15 次工具调用，公开与隐藏测试共 21/21，四个受保护输入文件没有变化。可用 npm run eval:2048 复现；runner 只在自动创建的隔离目录中启用 --yes。
