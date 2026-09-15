# 受信任 Shell 执行层可行性研究

> 日期：2026-09-15  
> 状态：研究结论与验证设计；不改变[阶段 0 NO-GO](agent-direct-shell-execution-stage-0-gate.md)，不启用 `shellIntegrationV2`。  
> 目标：研究能否在保留交互式 shell 状态的同时，让 Agent 安全地连续执行原始命令。

## 结论

**方案三有研究价值，但目前没有可进入生产路由的通用实现。**可信的“上一条命令已返回顶层 shell”和可信的“下一条输入只会由该 shell 读取”是两个独立条件。把 OSC 帧换成额外的 pipe、随机密钥或原生 hook，只改变消息路径，不能单独证明任何一个条件。阶段 0 已在五种真实终端会话中证实：同 shell 的脚本可伪造完成并继续读取下一行。

最有希望的方向是从**新建终端 Session 的第一刻**由 ShellSpan 启动并管理 shell 执行引擎，使完成状态来自引擎调用返回或解释器顶层循环，而不是 PTY 输出。若仍要求 Agent 将行写到所有进程共享的 PTY，还须证明其写入时不存在其他输入读取者；这在 Windows ConPTY、后台任务、嵌套 SSH、TUI 和同 shell `source` 场景下尚无通用证明。更强的设计是把 Agent 命令交给受信任的顶层命令队列，终端 PTY 只承担用户输入与真实输出；但它改变了原计划“后端向 PTY 写原始行和回车”的实现和回显语义，需要单独产品评审。

此研究不声称可无损接管**已经运行**的任意 Bash、zsh、PowerShell 或远程 shell。ShellSpan 当前本地 Session 用 `create_local_session` 启动普通 shell，远程 Session 在 SSH PTY 上调用 `channel.shell()`；两者都没有引擎级调用边界。历史 Session 应继续使用 `wrapperV1`，`direct` 保持原通道。

## 必须同时成立的证明义务

| 编号 | 后端需要的事实 | 不能作为证明的信号 |
| --- | --- | --- |
| C1：命令完成 | 顶层解释器已经结束本次前台命令，包括 `source`、函数、管道、异常和 Ctrl-C 的路径；`exit`/`exec` 被报告为 shell 结束或失效 | OSC/ANSI、提示符文本、输出静默、用户点击“已到提示符”、仅检查序号/nonce |
| C2：输入归属 | 下一条 Agent 命令只能被受信任的顶层命令读取器取得；不存在仍持有输入的前台或后台程序 | C1 本身、前端键盘锁、仅看进程树或某一时刻的前台进程组 |
| C3：事件来源 | 命令、同 shell 脚本、子进程和远端输出无法制造后端认可的 C1/C2 事件 | 把脚本可写的控制帧从 PTY 搬到普通文件描述符、pipe 或 `$Host` 回调 |
| C4：故障闭合 | 重连、shell 切换、控制层崩溃、事件缺失或结果不确定后均不再写入、不自动重试 | 猜测提示符、超时后自动发下一条、静默回退到其他执行通道 |

