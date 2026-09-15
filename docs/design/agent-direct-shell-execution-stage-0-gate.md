# Agent 原生命令输入：阶段 0 架构与安全门禁记录

> 日期：2026-09-14  
> 对应研发计划：[agent-direct-shell-execution-plan.md](agent-direct-shell-execution-plan.md)；方案：[agent-direct-shell-execution.md](agent-direct-shell-execution.md)  
> **决策：NO-GO。不得在本轮对任意原生命令根据 in-band end 自动连续写入下一条 Agent 命令；保持现有 wrapperV1。不进入阶段 1。**

## 门禁问题与实际结论

阶段 0 要证明的是：上一条命令真正回到顶层 shell 后，后端才可能往同一 PTY 写下一条命令。候选协议的 start/end 从 shell 和命令共享的输出字节流传回后端。位于同一 shell 的命令或 source/dot-source 脚本能读取会话 nonce 和当前递增序号，自行输出**完全匹配的 start 和 end**，然后继续读 stdin。后端若仅据这对帧完成 operation，下一条 Agent 命令会被前一条仍在运行的程序读取。

独立攻击 fixture 在五种实际会话中均复现了这一写入：Windows ConPTY + PowerShell 7、Windows ConPTY + Windows PowerShell 5.1、Windows ConPTY → WSL Bash、Windows ConPTY → OpenSSH → Docker Bash、同一 SSH PTY 中的 zsh。每次运行使用新的 UUID；伪造帧含预期序号，driver 在看到伪造 end 的原始字节后立即写入下一行，并收到脚本输出的 GATE_CONSUMED:<下一行>。这是对“有效 in-band end 足以授权下一次写入”的直接反例。真实 hook 在脚本最终返回后才发出真正 end；那时错误写入已经发生。随机 nonce、递增序号、先注册 operation、lease 与对 OSC 的字节级解析都不能从同一不可信流中区分这两次 end。

实验模拟的是提案中的完成即派发边界，**不是**声称当前生产 wrapperV1 已发生这种误写。实验没有改生产路由或启用 V2。

## 可复现证据

fixture 与运行命令位于 [tests/agent-direct-shell-gate/README.md](../../tests/agent-direct-shell-gate/README.md)。脚本、ConPTY/SSH PTY driver 和隔离 SSH Dockerfile 均在同一目录。“PASS forged start+end”表示**攻击成功、架构门禁失败**，不是 V2 安全通过。Docker 只使用独立镜像、独立容器名和本机回环端口，完成后停止该容器。

| 实测环境 | 命令/状态与攻击结果 |
| --- | --- |
| Windows PowerShell 7.6.5 / ConPTY；PSReadLine 2.4.5 | cmdlet、非终止错误、原生 exit 7、管道、异常、状态继承、Ctrl-C、exit 9 均观察到；匹配 nonce/序号的伪造帧之后，dot-source 脚本吞入下一条 Agent 行。PowerShell 只有 prompt end 候选 hook，可靠 pre-execution start 仍未找到。 |
| Windows PowerShell 5.1.26100.9444 / ConPTY；PSReadLine 2.0.0 | 同一套状态、同 shell 目录/alias/函数/变量、Ctrl-C、exit 与攻击测试通过；dot-source 脚本吞入下一条 Agent 行。可靠 pre-execution start 仍未找到。 |
| WSL Ubuntu Bash 5.2.21，经 Windows ConPTY | PS0/PROMPT_COMMAND 候选 hook 观察到 start/end；同 shell 的 cd、alias、函数、未导出变量、false=1、Ctrl-C=130、exit 9 通过；sourced 脚本吞入下一条 Agent 行。 |
| Docker Alpine Bash 5.2.37，经 OpenSSH PTY | 同 shell 状态、start/end、false=1、Ctrl-C=130、exit 9 通过；sourced 脚本吞入下一条 Agent 行。 |
| Docker Alpine zsh 5.9，经 OpenSSH PTY | preexec_functions/precmd_functions 候选 hook 观察到 start/end；状态、false=1、Ctrl-C=130、exit 9 通过；sourced 脚本吞入下一条 Agent 行。**另发现此候选安装组合未保留预置 precmd hook 的可见输出**，不能宣称 hook 兼容通过。 |

