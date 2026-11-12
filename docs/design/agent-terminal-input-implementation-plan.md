# 原生终端后续实施计划

2026-11-12 更新。本轮 macOS arm64 本地 PTY 双 Shell 验收已收口，交付 R04 内测包。E08 完整远端 Quality Gate 延期至正式发布前补验。五个发布绑定继续按 [统一验收标准](agent-terminal-input-acceptance-checklist.md) 管理。Linux SSH 和 Windows 验收按原约定暂停，等待明确恢复。Bash 4.1／4.4 保留按需兼容验证。编辑器的生产配置见 [NIP 契约](../../protocol/agent/runtime/native-input.md) 和 [准入清单](../../protocol/agent/runtime/native-editor-admission.json)。

## 当前进度

| 范围 | 已有结果 | 仍需验证 |
| --- | --- | --- |
| macOS arm64 本地 PTY | R04 已通过实际 App 崩溃恢复、系统交互、安装启动、实际加载资源及离线重建核对。Zsh 5.9 / ZLE 5.9 与 Bash 5.3 / Readline 8.3.6 的本轮适用条款合计 63/63 通过。[本地验收报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md) | E08 留到正式发布前补验。严格 Unicode 模型子项继续延期。第 2 期 144 项和第 3 期 225 项保留各自原批次范围。 |
| Linux arm64，glibc 2.36，受控 SSH | `2aaaaf75` 核对了 Bash 5.3 的 Linux 资源、受控 SSH 夹具的 Shell 绑定、真实 Linux PTY 和浏览器显示。 | 暂停。恢复后按 [Linux SSH/SFTP 实施方案](#linux-sshsftp-实施方案) 补齐双 Shell 的实际 App、传输、显示和恢复证据。 |
| Windows x64，ConPTY | `wt5c1` 已在 D 盘实际安装、启动并通过三种 Shell、接管清稿、运行中关闭、进程重启、WebView2 实际交互、异常资源和标准卸载。真实临时脚本及 PowerShell 无模型验证均已留证。[内测包与逐项验收](../../.artifacts/tests/agent-terminal-input/windows-wt5c1/REPORT.md) | 更广的统一发布子案按逐项状态补验，包括多代次重绑、选区锚点及完整 Quality Gate。 |
| 当前源码与交付 | `2aaaaf75` 的 Bash 5.3 收敛和 `e63021ea` 的 PowerShell 7 收敛均已推送至 `origin/main`。两平台 Bash 5.3 资源和包内清单已核对，macOS 随包源码离线重建、前端全量测试及生产构建已通过。 | 以各平台最新候选提交继续实机验收。正式发布仍待完成。 |

## macOS arm64 本地验收

R04 已收口。Zsh 5.9／ZLE 5.9 与 Bash 5.3／Readline 8.3.6 本轮适用条款 63/63 通过，涵盖实际 App 崩溃重启、重绑与旧 PTY 输出、系统输入和显示、真实模型链路，以及安装后资源加载。严格 Unicode 模型子项继续延期，E08 留到正式发布前。旧 Bash 4.1／4.4 仍可普通编辑和运行 TUI，原生执行兼容性按需验证。

| 批次 | 制品与记录 |
| --- | --- |
| R01 | [DMG](../../.artifacts/releases/macos-native-input/20261111-r01/ShellSpan_2.5.0_arm64_internal_r01.dmg) · [双 Shell 基线报告](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r01/REPORT.md) |
| R02 | [DMG](../../.artifacts/releases/macos-native-input/20261111-r02/ShellSpan_2.5.0_arm64_internal_r02.dmg) · [SHA256SUMS](../../.artifacts/releases/macos-native-input/20261111-r02/SHA256SUMS) · [双 Shell 验收与修复](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r02/REPORT.md) |
| R03 | [DMG](../../.artifacts/releases/macos-native-input/20261112-r03/ShellSpan_2.5.0_arm64_internal_r03.dmg) · [SHA256SUMS](../../.artifacts/releases/macos-native-input/20261112-r03/SHA256SUMS) · [离线重建差异和实机复验](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md) |
| R04（当前内测交付） | [DMG](../../.artifacts/releases/macos-native-input/20261112-r04/ShellSpan_2.5.0_arm64_internal_r04.dmg) · [SHA256SUMS](../../.artifacts/releases/macos-native-input/20261112-r04/SHA256SUMS) · [逐项结论、原失败及复验](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md) · [源码与制品核对](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/r04-current-source-package-audit.json) |

需要复验时，用 `pnpm native:prepare` 准备资源，用 `node scripts/native-input-p2/matrix.mjs --local-only --list-cases` 核对 Bash 本地六项。真实 PTY 回归使用 Rust `native_production_` 测试组，实际 App 用例使用[现有实机入口](../../scripts/verify-ai-session-stream.mjs)。完整要求与取证规则见[统一验收标准](agent-terminal-input-acceptance-checklist.md)。

## Linux SSH/SFTP 实施方案

本节在用户明确恢复 Linux SSH/SFTP 验收后执行。目标是 macOS arm64 客户端的实际 ShellSpan App 连接受控 Linux aarch64／glibc 2.36 主机。分别验收 Bash 5.3／Readline 8.3.6 和私有 Zsh 5.9／ZLE 5.9。`2aaaaf75` 的资源、真实 PTY 和浏览器证据保留原范围。恢复后选定最新候选并核对源码、依赖和资源差异，再确定可引用的旧证据与需要重跑的条款。

| 顺序 | 工作 | 完成条件 |
| --- | --- | --- |
| 1. 冻结候选与夹具（A01–A06） | 冻结客户端源码和制品，核对构建工具链、Linux 架构与 glibc、镜像摘要、SSH 主机指纹和回环端口。用仓库构建入口重建两个 Shell 的 Linux 资源。为本批使用独立容器、账号、HOME、远端工作目录和 App 数据目录。 | 随包资源、远端读回、实际加载的 Shell、模块、relay 及适用的 ZLE Main/Core 摘要一致。列出必测用例，记录选中、执行、通过、失败和跳过数量。错误摘要、缺符号、实验资源和不支持的目标保留普通终端并拒绝 Agent 原生执行。 |
| 2. 验证 SSH/SFTP 与单次执行（B01–B08、E01、E02、E04） | 先跑隔离 SSH 回归，再用实际 App 在原用户终端验证 SFTP 上传与读回、独立 relay、终端尺寸及信号。Bash 跑五种历史配置、后台作业和生命周期共 7 项。ZLE 独立核对启动、同线程编辑、清稿、父解析器、hook/widget、信号和 EOF。覆盖父 Shell 工作目录及环境、8192／8193 字节边界、取消后用户 Enter、后台输出和停止。 | 上传及读回的路径、字节数和摘要相符，远端写入限于本批授权目录。批准的命令只接受一次并产生一次预期效果，拒绝或清稿后无文件效果。使用现有连接和终端标签，普通终端与无 SFTP 时的降级单列。 |
| 3. 验证断线、恢复与旧输出（C01–C07、D05–D06） | 两种 Shell 分别在接受键发出前后验证控制 EOF、SSH 断线和超时。按清单补停止、接管及 App 崩溃重启，使用原隔离数据目录重启并显式验证重连。保留旧连接尾包，观察恢复普通模式与新连接输出的顺序。 | 对照原请求、连接代次、提交意图、实际接受次数、文件效果和持久记录。接受键前零效果，发出后最多一次。结果不明保留恢复门禁和原操作引用，禁止重放。迟到 Started 只补事实，只有匹配的 Settled 才可结算；旧代次不能影响新终端。独立账本探针与实际 App 分别记账。 |
| 4. 补齐显示、人工交互与模型链（D01–D06、E05、E06） | 从本批真实 SSH PTY 采集窄宽切换、后台交错和重绑数据，覆盖 Chromium/WebKit 的 DOM/WebGL；实际 App 单独检查选择、复制、搜索、历史视口、被动焦点与接管。最后按授权时段运行双 Shell 真实模型的批准、后台作业和远端脚本文件链。 | 浏览器回放和原生 App 分别留证。模型案核对真实文件工具、批准后写入、SFTP 读回、返回的绝对路径和原父 Shell 执行。Direct 对照单列。严格 Unicode 模型子项继续延期。 |
| 5. 归档与清理（A05、E07、E08） | 独立核对 SSH/SFTP 回归及历史 scoped loopback HTTP/SSH 转发的半关闭、取消和超时。按 Shell 汇总条款，记录候选、命令及退出码、原始流、界面证据、远端效果和清理回执。 | 只清理确认归本批且已终止的进程、容器、目录和 CredentialRef。运行中或结果不明的操作保留引用。未覆盖或失败项注明恢复条件。正式发布前另核验最终 `main` 的完整远端 E08。 |

恢复后先用 `node scripts/native-input-p2/matrix.mjs --list-cases` 核对用例清单，执行时显式选择七个 `5.3/ssh/*` 对应项。隔离传输回归使用 `pnpm test:terminal-visible:ssh`，运行前核对其 Compose 资源归属。资源构建沿用 [Linux Bash 构建器](../../scripts/native-input-p2/build.py) 和 [Linux ZLE 构建入口](../../scripts/native-input-p3/linux-build.sh)。实际 App 沿用 [P2 SSH 夹具](../../scripts/native-input-p2/ssh.mjs)、[Bash App 入口](../../scripts/native-input-p2/app.mjs) 与 [ZLE App 入口](../../scripts/native-input-p3/app.mjs)。ZLE App 入口当前仅接收 `jobs` 的 SSH 夹具，若故障或恢复用例缺少适用入口，先补隔离验收入口并验证，产品的准入与恢复规则照常执行。

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

1. **macOS 本地验收已完成，交付 R04 内测包。** 本轮范围及证据见 [macOS 本地验收](#macos-arm64-本地验收)与 [本地验收报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)。
2. **Linux SSH 和 Windows 实机暂停。** 用户明确恢复后，按各自候选与环境继续。

   | 平台 | 先做 | 完成条件 |
   | --- | --- | --- |
   | Linux SSH/SFTP | 按 [Linux SSH/SFTP 实施方案](#linux-sshsftp-实施方案) 冻结候选和夹具，先跑隔离回归，再运行双 Shell 的实际 App。 | 双 Shell 分别取得 SFTP、relay、原生执行、断线重连及显示证据，并核对转发超时和本批清理。 |
   | Windows | 按 [Windows x64 研发计划](#windows-x64-研发计划)先交付内测安装包并验证 Shell 选择。 | PowerShell 7 的执行与桌面验收齐备，PowerShell 5.1 的普通终端和原生执行拒绝有实机证据。 |
3. **核对随包运行和清理（A03、A04、A06、E07）。** 验证实际包加载本批资源，核对错误摘要、未知构建、错误平台、缺符号及实验资源隔离。确认各批次对临时脚本、凭据引用、进程、目录和端口的归属，按现有流程清理并独立核对。仍运行或结果不明的操作保留引用与恢复门禁。按平台汇总每个要求的通过、失败、待验、跳过和不适用，保留失败与复验的关联。
4. **核验全平台结果和正式发布门禁（A05、E08）。** 各平台补齐适用项并核验最终制品与归档后，给出全平台结论。E08 在正式发布前按 [发布流程](../releasing.md) 补验。2026-11-12 复查时，[远端 `6dddb6f2` 的 Quality Gate](https://github.com/hi-fullmoon/ShellSpan/actions/runs/43133296775) 四个必需任务均失败，未记录执行步骤，Latest 接口仍返回 404。恢复后验证最终 `origin/main` 的完整门禁和真实 Latest 基线，再准备版本。

前台 App、实际模型和人工操作按安排的时段执行。每批保留源码与制品身份、实际退出码、原始证据、覆盖范围和待补项。归档失联时先核对原归档，复验使用新批次和新身份。
