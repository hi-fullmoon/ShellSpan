# Agent 可视终端原生命令输入研发计划

> 状态：待执行；本文件是研发计划，不代表架构门禁已通过。  
> 对应设计：[agent-direct-shell-execution.md](agent-direct-shell-execution.md)  
> 当前基线：`boundTerminal` 使用 PTY 包装命令；`direct` 使用独立执行通道。  
> 交付目标：仅在新建可视终端 Agent Session 中，向绑定的交互式 shell 原样输入命令、实时展示真实回显和输出，并在可靠完成边界后将结果交给 Agent。

## 1. 范围和产品行为

- `executionSurface === boundTerminal` 是唯一改造入口。新建可视终端 Session 记录 `shellIntegrationV2`；历史可视终端 Session 继续按 `wrapperV1` 恢复。版本随 Session 持久化，不能由当前 UI 状态推断。
- `executionSurface === direct` 的执行、审批和界面保持现状；不安装 shell 集成、不申请可视终端 lease、不向绑定 PTY 写命令。文件、SFTP 和 MCP 等工具保持原生通道。
- 新模式仍通过 `run_terminal_command` 的校验、风险分类、审批、审计和结果管线。不得因选择可视终端而提高权限。
- 用户只看到“后台执行 / 可视终端”两种执行方式。新模式不可用时显示准确原因和显式切换路径；不自动改走后台，也不自动改用旧包装协议。
- 第一版只支持单物理行、前台、有界、无需后续 stdin 的命令。TUI、REPL、密码/OTP 提示、持续后台进程和多行脚本留待后续独立设计。

目标体验：终端在 Agent turn 开始时绑定，集成准备尽量与模型思考重叠；批准后只写原始命令与回车。用户看到 shell 的真实回显、逐步输出和最终提示符。切换标签不改变目标，等待下一条命令时显示“Agent 正在分析”，Esc 或按钮可一次接管。未经确认命令结束时，Agent 不会再写下一条命令。

## 2. 阶段 0：架构可行性与安全门禁

此阶段只做真实 PTY/ConPTY、SSH fixture 实验和决策记录，不改生产执行路由。先回答“什么事实足以允许下一条命令进入该 PTY”，再开发自动连续执行。

| 实验 | 必须观察和记录的结果 |
| --- | --- |
| Bash、zsh、PowerShell 的一次性 hook | 同一 shell 连续 `cd`、alias/函数、成功、非零退出和 Ctrl-C；开始/结束帧、原提示符与 shell 状态保持正确。 |
| 完成帧伪造 | 命令或同 shell 中 `source` 的脚本提前输出有效 `end`，之后继续读取 stdin；后端绝不能据此写入下一条 Agent 命令。随机 nonce 不能单独作为通过证据。 |
| 原始输入进入非 shell 程序 | 在 TUI、REPL、密码提示和嵌套 SSH 中尝试初始化与派发；必须在写入前拒绝，或将该环境列为不支持。人工点击“已到提示符”本身不算机器验证。 |
| PowerShell 状态 | 分别检查 cmdlet、原生程序、管道、异常、`exit`；明确 `shellSuccess` 与 `exitCode` 何时可报告。 |
| 现有 hook 共存 | 与用户 prompt/theme、Bash `PROMPT_COMMAND`、zsh hook、PSReadLine 共存；安装失败可回滚且不污染历史命令。 |

阶段交付物是支持矩阵、威胁模型、可重复的攻击性测试 fixture 和一份通过/不通过决策。**若无法证明 in-band `end` 不会导致错误的下一次写入，不得把任意命令自动连续执行列入本轮范围。**此时只可提出经单独评审的收窄方案，例如限定命令集合或在每条命令后等待用户明确接管；当前可视模式继续使用 `wrapperV1`，不能静默推出不可靠的 V2。

## 3. 阶段 1：Session 契约与终端所有权

进入条件：阶段 0 的自动连续执行边界已明确，并有可重复验证方法。

实施内容：

1. 在 Agent Session Header、事件、恢复投影、Rust/TypeScript 类型与 IPC 中增加可视终端协议版本。旧 `boundTerminal` 缺失版本时按 `wrapperV1` 恢复；`direct` 不携带或不使用该版本。切换执行方式仍只允许在安全的空闲边界。
2. 将可视 turn guard 的获取移出“失败只记日志”的事件回调，变成 Agent 开始占用终端前的硬门禁。锁失败立即终止本次可视执行，不让 Agent 继续推理后再尝试写入。
3. 定义独立的集成安装所有权（例如 setup lease）及 `installing → ready | failed` 状态，覆盖后端来源校验、前端 output ready、超时、取消和关闭。安装不是一条经审批的用户命令，但任何初始化字节也不得绕过终端所有权检查。
4. 将“当前激活终端”固定为 Agent Session 目标的 session ID；重连产生新 session ID 时，旧集成 generation 立即失效，不自动迁移正在执行的操作。

退出门禁：历史 Session 恢复语义不变；两个 Agent 争用、用户输入竞争、安装中取消与锁失败均在写入前被拒绝；`direct` 回归断言没有 hook、setup lease 或 PTY 写入。阶段结束时即使 V2 尚未运行，既有模式仍可正常使用。

## 4. 阶段 2：会话级集成与原始输出解析

进入条件：阶段 1 的硬门禁和版本契约通过。

实施内容：