原始输入攻击还在 WSL/SSH Bash 中把行送入 Python REPL、原始终端模式程序和隐藏密码读取；Docker SSH Bash 中进入嵌套 SSH 的密码提示。SSH zsh 验证了 REPL 与原始终端模式程序。PowerShell 的 dot-source 攻击脚本在 Read-Host 中吞入下一行。这些实验展示错误输入会到哪里，不构成“写入前识别并拒绝”的证明。当前没有可信的顶层 shell 状态判定器，TUI、REPL、密码/OTP 提示、嵌套 SSH 与任意远程现有会话必须列为 V2 不支持。

PowerShell end 捕获的 shellSuccess;LASTEXITCODE 序列为：cmdlet 成功 True;，cmdlet 错误 False;，原生 cmd /d /c exit 7 为 False;7，其后管道 False;7、throw 为 False;7、普通 PowerShell 管道/函数成功仍为 True;7，Ctrl-C 为 False;7。这证实 $LASTEXITCODE 会跨非原生命令保留旧值。未来契约必须分开 shellSuccess 和可空 exitCode；只有独立确认刚结束的是原生程序，才可报告数值退出码。exit 9 关闭 PTY，无 end，不得补成成功。

## 威胁模型与支持矩阵

可信侧是批准/lease/operation 管理以及后端何时写 PTY 的决定；不可信侧包括用户命令、同 shell source 文件、子进程和远程主机的所有 PTY 输出。in-band OSC 只证明“收到了这些字节”，不证明字节由顶层 shell hook 发出。攻击者无需猜 UUID：source 脚本共享 shell 变量和 hook 上下文；若 nonce 进入环境，子进程也可能取得。即使隐藏 nonce，同一 shell 仍可覆写 hook、读集成状态或利用其他输出路径。帧剥离、跨 chunk 解析、递增序号、前端输入锁和用户点击“已到提示符”都不提供输出来源认证。输出伪造可能导致把下一条命令送给读 stdin 的程序、密码提示或嵌套远端；不确定时重试还可能重复副作用。

| 平台/入口 | 阶段 0 实验覆盖 | V2 任意命令自动连续执行 | 未验证项/限制 |
| --- | --- | --- | --- |
| Windows 本地 PowerShell 7 / ConPTY | 实测，攻击成功；状态语义和 PSReadLine 部分覆盖 | **不支持** | 无可靠 start；完整 prompt/theme 共存、安装回滚、历史/复制/日志检查未验证 |
| WSL Ubuntu Bash / ConPTY | 实测，攻击成功 | **不支持** | WSL 不替代原生 Linux 桌面验证；数组型 PROMPT_COMMAND、主题未验证 |
| Docker SSH Bash | 实测，攻击成功；嵌套 SSH 密码提示已覆盖 | **不支持** | Docker 不能替代任意远端现有 shell/重连场景 |
| Docker SSH zsh | 实测，攻击成功；候选 hook 共存缺陷 | **不支持** | 本地 macOS/Linux zsh、主题/ZLE 未验证 |
| Windows PowerShell 5.1 / ConPTY | 实测，攻击成功；状态语义和 PSReadLine 部分覆盖 | **不支持** | 完整 prompt/theme 共存、安装回滚、历史/复制/日志检查未验证 |
| 原生 macOS/Linux Bash、zsh 桌面 PTY | **未验证** | **不支持** | 在对应主机运行 README 中 local-bash/local-zsh 命令并记录版本、终端与结果 |
| 现有活动 TUI/REPL/密码提示/嵌套 SSH | 已复现错误输入可进入其中；未实现写前拒绝 | **不支持** | 任何初始化探针或原生命令都不得盲发 |
| direct、历史 wrapperV1 | 未修改生产路径 | 保持现状 | 阶段 0 无生产回归变更 |

候选 hook 的完整共存、失败回滚、无历史污染、输出帧过滤、异常断线和跨平台桌面验证仍未通过。由于核心安全边界已被证伪，不应将这些未完成项解释为“通过但需补测”。

## 后续范围建议（需单独评审）

本轮不推出 shellIntegrationV2，也不开始阶段 1。可单独评审一个收窄实验：仅在 ShellSpan 新建、可证明由应用独占的顶层 shell 中允许**单条**原生命令；任何 in-band end 之后都不自动写下一条，将控制交还用户或关闭该试验终端。首先仍须证明首次写入前没有半行输入和非 shell 程序，并定义超时、取消、接管与审计行为。若要求 Agent 自动连续运行，必须重新设计一个不依赖同一不可信 PTY 输出认证完成的边界；在证明与全平台实测之前，继续使用 wrapperV1。
