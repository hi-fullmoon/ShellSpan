# ADR：Agent 使用独立 Exec，交互 PTY 只由显式租约控制

> 状态：Accepted
> 日期：2026-08-27
> 适用阶段：P0 及后续 Agent 阶段

## 背景

TermBridge 已有两条含义不同的远程通道：Runbook 使用独立 SSH Exec channel，用户终端通过 `write_session` 向当前交互 PTY 写入字节。Exec 能提供 stdout、stderr、exit status、timeout、cancel 和冻结目标身份；PTY 则继承用户 shell 的 cwd、alias、function、venv、临时环境和提示符状态，但字节流无法可靠证明一条命令从何处开始、何时结束或由谁输入。

如果 Agent 为了复用用户上下文而直接调用 `write_session`，模型输出会绕过 reviewed request、目标复核、输出上限、秘密擦除和 operation-level cancellation，并可能与用户输入交错。因此 P0 必须先固定两条通道的职责边界。

## 决策

1. 非交互 Agent 命令默认使用 `execution::execute_reviewed_ssh_command` 创建独立 SSH Exec channel。上层 policy/approval 先构造强类型 reviewed request，kernel 再执行冻结目标、known-hosts、凭证、timeout、cancel、输出上限和 redaction 硬校验。
2. P1 不得调用、包装、转发或从前端 invoke 既有 `write_session` 来执行模型生成内容。也不得新增语义等价的 session/PTY 写入捷径。P0 verified 之前不得开放真实 `shell.exec`。
3. 现有 `write_session` 只服务用户主动操作的交互终端。它不是 Agent tool，也不是可信执行证据来源。
4. 后续确需交互式 CLI 时，P3 必须新建专用 Agent PTY，并引入显式 `TerminalLease`。同一 PTY 同时只有 user 或 agent 一个 owner；用户输入/接管立即停止 Agent 写入。密码、passphrase、MFA 或其他秘密提示不得由 Agent 自动填写。
5. PTY 输出不能作为状态修改成功的唯一证据。修改后仍需通过独立、只读、结构化工具或 Exec 产生后置证据。
6. Remote FS owner/group lookup 与 Remote Health snapshot 是 P0 之前已有的固定用途内部命令，不是 Agent 任意执行入口。它们可以复用 `execution/ssh.rs` 的 raw channel-start transport primitive，但 P1 Agent tool 不得调用该 primitive 绕过 reviewed kernel。

## Exec 与 PTY 的可观察差异

| 维度 | 独立 SSH Exec | 交互 PTY |
| --- | --- | --- |
| 目标 | reviewed request 冻结 profile/host/port/user/jump identity | 当前用户 session |
| shell 上下文 | 不继承当前 `cd`、alias、function、venv、临时 export | 继承当前交互 shell 状态 |
| 完成边界 | channel EOF + exit status | 提示符/屏幕字节，不可靠 |
| 输出 | stdout/stderr 分离、计数、截断、hard limit、redaction | 合并终端字节流与控制序列 |
| 并发所有权 | 独立 operation | 可能与用户输入竞争，必须靠未来租约隔离 |
| Agent 默认用途 | 是 | 否 |

## deadline 与取消限制

reviewed timeout 从 operation 开始计时，调用方可以在 deadline 到达时稳定返回 `TimedOut`。但当前连接层仍包含不能被 operation token 立即打断的阻塞步骤：

- DNS `to_socket_addrs` 没有独立 operation deadline；
- 每个解析地址的 TCP connect timeout 最长 12 秒；
- SSH handshake/auth 使用 15 秒 session I/O timeout；
- jump-host 会串行执行外层连接/认证、direct-tcpip 和内层连接/认证。

因此 timeout 表示调用方终态已经封闭，不表示所有连接线程已在同一时刻退出。worker 可能在调用方返回后完成连接失败或 teardown；它在 connection 返回后再次观察 terminal state，不能把迟到结果写回，也不能迟到启动远程命令。后续若要声称全链路 I/O 受同一个 deadline 控制，必须改造 connection API 并补 DNS/TCP/handshake/auth 专项测试。

取消或 timeout 会尝试关闭当前 channel，但 SSH 协议不能保证终止已经脱离 channel 的任务，例如 `nohup`、`cmd &`、double-fork daemon 或已把工作转交给其他服务的命令。P1/P2 自动 policy 必须拒绝后台化/隐藏执行结构；用户显式批准也不能把 channel close 描述为远端进程已被杀死的证据。

## 崩溃恢复限制

execution cancellation registry、worker 终态和未返回结果都只存在进程内存中。应用崩溃或被强制终止后：

- 不恢复或自动重放未完成 operation；
- 不把缺失结果推断为成功、失败或已取消；
- 不保证前台 SSH 命令已收到并处理断连；
- 更不能保证 daemonized/background 远程进程停止。

P1/P2 若需要崩溃后的可解释状态，只能记录“结果未知”并重新采集只读证据；不得自动继续未确认的远端修改。

## P3 阶段 5 验收附记（不改变本 ADR 的准入结论）

截至 2026-08-28，P3 阶段 1–4 已把本 ADR 要求的专用 `SessionKind::AgentPty`、单 owner `TerminalLease`、run/session/epoch/revision fence、用户首输入原子 takeover、严格 `agent-terminal/v1` proposal、唯一 renderer/driver、后端 coordinator/audit/capture 和独立专用 xterm 实现为 feature-blocked foundation。阶段 5 用机器可读矩阵、Rust/TypeScript 共享 fixture、deterministic UI-to-mocked-narrow-IPC E2E 和结构化旁路/隐私审计完成了 platform-independent 自动化验收。

该 foundation 不把 PTY 变成可信执行证据，也不改变 Exec 默认通道：PTY observation 始终 untrusted，修改后的成功只能由精确绑定的独立只读 verifier 证明；凭证、未知敏感、alternate screen、editor、installer 和 unknown surface 仍只 handoff。普通 `write_session` 仍只服务 `UserTerminal`，专用路径不存在 generic execute/raw write IPC。

平台证据必须保持分级：macOS 只完成本机真实 Tauri/WebView/xterm 壳启动和 direct-process PTY smoke；Windows 只有 CI matrix 配置、未实际运行；SSH 只有 contract evidence、未创建真实 AgentPty。P0/P1/P2/P3 production admission 均未解除，没有接入真实模型、任意 shell、修改 executor 或通用 computer-use。详细证据与未验证退出条件见 `docs/ai-agent-p3-terminal-control-phase5-acceptance.md`。

## 结果

Runbook 与未来 Agent 共享 reviewed kernel，交互终端保持用户控制，P1 的真实执行入口必须等待 P0 verified。代价是 Agent Exec 不自动继承用户 shell 上下文，交互式工具需要延后到带租约的专用 PTY；连接阶段 deadline 与崩溃后远端状态仍是显式限制，而不是被文档包装为已解决。