其中 C1 **不蕴含** C2。POSIX 前台进程组可帮助识别某些外部作业，但内建命令或 `source` 在 shell 进程中运行；进程组快照也不是与下一次写入原子绑定的许可。Windows 文档说明同一个 ConPTY 会话可连接多个客户端程序，因此 ConPTY 的输入/输出管道本身不提供“下一行归哪个程序”的证明。[POSIX 终端与作业控制](https://pubs.opengroup.org/onlinepubs/7908799/xbd/termios.html)、[Bash 函数执行环境](https://www.gnu.org/s/bash/manual/html_node/Shell-Functions.html)、[Microsoft ConPTY](https://learn.microsoft.com/en-us/windows/console/pseudoconsoles)。

普通“私有 FD”也不是默认可信边界：Bash 支持在当前 shell 中复制和重定向已打开的 FD；是否能使一个控制通道对同 shell 脚本和子进程不可用，必须按具体 OS、shell 与进程权限实证。Windows 可限制子进程继承句柄，但“不继承”不等于同一 shell 进程中的脚本不能调用主机能力。PowerShell 官方文档明确允许脚本通过 `$Host` 访问主机对象，所以 `PSHost` 的方法被调用不能当成完成证据。[Bash 重定向](https://www.gnu.org/s/bash/manual/html_node/Redirections.html)、[Windows 句柄继承](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance)、[PowerShell `PSHost`](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.host.pshost?view=powershellsdk-7.4.0)。

## 候选实现及其实际代价

| 路径 | 可成为可信完成来源的部分 | 尚未解决 / 与原目标的差异 |
| --- | --- | --- |
| 应用托管 PowerShell Runspace | ShellSpan 自己创建持久 Runspace，逐条提交脚本；以 SDK 调用返回及 `Completed / Failed / Stopped` 状态为 C1 候选，而非 `$Host` 回调或提示符文本。官方 SDK 提供主机、Runspace 与异步调用 API。[托管入门](https://learn.microsoft.com/en-us/powershell/scripting/developer/hosting/windows-powershell-host-quickstart?view=powershell-7.6)、[调用状态](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.psinvocationstate?view=powershellsdk-7.6.0) | 这是新建的宿主，不是现有 `powershell.exe` 的活 Runspace；需实测目录、alias、函数、变量、PSReadLine、原生程序/ConPTY、真实回显与后台读 stdin。SDK 调用完成不自动证明 C2。 |
| ShellSpan 管理的 Bash / zsh 解释器 | 在顶层解析与执行循环内部产生事件，绕开可由用户重定义的 `PROMPT_COMMAND`、`precmd`、`preexec`。Bash `enable -f` 仅有加载内建命令的文档能力；zsh 的常规 hook 是 shell 函数，模块可动态加载，但没有因此得到已证明的顶层完成边界。[Bash 内建加载](https://www.gnu.org/s/bash/manual/html_node/Bash-Builtins.html)、[zsh hook](https://zsh.sourceforge.io/Doc/Release/Functions.html)、[zsh 模块](https://zsh.sourceforge.io/Doc/Release/Zsh-Modules.html) | 很可能需要维护解释器级补丁或证明某原生扩展 API 足够；仅支持由 ShellSpan 从启动时管理且版本匹配的 shell。仍需独立解决 C2、控制通道权限和真实 PTY 回显。 |
| OS 进程/终端观察器 | `waitpid`、前台进程组或 Windows 进程句柄可作为额外校验 | 无法单凭它们知道 `source`/内建命令是否返回顶层，也无法把一次状态观察与下一次 PTY 写入原子绑定；不能代替解释器级事件。 |
| 远端受信任 helper | 在 SSH 连接时由受控远端组件启动受支持 shell，并通过独立、可认证的控制连接上报引擎状态 | 需要远端安装、版本/完整性与身份校验；现有 `channel.shell()` 会话的状态无法据此自动迁移。远端主机若不在信任边界内，也不能相信它声称的完成状态。 |

## 建议的最小验证顺序

1. **先验证输入归属，不接生产路由。** 在应用新建的真实 ConPTY/PTY 上，用后台读取者、嵌套会话、同 shell `source`、`exit`/`exec` 检查：C1 到达后，后续 Agent 行是否仍有机会被非顶层读取者消费。比较“继续写共享 PTY”和“受信任顶层队列直接提交”两种路径；后一条路径必须单独检查命令回显是否仍符合产品目标。
2. **PowerShell 单平台原型。** 用独立测试宿主创建一个持久 Runspace，连续验证 `cd`、alias、函数、未导出变量、cmdlet/原生程序、异常、Ctrl-C、`exit`，并记录 `shellSuccess` 与可空 `exitCode`。让脚本输出看似有效的完成帧并继续等待输入；只有真实 SDK 调用完成才允许下一次提交。还要验证原生交互程序不能在调用返回后继续读取下一次输入。[`BeginInvoke` / `EndInvoke`](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.powershell.begininvoke?view=powershellsdk-7.4.0)、[Runspace 会话状态](https://learn.microsoft.com/en-us/powershell/scripting/developer/cmdlet/windows-powershell-session-state?view=powershell-7.6)。
3. **Bash 解释器原型。** 只在测试目录中基于固定版本研究顶层循环返回点和中断/退出路径；证明事件不能被 `source`、函数、hook 或子进程写出的字节伪造，再做真实 PTY 的 C2 验证。zsh 只在同一证明方法成立后单独研究。不要把原型 hook 或解释器二进制用于现有 Session。
4. **最后研究 SSH。** 只有本地 C1–C4 通过后，才评估远端 helper 的部署、身份和断线语义。Docker SSH fixture 不替代真实 macOS/Linux 桌面或现有远端会话验证。

进入生产设计的门禁是：同一受支持平台上的真实终端证明 C1–C4 全部成立，前台/后台输入竞争与伪造事件测试均不能导致错误写入，且原始回显、状态继承、审批/lease、取消/接管、隐私和 `direct`/`wrapperV1` 回归完整通过。**目前这些证据不存在，因此维持阶段 0 NO-GO；下一步仅适合独立原型研究。**
