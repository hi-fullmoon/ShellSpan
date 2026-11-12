# 原生终端后续实施计划

2026-11-11 更新。以 [统一验收标准](agent-terminal-input-acceptance-checklist.md) 的五个发布绑定为范围。Bash 4.1／4.4 保留按需兼容验证。编辑器的生产配置见 [NIP 契约](../../protocol/agent/runtime/native-input.md) 和 [准入清单](../../protocol/agent/runtime/native-editor-admission.json)。

## 当前进度

| 范围 | 已有结果 | 仍需验证 |
| --- | --- | --- |
| macOS arm64 本地 PTY | 第 2 期日常输入与显示 144 项通过。第 3 期提交安全和恢复在 `26d83a6d` 的冻结批次中 225 项通过。两期包含当时的四个 Shell 组合。[第 2 期记录](agent-terminal-input-macos-acceptance-2026-11-06.md#2026-11-10-第2期最终补验与交付核对r70r77) | 复验后续 ZLE 提交与显示改动，继续父 Shell、历史、后台作业、临时脚本、资源异常及清理。第 3 期原报告位置为 `.artifacts/tests/agent-terminal-input/20261111-macos-phase3-plan/REPORT.md`，当前工作区缺少该报告，须在引用逐项证据前取得原归档。 |
| Linux arm64，glibc 2.36，受控 SSH | `2aaaaf75` 核对了 Bash 5.3 的 Linux 资源、受控 SSH 夹具的 Shell 绑定、真实 Linux PTY 和浏览器显示。 | 补实际 App 的 Bash 5.3 和 Zsh 5.9 SSH 端到端验证，涵盖 SFTP、relay、断线重连及恢复。 |
| Windows x64，ConPTY | `wt5c1` 已在 D 盘实际安装、启动并通过三种 Shell、接管清稿、运行中关闭、进程重启、WebView2 实际交互、异常资源和标准卸载。真实临时脚本及 PowerShell 无模型验证均已留证。[内测包与逐项验收](../../.artifacts/tests/agent-terminal-input/windows-wt5c1/REPORT.md) | 更广的统一发布子案按逐项状态补验，包括多代次重绑、选区锚点及完整 Quality Gate。 |
| 当前源码与交付 | `2aaaaf75` 的 Bash 5.3 收敛和 `e63021ea` 的 PowerShell 7 收敛均已推送至 `origin/main`。两平台 Bash 5.3 资源和包内清单已核对，macOS 随包源码离线重建、前端全量测试及生产构建已通过。 | 以各平台最新候选提交继续实机验收。正式发布仍待完成。 |

## macOS arm64 研发计划

从本地 `main` 的 `2aaaaf75` 开始。覆盖 macOS 本地 PTY 的 Zsh 5.9 / ZLE 5.9 和 Bash 5.3 / Readline 8.3.6。Bash 4.1／4.4 用于按需兼容验证及正式包的普通终端降级检查。按实际提交差异复核旧验收证据，先检查 `15ee28ad` 的 ZLE 提交行为、`aff557d9` 的终端显示改动和 `2aaaaf75` 的 Bash 随包资源变更。

| 批次 | 研发顺序 | 验收与交付 |
| --- | --- | --- |
| 1. 修复提交与显示回归，交付本地内测包 | 先重建原生资源。在两个 Shell 上补验正常命令、语法拒绝、取消清稿后 Enter、重复提交、接受前后关闭和 PTY 尾部输出。发现差异时定位到 Shell 适配器、后端提交协调或前端显示，再补最小回归。 | 正常命令只有一次接受和一次预期效果，拒绝和提交前取消没有效果，结果不明的提交保留恢复门禁。终端退出前读完尾部输出，恢复普通显示。生成本地内测 DMG，在隔离数据目录中安装和启动，核对实际加载的 ZLE Core、模块以及 Bash 5.3 资源。旧 Bash 仍可手工输入和运行 TUI，Agent 原生提交被拒绝。记录候选提交、包摘要和已验范围。 |
| 2. 补齐父 Shell 语义、字节边界和历史 | 先核对 `cd`、变量、函数、退出状态和启动文件，再覆盖 8192 字节完整输入与 8193 字节拒绝。运行 Bash 5.3 本地矩阵的 6 项，逐项核对 ZLE 历史选项、两个 Shell 进程的历史共享、ZLE hook／widget 与信号恢复。 | 在隔离 HOME 中用实际父 Shell 和历史文件取证。批准源码、编辑器缓冲和提交证明按字节核对，拒绝案无输入或执行效果。记录两个 Shell 的实际行为和差异。 |
| 3. 补齐后台作业和临时脚本 | 核对后台作业开始、轮询、停止、结算和尾部输出，再补临时脚本的批准后写入、读回、路径执行、重启复用、归属冲突和符号链接拒绝。先跑组件和已有的无模型用例，再安排真实模型驱动的文件链路。 | 作业身份与输出归属一致，轮询和停止不污染用户历史。脚本保持冻结的目标和父 Shell 环境，运行中及结果不明的脚本保留引用。严格 Unicode 模型用例继续登记为延期。 |
| 4. 验收异常资源、清理和最终候选 | 检查错误摘要、未知构建、错误平台、缺符号和实验资源。按归属清理本批次的测试脚本、凭据引用、进程及目录。重新核对有修复的路径和最终包的安装启动。 | 异常资源无原生能力，普通终端可继续使用。清理结果、包内资源和应用启动有证据。归档候选源码、DMG、摘要及逐项状态，按 macOS 的适用项给出验收结论。 |

从仓库根目录用 `pnpm native:prepare` 准备资源，用 `node scripts/native-input-p2/matrix.mjs --local-only --list-cases` 确认 Bash 本地范围。真实 PTY 回归使用 Rust `native_production_` 测试组。双 Shell 的 App、显示和恢复验证使用[现有实机入口](../../scripts/verify-ai-session-stream.mjs)，实际安装包另核对资源路径与 Shell 身份。前台操作和模型用例集中在对应验收时段执行。

### 2026-11-11 本地内测 R01

从 `2aaaaf75` 的完整冻结源码生成首个 [macOS arm64 内测 DMG](../../.artifacts/releases/macos-native-input/20261111-r01/ShellSpan_2.5.0_arm64_internal_r01.dmg)。独立安装、启动、实际进程映射和包内摘要核对均通过。安装包中两种 Shell 的自然退出均保留最后一行 PTY 输出。签名验收 App 的正常执行、语法拒绝、重复调用和运行中关闭已在两个 Shell 上通过。旧 Bash 4.4 已在安装包中启动 Vim。双 Shell 逐项状态和剩余条件见 [R01 验收报告](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r01/REPORT.md)。

### 2026-11-11 本地内测 R02

修复 macOS 本地 Bash 私有控制帧在 Readline 唤醒前的写入超时。双 Shell 的 8192 字节命令均有原生完整证明和一次接受，8193 字节均在写入前拒绝。R02 DMG 已实际安装、启动和核对实际 ZLE Main/Core/模块与 Bash 5.3 资源，双 Shell 关闭前的 PTY 尾部均可见。历史、后台作业、临时脚本、资源异常及各验收条款按独立结果记录，严格 Unicode 模型子项维持延期。[R02 DMG](../../.artifacts/releases/macos-native-input/20261111-r02/ShellSpan_2.5.0_arm64_internal_r02.dmg) · [SHA256SUMS](../../.artifacts/releases/macos-native-input/20261111-r02/SHA256SUMS) · [双 Shell 验收与修复清单](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r02/REPORT.md)

2026-11-12 完成该内测包的复验和清理。Bash 5.3 六项本地实机模型用例均已取得通过证据，ZLE 七种历史设置和双进程历史读取通过。两种 Shell 的真实后台作业、模型临时文件链及重启读回均通过。实验、错误摘要、平台不匹配和缺符号的拒绝路径已核对，历史 SSH 转发超时项通过独立复验。实际 App 崩溃重启、完整人工选择/视口、焦点及发布门禁等仍按报告逐项留档。

## Windows x64 研发计划

原生执行只覆盖 PowerShell 7.6.9、私有 PSReadLine 2.4.5-shellspan6 和 ConPTY 1.25.260930003。PowerShell 5.1 覆盖普通终端输入、TUI 和 Agent 原生执行拒绝。双宿主批次按原范围留档，PowerShell 7 已有证据经源码和制品差异核对后可用于确定补验范围。[Windows 第 1 期记录](agent-terminal-input-windows-acceptance.md#一期本批结果)

| 顺序 | 工作 | 完成条件 |
| --- | --- | --- |
| 1. 交付 Windows 内测候选（A01–A06、E03、E04） | 在 Windows x64 主机冻结当前候选提交和 MSVC，重建资源并生成安装包。使用隔离数据安装启动，分别测试未指定 Shell、缺少匹配的 `pwsh.exe` 和明确指定 `powershell.exe`。 | 默认终端启动已匹配的 PowerShell 7 并获得 Agent 原生能力。后两种场景保留普通终端输入与 TUI，Agent 原生执行不可用。记录实际 `pwsh.exe`、PSReadLine 和 ConPTY 的加载身份及安装包 SHA-256。 |
| 2. 补齐 PowerShell 7 执行与恢复（B01–B08、C01–C07、E06） | 先验证批准、单次提交、取消后清稿、运行中关闭及进程重启恢复。再补 UTF-16／UTF-8 与 8192／8193 字节边界、父 Shell 语义、历史、后台作业和临时脚本。 | 对应的自动化和实际 App 用例逐项留证。拒绝与提交前取消无副作用，结果不明时保留恢复门禁。单独记录无模型和真实模型的执行结果。 |
| 3. 补齐桌面交互、异常资源和清理（A03、A04、D01–D06、E04、E05、E07） | 在交互式 Windows 桌面验证 WebView2、宽窄窗口、历史视口、选择／复制／搜索、焦点和人工接管。补验错误资源、未知摘要、正常卸载和临时资源清理。 | 同一候选包具有实际桌面、异常准入及清理证据。归档安装包、摘要和 Windows 验收状态。 |

构建、资源检查及命令行用例可继续通过 Windows SSH 运行。安装启动、WebView2 显示和人工输入在交互式桌面核验。使用现有 [Windows 安装包验收入口](../../scripts/native-input-p3/windows-package-batch.mjs)。

### 2026-11-12 Windows 内测 R01

在远程 Windows D 盘建立 `wxidvr4p` 基线批次并独立检出 `e63021ea`。PowerShell 7 单配置资源、私有 PSReadLine 源码重建、此前 9 项 Windows 回归和 7 项资源准入组件案已通过。交互桌面会话 1 已完成预检。应用库编译四次因主机提交内存不足退出，尚未生成安装包。[基线批次与逐项验收记录](../../.artifacts/tests/agent-terminal-input/windows-idvr4p/REPORT.md)

实际 ConPTY 的无模型命令行回归已验证 8192／8193 字节边界、提交键前清稿、后台作业、历史、管道故障及缺失导出符号拒绝。父 Shell 准备超时定位为控制管道写入等待遇到已释放的 `SafeWaitHandle`。改为等待异步写入 Task 后，53 次命令行验证通过，其中父 Shell 连续 12 轮。D 盘 `wfa0239` 已重建绑定修复源码的单 PowerShell 7 资源。[基线逐案证据](../../.artifacts/tests/agent-terminal-input/windows-idvr4p/REPORT.md#无模型命令行回归)

`wfa0239` 已用相同工具链复用依赖并重新编译候选测试程序。9 项 Windows 回归、7 项资源准入、6 项临时脚本和长度检查、12 项账本回归均通过。桌面验收已核对主机上的匹配 `pwsh.exe`、系统 Windows PowerShell、Neovim 与 WebView2 Runtime 文件。[候选回归与桌面预检](../../.artifacts/tests/agent-terminal-input/windows-wfa0239/REPORT.md)

`wfa0239` 已生成 NSIS，并在交互会话 1 实际安装和启动。同一安装通过三种 Shell 场景。默认案的真实模型获批后经 `terminal_execute` 写入一次预期效果，两种 PowerShell 5.1 案均完成实际 Neovim 输入和写盘，Agent 可视命令不可用。[安装包与首轮验收](../../.artifacts/tests/agent-terminal-input/windows-wfa0239/REPORT.md#首轮安装验收)

实际 App 已验证运行中关闭页签和重启后的原操作不重放。真实模型的临时脚本四项工具调用均完成，实际执行保留父 Shell 工作目录、变量和函数，只有一次写盘效果。最终聊天结束事件未观测到。首轮发现接管前阻止执行后误报租约错误，已在 R02 修复并复验。[第二阶段实机记录](../../.artifacts/tests/agent-terminal-input/windows-wfa0239/REPORT.md#第二阶段实机验证)

实际 WebView2 首轮验证正反向单行选择复制、搜索跳转、终端焦点和历史视口保持。组合换行复制与完整重排在 R02 复验。[首轮桌面证据](../../.artifacts/tests/agent-terminal-input/windows-wfa0239/REPORT.md#实际-webview2-显示)

### 2026-11-12 Windows 内测 R02

独立批次 `wt5c1` 以 `e63021ea` 加两项修复重建原生资源和 NSIS，并在实际交互会话安装至 D 盘批次目录。三种 Shell 和真实模型单次执行通过。接管返回 `cancelled/notStarted`，随后 Enter 未执行清除的草稿，用户可以重新输入。运行中关闭与崩溃重启复验通过，7 项无模型 ConPTY 验证使用重建模块。[安装包](<../../.artifacts/releases/windows-wt5c1/ShellSpan Windows Internal wt5c1_2.5.0_x64-setup.exe>) · [SHA256SUMS](../../.artifacts/releases/windows-wt5c1/SHA256SUMS)

实际 WebView2 完成宽窄切换、历史视口、正反向选择、组合换行复制、搜索和焦点验证。错误摘要、未知配置、未封存验证目录均拒绝原生能力，仍可在普通终端使用 Neovim。两批标准卸载和清理完成，保留未结算恢复账本及交付证据。完整统一清单的发布余项单独留档。[修复清单与 35 项验收记录](../../.artifacts/tests/agent-terminal-input/windows-wt5c1/REPORT.md)

## 实施顺序

1. 按 [macOS 研发计划](#macos-arm64-研发计划)交付本地内测候选，再补完本地执行功能和实机验收。
2. **推进 Linux SSH 和 Windows 实机。** 两条路径可在各自候选和环境就绪后开展。

   | 平台 | 先做 | 完成条件 |
   | --- | --- | --- |
   | Linux SSH（C05、D01–D06、E01、E02、E06） | 在受控 Linux arm64／glibc 2.36 主机使用实际 App，分别核对 Bash 5.3 和 Zsh 5.9 的 Shell 摘要、SFTP 上传与读回、relay 和原生终端绑定。先跑正常输入、执行和后台作业，再注入断线、EOF 和重连。 | Bash SSH 7 项齐备，ZLE 独立验证启动与信号。窄宽窗口、终端生命周期、尾部输出、未知结果围栏及重连后的新代次均有实际证据；独立复核 SSH/SFTP 和历史回环转发超时。 |
   | Windows | 按 [Windows x64 研发计划](#windows-x64-研发计划)先交付内测安装包并验证 Shell 选择。 | PowerShell 7 的执行与桌面验收齐备，PowerShell 5.1 的普通终端和原生执行拒绝有实机证据。 |
3. **核对随包运行和清理（A03、A04、A06、E07）。** 验证实际包加载本批资源，核对错误摘要、未知构建、错误平台、缺符号及实验资源隔离。确认各批次对临时脚本、凭据引用、进程、目录和端口的归属，按现有流程清理并独立核对。仍运行或结果不明的操作保留引用与恢复门禁。按平台汇总每个要求的通过、失败、待验、跳过和不适用，保留失败与复验的关联。
4. **核验全平台结果和正式发布门禁（A05、E08）。** 各平台补齐适用项并核验最终制品与归档后，给出全平台结论。正式发布按 [发布流程](../releasing.md) 执行。2026-11-11 复查时，[远端 `f4a48336` 的 Quality Gate](https://github.com/hi-fullmoon/ShellSpan/actions/runs/43027284960) 因 GitHub 付款或支出上限问题未启动必需任务，Latest 接口返回 404。恢复后验证最终 `origin/main` 的完整门禁和真实 Latest 基线，再准备版本。

前台 App、实际模型和人工操作按安排的时段执行。每批保留源码与制品身份、实际退出码、原始证据、覆盖范围和待补项。归档失联时先核对原归档，复验使用新批次和新身份。
