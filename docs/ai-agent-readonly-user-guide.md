# 只读动态 Agent：范围、安全与运行限制

> 当前可用性：本提交中的动态 Agent 仍受 P0/P1-D 发布门禁阻断。界面会显示 `p1Blocked`，不会运行动态工具；静态诊断计划仍可由用户显式选择，并且只生成可审阅计划。

## 只读范围

动态 Agent 只能针对启动时冻结的单个远程 Profile 做诊断。模型可以提出 `host.inspect` 或 `shell.execReadOnly`，但真正允许的内容由本地编译期 registry 和 program-specific policy 决定。

允许范围是固定主机信息以及有界的 `uname`、`hostname`、`whoami`、`id`、`date`、`uptime`、`df`、`free`、`ps`、`ss`、`systemctl` 只读状态、bounded `journalctl`，以及仅在冻结能力明确开启时的 bounded Docker 观察。

P1 不写文件，不启动、停止或重启服务，不发送信号，不安装软件，不修改网络或用户会话，也不读取 SSH key、shell history、进程环境、credential store 或 cloud metadata。Shell `-c`、pipeline、重定向、substitution、glob、提权、后台化和未知程序/参数都会失败关闭。

## 独立 Exec

Agent 工具使用独立 Exec，而不是向用户当前交互终端写入内容。独立 Exec 不继承当前终端的 cwd、环境变量、alias、function、venv、临时 shell 状态或历史。终端快照只是启动时冻结的可选观察证据，不能授权命令，也不会让 Agent 持续读取用户正在输入的终端。

## 输出隐私

原始输出先进入有界收集，再经过已知秘密和 Agent 通用敏感模式脱敏。脱敏后的同一份不可变内容才会用于模型上下文、界面、事件和 evidence；不存在“界面遮蔽但模型收到原文”的设计支路。

API key、SSH 密码、私钥、passphrase 和原始 terminal snapshot 不进入这些数据面。stdout/stderr 会受保留上限、combined hard limit 和 Agent 上下文压缩约束。脱敏能降低常见泄露风险，但用户仍应只提供完成诊断所需的最小上下文。

## Pause、Resume 与 Stop

- `Pause` 阻止后续动作。若模型正在判断，会取消并丢弃该回合；若只读工具已开始，则等待该工具形成稳定、脱敏的 observation 后暂停。
- `Resume` 从最新稳定上下文重新判断，不重放暂停前的迟到 decision。
- `Stop` 优先于 Pause 和 steering，会取消当前模型请求和当前工具调用，并把 run 收敛到 `cancelled`；迟到结果不能恢复终态或启动下一回合。

SSH channel 关闭不能证明已经脱离 channel 的任意远端进程停止。P1 policy 因此拒绝 `nohup`、`&`、`disown`、`setsid`、follow/watch 和其他后台化结构，而不是把 Stop 描述为通用远端 kill 保证。

## 崩溃与应用退出

关闭 AI Panel 不会停止后端 run；重新打开 Panel 会从后端 snapshot 恢复。正常退出应用会请求 Stop 并在有限时间内收敛运行。

活动 run、operation registry、timeline 和 evidence 只存在当前 Rust 进程内存中。应用崩溃或被强制退出后不恢复运行，也不能证明未返回的远端状态。下次诊断必须重新采集只读证据，不能把旧运行假装成已安全续跑。

## 报告与 evidence

最终报告的 `verified` 结论必须引用本次 run、同一冻结 target 的成功 evidence ID。失败、timeout 或 cancelled evidence 只能说明该尝试的结果，不能证明目标状态。没有 evidence 的结论只能标为 `uncertain`，所有修改建议只进入 `nextActions`，P1 的 `changes` 永远为空。

## English summary

The dynamic Agent is bounded to one frozen remote profile. Local policy allows only fixed host inspection and bounded read-only queries. Tools use independent Exec and do not inherit the interactive shell. One redacted observation is shared by the model, UI, events, and evidence. Pause prevents later actions; Stop cancels the active model request and tool, but cannot prove that a process already detached from its SSH channel stopped. App exit cancels the run; crash/force quit is not resumable. At this commit, production dynamic execution remains blocked because P0/Windows/P1-D evidence is incomplete.
