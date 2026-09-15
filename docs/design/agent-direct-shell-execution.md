# Agent 原生命令输入方案

> 状态：设计提案  
> 适用范围：ShellSpan 的可视终端执行模式  
> 基线：现有 `boundTerminal` PTY、TerminalLeaseManager 与审批链路  
> 目标：Agent 将命令原样提交给已绑定的交互式 shell，用户直接看到该 shell 的回显、输出和提示符。

## 1. 要解决的问题

现有 `boundTerminal` 确实使用当前终端的 PTY，但每条命令被包装后交给子 shell 执行。终端中显示的 `[Agent] $ ...` 是合成文本。因此 `cd`、alias、函数、未导出变量和提示符状态不能完整体现“Agent 在这个 shell 里操作”。

目标路径是：一次性为终端安装 shell 集成；之后每条 Agent 命令只写入经过校验的原始命令和回车。shell 集成报告命令开始、完成和状态，后端在原始 PTY 流中剥离集成帧，再把真实回显、输出和提示符送到 xterm。模型继续只在一次工具调用完成后获得有界、脱敏的结果。

这不是取消结构化工具。`run_terminal_command` 仍负责审批、审计、超时、取消和结果返回；变化只发生在已批准命令的执行方式。此架构只在 Agent Session 的 `executionSurface === boundTerminal` 时启用。`executionSurface === direct` 继续使用现有独立执行通道，不安装 shell 集成、不向当前终端写入命令，也不显示可视终端 lease 状态。文件、SFTP、MCP 等非 shell 工具继续使用各自通道。

## 2. 用户能感受到的流程

1. 用户在某个终端启动 Agent；Agent Session 记录该终端的 session ID。之后切换标签或分屏焦点，不会把运行中的命令改发到别的终端。
2. ShellSpan 在该终端空闲时完成一次集成握手。成功后显示“已连接当前 shell”；失败则给出原因和可选的后台执行方式，不静默改用后台执行。
3. Agent 提出命令。现有风险分类与审批先运行。终端状态条区分“等待审批”“正在输入”“正在执行”“分析结果”；用户始终可以中断并接管。
4. 获准后，终端出现 shell 对原始命令的正常回显；程序输出实时接续。命令结束后保留真实提示符。工具卡显示退出状态和结果，Agent 才开始下一步。
5. Agent 连续思考和执行多条命令时，终端保持绑定并阻止用户输入插入；只在当前 turn 结束或用户接管后恢复输入。切换标签不打断执行，也不强制把焦点拉回。

第一条命令的集成准备应在用户发起 Agent turn 后、模型计算期间异步完成；不得在终端已有半行输入、刚提交但尚未确认、已知凭据提示或终端不在 shell 提示符时注入初始化代码。远程终端无法证明处于提示符时，要求用户先回到 shell 提示符并显式启用该终端的集成；不得盲发探针到 TUI、REPL 或密码提示。

## 3. 不变的安全边界

- 保留 Session 冻结目标、工具参数校验、effect/risk 分类与审批顺序：审批完成后才取得命令级 lease，取得 lease 后才写 PTY。
- 保留后端 `TerminalInputSource` 校验；前端输入锁只负责即时体验。一个 Agent turn 可保留现有 turn guard，命令之间的短暂思考也不允许用户输入插队。
- 保留 Stop、Esc、按钮接管、Ctrl-C、终端关闭/断线、超时和 Runtime shutdown 的幂等清理。接管后不得自动重试原命令。
- 原始终端显示遵循用户终端本身的可见性；模型结果、持久事件和诊断日志仍在 Rust 侧脱敏并限长。
- 原样输入会进入 shell 的正常回显，且可能进入 shell 历史。首版拒绝包含已识别明文凭据或不可显示控制字符的命令，并在 UI 说明此模式的历史记录语义。不得依靠隐藏回显再合成一行命令来宣称“原样输入”。

## 4. 协议与状态机

每个 terminal session 维护 `integrationGeneration`、shell 类型、能力版本和就绪状态；每个 Agent 命令维护 operation ID、目标 session ID、状态、capture 边界和超时。集成帧使用私有、版本化的 OSC 序列，含随机会话标识、递增序号、`ready | start | end`、shell 状态及可用的退出码。后端将 lease 期间的下一对 `start/end` 绑定到当前 operation；原始命令及 shell 集成都不需要嵌入 operation ID。会话标识只用于关联和减少意外碰撞：命令与 shell 共享执行上下文，不能把它当成对恶意命令输出的密码学证明。工具输出和集成帧始终按不可信输入处理。