1. 建立 shell 适配器接口：检测能力、一次性安装、报告 `ready/start/end`、读取 shell 状态、检查 generation、卸载或失效。初始化不得修改用户长期 profile，也不得留在 shell 历史中。
2. 在后端现有 `emit_data → observe_terminal_output` 位置解析原始 PTY 流。流式识别跨 chunk OSC、BEL/ST、ConPTY 折行；只有本次有效控制帧被剥离，其他 ANSI/OSC 和 `end` 后的真实 prompt 继续进入 xterm。
3. 建立三个结果流：真实 display；有界原始 capture；去 ANSI、脱敏、限长后的 model/persistence 结果。xterm 展示不得因 1 MiB 模型捕获截断而停止；背压暂停须与命令超时协调。
4. 将“集成未就绪、被覆盖、shell 切换、解析错误、缺失帧”映射为稳定错误。未知状态不得用输出静默或提示符文本补成成功。

退出门禁：任意 chunk 边界、伪造/重复/乱序帧、快速命令、大输出和 `end` 后 prompt 的测试通过；初始化内容不出现在屏幕复制文本、AI context buffer 或 Session 日志中；旧 `wrapperV1` 解析测试保持通过。

## 5. 阶段 3：Bash 原样命令纵向闭环

进入条件：阶段 2 的解析器和控制事件已在真实 Bash PTY 中验证。

实施内容：

1. 在已批准的 `run_terminal_command` 可视分支取得命令 lease、等待前端 ready、注册 operation，再向冻结的 PTY **一次性写入原始命令和 shell 回车**。普通命令不调用 `/bin/sh -c`，也不生成合成的 `[Agent] $ ...`。
2. 用 shell 的 `start/end` 确定 capture 边界和完成状态。只对当前 operation 形成工具结果；命令之间保留 turn guard，避免用户输入插入。
3. 对 Stop、超时和接管执行一次受控 Ctrl-C，并定义原子终态。进入 `uncertain` 后禁止 Agent 后续写入；明确“Agent 锁保持到用户接管或终端关闭”“接管释放后用户可能面对仍在运行的进程”的界面与后端行为。不得自动重试。
4. 增加命令输入校验：拒绝 CR/LF/NUL/ESC 等控制字节、已识别的明文凭据和超出长度边界的输入。不能保证无需后续 stdin 的命令在运行时必须依靠超时和接管恢复。

退出门禁：用户先 `cd`、定义 alias/函数及未导出变量，Agent 随后原样使用，真实终端和工具结果一致；三秒分段输出实时可见；非零退出、Ctrl-C、连续两条命令、伪造完成帧、结果不确定及输入竞争都通过真实 PTY 测试。`direct`、历史 `wrapperV1` 不回归。

## 6. 阶段 4：用户流程与逐平台适配

进入条件：Bash 纵向闭环已通过，并能在开发包中观察真实回显和提示符。

前端按 `preparing / waitingApproval / running / analyzing / uncertain / takenOver` 展示，不在终端里伪造命令行。首次受阻键盘输入提供可访问提示；滚动、复制、选择和搜索继续可用。接管按钮和 Esc 使用同一幂等动作。可视模式失败时提供显式停止与切换为后台执行的路径，避免用户被锁在已失败的 Session 中。

在同一契约矩阵下逐个接入 zsh、本地 PowerShell、远程 SSH POSIX。每个适配器都必须独立通过阶段 0 的开始/结束与状态语义、阶段 2 的流解析、阶段 3 的接管和隐私检查，才可在支持矩阵中标为可用。远程现有会话若无法在写入前证明处于受支持的顶层 shell，就不启用 V2；不得向任意活动程序盲发初始化探针。

PowerShell 工具结果应将 `shellSuccess` 和 `exitCode: number | null` 分开；模型结果、持久事件和工具卡都要处理“数值退出码未知”，不能把旧 `$LASTEXITCODE` 当作当前 cmdlet 的退出码。

退出门禁：UI 生命周期、重复/乱序 lease 事件、按钮/Esc 单次接管、标签切换、终端重绑与 direct 模式回归通过；支持矩阵中的每个平台都经过真实 PTY/ConPTY/SSH 实测。

## 7. 阶段 5：发布验证与回退

进入条件：拟发布平台均通过阶段 4；不通过的平台保持 V2 不可用。

自动化门禁在现有 `pnpm test:agent-visible-terminal` 与 `pnpm test:agent-visible-terminal:ssh` 基础上扩充 V2 定向测试，且运行 `cargo fmt --all -- --check`、`cargo check --all-targets`、`pnpm test`、`pnpm build`。测试脚本必须同时覆盖新 V2、历史 V1 和 `direct`；不能用 Docker SSH 成功替代本地 macOS/Linux 的桌面验证。

发布候选包手工验证至少包括：真实回显和提示符、alias/目录状态继承、快速命令、分段输出、超 1 MiB 输出、切换标签、半行用户输入、已知凭据提示、Stop/超时/接管/断线/关闭/重启，以及复制屏幕文本与导出 Session 日志检查。每项记录平台、shell 版本、结果和未通过原因。

按 Session 协议版本回退：V2 停止用于新建可视 Session 时，不改写已有 Session 的 Header，不回放结果不确定的命令；历史 V1 和 `direct` 继续可用。若 V2 Session 正在运行，先走正常取消/接管与 lease 清理，再允许用户在空闲时显式选择后台执行。

## 8. 执行规则与完成定义

- 阶段串行推进；每阶段交付可复现测试、改动说明、支持/不支持矩阵和剩余风险。上一阶段门禁未通过，不开启依赖它的生产路径。
- 开工前保留当前工作区的未提交修改，不清理或覆盖无关文件。生产代码与实验 fixture 分开，避免阶段 0 的原型被误认为已上线实现。
- 所有变更以“只有可视终端模式受影响”为回归边界；无审批绕过、无用户与 Agent 输入拼接、无协议帧泄漏、无自动重试不确定命令。
- 只有阶段 0 的错误写入风险得到可验证的解决，且拟发布平台、真实桌面流程和异常恢复均通过后，才能把 `shellIntegrationV2` 标记为可交付。
