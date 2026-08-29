# 安全边界与威胁模型

Nash 会执行模型提出的本地操作。安全讨论必须先说明保护什么、信任谁，再判断某个机制是否有效。

## 受保护对象

- 工作区外的用户文件和 Git 状态。
- API key、token、cookie、SSH agent 等凭据。
- 工作区内尚未授权的写入和命令。
- 会话记录的完整性和可追溯性。
- 宿主机资源，避免失控命令无限运行或无限输出。

Nash 信任启动它的本地用户，也信任用户选择的模型 endpoint。模型输出、普通仓库文件和命令输出都按不可信数据处理。面对同一账户下主动竞争文件系统的恶意进程，当前实现只提供有限防护。

## 文件边界

`Workspace` 拒绝绝对路径、NUL、`..` 越界和 Windows 风格绝对路径。读取已有文件时使用 `realpath`，因此工作区内指向外部的 symlink 不能绕过边界。创建新文件时先找到最近的已存在父目录，检查其真实位置，创建目录后再检查一次。

文件工具还会拒绝以下路径：

- `.git`，避免模型绕过正常 Git 操作直接改内部状态。
- `.nash`，避免模型篡改或读取自己的会话记录。
- `.env`、`.env.*`、`.npmrc`、`.pypirc`、`.netrc` 和 `.git-credentials`。

`.env.example`、`.env.sample` 和 `.env.template` 被视为可分享模板。目录列表会隐藏受保护名字；安全名字的 symlink 即使出现在列表中，读取真实目标时仍会再次执行策略检查。

这些检查仍有 TOCTOU 窗口。检查完成后，另一个本地进程可能替换父目录或 symlink。若工作区来自不可信用户，需要把整个 Agent 放入容器、VM 或基于 `openat` / descriptor-relative path 的沙箱。

## 命令边界

`run_command` 使用 `/bin/sh -lc`，因此具备 shell 的完整表达能力。字符串黑名单无法可靠阻止重定向、子进程、解释器、编码命令或网络访问。当前边界包括：

- 默认需要人工审批，并展示转义后的命令预览。
- 固定工作目录为 workspace root。
- 默认 60 秒、最高 120 秒 timeout。
- Unix 下建立独立进程组，先 `SIGTERM`，500 ms 后仍未退出则 `SIGKILL`。
- stdout 和 stderr 合并进入 head-tail buffer，保留 48 KiB 头部和 16 KiB 尾部。
- 子进程环境移除名称中含 key、token、secret、password、credential、cookie、bearer 等敏感片段的变量，也移除 SSH agent 和 askpass。

这些措施限制误操作的范围，没有形成 OS 级隔离。命令仍可读取当前用户可读的文件、访问网络或启动后台进程。`--yes` 明确表示用户愿意在当前隔离环境接受全部副作用，不应被称为安全模式。

## 审批语义

工具先完成参数解析和安全 preview，再请求审批。拒绝会成为可恢复 tool result，模型可以换方案或请求用户操作。交互审批支持：

- `y / yes`：只放行当前操作。
- 回车、`n` 或其他输入：拒绝。
- `a / all`：放行本会话之后的所有操作。

审批回答的是“用户是否授权这次操作”，不判断代码是否正确，也不替代路径检查。读取自动放行依赖凭据路径策略；否则 `.env.local` 会在无人确认时进入模型上下文。

## Prompt injection

仓库文件和命令输出可能包含诱导模型忽略用户目标的文字。system prompt 明确把普通工具输出标为不可信数据，但提示词不是强安全边界。真正的保护仍来自工具 schema、路径政策、审批和预算。

当前版本没有做内容级 taint tracking，也没有区分“仓库维护者指令”和“第三方依赖中的文本”。`AGENTS.md` 由 system prompt 指示模型按作用域读取，但 runtime 不单独验证其中的语义。处理来源不可信的仓库时，应开启逐次审批，并在隔离环境中运行命令。

## 密钥和记录

Provider credential 与 provider settings 分开传递。终端只展示 endpoint 之外的必要摘要，不显示 key。HTTP 错误在输出前按当前 key 做替换，并转义 ANSI、C0/C1 和双向文本控制字符。

JSONL 文件权限为 `0600`，目录为 `0700`，路径位于被 Git 忽略的 `.nash`。trace 会记录用户任务、工具参数、文件内容片段和命令输出，所以它可能包含用户主动放入任务或受控命令输出中的敏感信息。私有文件权限降低误泄漏，不等于自动脱敏。分享 trace 前需要单独审查。

## 崩溃和审计

EventBus 先持久化 `tool_started`，再执行工具，成功或失败后持久化 `tool_finished`。如果只有 started，没有 finished，说明进程在不确定窗口中退出。副作用可能已经发生，自动重试非幂等工具会带来重复写入或重复外部操作。

JSONL 是 append-only 运行记录，不是防篡改日志。拥有工作区写权限的用户可以离线修改它。若需要对外证明，应增加 hash chain、签名、可信时间源和工作区快照。

## 上线前需要补的能力

- 在容器或 VM 中隔离 shell、网络和文件系统。
- 用 capability 明确每个工具可访问的路径和命令集合。
- 对长会话 trace 做字段级脱敏和保留周期管理。
- 用 descriptor-relative API 缩小路径检查的 TOCTOU 窗口。
- 对外部副作用增加 idempotency key、确认状态和人工恢复流程。