```text
终端连接 → 集成未知 → 安装中 → 就绪
                               ↓
审批完成 → 申请 lease → 前端 ready → 写原始命令+回车
                               ↓
                         等待 start → 实时输出 → 收到 end → 释放命令 lease
                               ↓                          ↓
                         失败/超时/断线             Agent 读取结果
                               ↓
                         结果不确定，停止后续命令并提示接管
```

后端先注册 operation 和原始流解析器，再写入命令，避免快速命令的事件丢失。只有匹配当前 session、generation、序号，且由后端绑定到当前 operation 的 `end` 才能结束等待。解析器跨任意 chunk 边界识别 OSC BEL/ST 终止符、ConPTY 换行与折行；在进入 xterm、复制缓冲、AI context buffer 前剥离集成帧，保留其他程序的 OSC/ANSI 和 `end` 后同一 chunk 的真实 prompt。展示流不因模型 capture 达到 1 MiB 而停止；大输出的 UI 背压要与命令超时协调，不能因为界面短暂暂停读取就误报命令失败。

没有 `start`、没有 `end`、集成被覆盖、shell 被 `exit`/`exec` 关闭、解析失败或超时，都不能依据“输出安静”或提示符文本伪造成功。先发送一次受控 Ctrl-C 并有界等待；仍无法确认时返回 `uncertain`，停止 Agent 的后续终端命令，保持清楚的“请接管/重连”状态。任何不确定结果都不得自动重试。

## 5. Shell 集成适配

所有适配器都要满足同一契约：只在交互式 shell 的顶层命令边界报告事件、在其他 hook 之前保存状态、不吞掉用户已有 hook 的结果、可重复安装、能探测被用户配置覆盖，并且不写用户的长期配置文件。安装代码只在会话级运行一次，使用现有输出过滤隐藏安装本身，也不能污染 shell 命令历史；普通命令不再包装。嵌套 SSH、tmux 或切换 shell 后，原有集成不得继续被误判为就绪，必须重新握手。

| Shell | 候选接入点 | 必须验证的语义 |
| --- | --- | --- |
| Bash | `PS0` 报告开始；`PROMPT_COMMAND` 报告完成 | 兼容原有字符串/数组 hook、提示符主题、`$?`/管道状态、Ctrl-C、版本差异。不要用每条简单命令都会触发的 `DEBUG` trap 直接当顶层边界。 |
| zsh | `preexec` / `precmd` hook | 与已有 `*_functions` 组合，进入 hook 时立即保存 `$?`，兼容主题、补全和 ZLE 重绘。 |
| PowerShell | PSReadLine 可用时研究提交前回调；`prompt` 函数报告完成 | 保留原 `prompt` 和 PSReadLine 行为；区分 `$?` 与可能陈旧的 `$LASTEXITCODE`。如果无法可靠提供开始边界和退出状态，就不宣称该版本支持。 |
| 远程 SSH shell | 在已连接的交互式 shell 中会话级安装对应适配器 | 不修改远端 profile；握手超时、只读环境、shell 重启和重连要明确降级为不可用。 |

PowerShell 的 `$?` 是 shell 成功布尔值，`$LASTEXITCODE` 是最近一次原生程序的退出码，二者不能无条件互换。公共结果契约应允许 `exitCode: null` 并单独记录 `shellSuccess`；只有能证明是刚结束的原生程序时才报告数值退出码。`exit`/`exec` 会关闭或替换当前 shell，属于真实终端语义，应作为终端结束处理。

首版只接受单物理行、前台、有界、无需后续 stdin 的命令；拒绝 CR、LF、NUL、ESC 和其他不可显示控制字符。TUI、REPL、密码/OTP 提示、持续后台任务与任意多行脚本不在首版范围。需要多行逻辑时，Agent 可先用现有文件工具建立脚本，再在终端调用该脚本，但不能因此绕过文件工具原有审批。

## 6. 与现有代码的衔接

| 位置 | 处理 |
| --- | --- |
| `src-tauri/src/agent_runtime/native/pty.rs` | 将 wrapper 执行器保留为兼容实现；增加原生命令 operation、集成帧解析器和 shell 适配器接口。 |
| `src-tauri/src/agent_runtime/native/runtime.rs` | 在已批准的 PTY 分支按 Session 记录的协议版本选执行器；统一取消、结果和 `uncertain` 处理。 |
| `src-tauri/src/lib.rs` 的 `emit_data` | 保持“原始输出先过后端解析、再 emit 前端”的位置，防止内部帧进入 xterm。 |
| `src-tauri/src/agent_runtime/native/terminal_lease.rs` | 复用 lease、turn guard、输入来源和 frontend ready 握手；增加集成安装的独占阶段。 |
| `src/components/terminal/terminal-controller-layer.tsx` | 复用输入抑制、lease 生命周期与接管；移除新协议下的合成命令行过滤，展示真实回显。 |
| `src/components/terminal/terminal-pane.tsx` | 状态条按准备、审批、执行、分析和异常显示，保留滚动/选择/复制/搜索。 |

Session Header 仅对 `boundTerminal` 增加版本化字段，例如 `terminalExecutionProtocol: wrapperV1 | shellIntegrationV2`。已存在的可视终端 Session 保持 `wrapperV1`；新建可视终端 Session 明确记录 `shellIntegrationV2`，执行前再做终端能力握手。新建 Session 的界面仍只有“后台执行 / 可视终端”两种执行方式，不额外暴露协议选项。新模式不可用时给出原因，由用户显式切换为后台执行；不得静默回退，也不得改变现有 Session 的持久化语义。

## 7. 开发顺序与每阶段门禁

### 阶段 A：先证明 Shell 能力，不碰现有执行路由

在真实 PTY/ConPTY 与 SSH fixture 中做最小实验：同一 shell 连续执行 `cd`、alias/function/变量、成功、非零退出、Ctrl-C；验证开始/结束帧、提示符兼容和 PowerShell 状态语义。优先在当前 Windows 开发机验证 PowerShell，再用隔离 SSH fixture 验证 Bash；zsh 在 macOS/Linux runner 验证。输出一张支持矩阵，并证明伪造或提前输出完成帧不会导致下一条 Agent 命令写入仍在运行的程序。若无法证明，`shellIntegrationV2` 不得自动连续执行任意命令。PowerShell 无法达成契约时，先交付通过的 shell，不以输出静默替代完成信号。

### 阶段 B：完成一个 Bash 纵向闭环

增加协议版本、会话级安装状态、后端解析器和原样写入；复用现有审批/lease/结果管线。先用一个 Bash 真实 PTY 跑通“用户先 `cd`，Agent 再 `pwd`，结果与屏幕一致”，以及非零退出、连续两条命令和接管。旧 wrapper 与 direct 模式必须保持原行为。

### 阶段 C：接入界面和其余适配器

在现有状态条中呈现安装、等待审批、执行、分析和结果不确定状态；用户第一次受阻输入得到明确提示，Esc/按钮共用一次接管动作。再接 zsh、PowerShell 和远程 Bash；每接一个适配器就跑同一套契约矩阵，不把未经验证的 shell 标记为可用。

### 阶段 D：异常、隐私与发布验证

覆盖半行输入、未确认用户提交、快速命令、跨 chunk OSC、伪造/重复帧、大输出背压、超时、断线、shell hook 被覆盖、窗口销毁、Runtime 重启和完成/接管竞态。检查终端复制文本不含内部帧，模型请求与 Session JSONL 均经脱敏。按平台做实际桌面观察，确认命令回显、输出和真实 prompt 连续且没有合成行。

每阶段以“可运行的端到端路径 + 定向测试 + `direct`/旧可视模式回归”为门禁，再进入下一阶段。测试必须断言 `direct` 从未初始化 shell 集成、未获取可视终端 lease，也未向绑定 PTY 写入 Agent 命令。最后更新原可视终端设计及验收文档，以支持矩阵和实际证据决定可视终端内部协议的切换，不依赖仅通过单元测试的推断。

## 8. 首版验收场景

1. 用户在 Bash 输入 `cd /tmp` 并定义 alias/函数；Agent 原样执行 `pwd` 和该 alias/函数，终端与工具结果一致，随后用户仍停留在同一个 shell 状态。
2. 一条命令分三秒输出三行并非零退出：三行逐步可见，完成帧不显示，退出状态正确，真实 prompt 保留。
3. Agent 运行期间切换标签：命令继续在原 session；切回后输出完整，接管只作用于原 session。
4. 终端有半行输入、处于 TUI/凭据提示、集成失效或不支持 shell：没有原样命令写入，也没有静默改走其他通道。
5. 超时、Stop、Esc、按钮、断线、终端关闭及应用重启均不触发自动重试；可确认结束时释放 lease，不可确认时停止后续命令并明确要求接管。
6. 命令中的明文凭据与控制字符被拒绝；正常命令回显符合 shell 行为，模型和持久日志仍按现有规则脱敏。

参考 shell 文档：[Bash `PS0` / `PROMPT_COMMAND`](https://www.gnu.org/software/bash/manual/html_node/Bash-Variables.html)、[zsh `preexec` / `precmd`](https://zsh.sourceforge.io/Doc/Release/Functions.html)、[PowerShell `prompt`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_prompts)、[PowerShell 自动变量](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_automatic_variables)。
