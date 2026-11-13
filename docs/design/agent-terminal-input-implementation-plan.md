# 原生终端后续实施计划

2026-11-13 更新。macOS arm64 本地 PTY 已交付 R04 内测包。新候选的双 Shell 受控 SSH、原生显示与本机质量回归已有实际结果。Windows 验收继续暂停，完整远端 E08 延期至正式发布前。五个发布绑定继续按 [统一验收标准](agent-terminal-input-acceptance-checklist.md) 管理。Bash 4.1／4.4 保留按需兼容验证。编辑器的生产配置见 [NIP 契约](../../protocol/agent/runtime/native-input.md) 和 [准入清单](../../protocol/agent/runtime/native-editor-admission.json)。

## 当前进度

| 范围 | 已有结果 | 仍需验证 |
| --- | --- | --- |
| macOS arm64 本地 PTY | R04 历史结论为 Zsh 5.9 / ZLE 5.9 与 Bash 5.3 / Readline 8.3.6 适用条款 63/63。原件缺失状态及当前候选结果见 [本机续验报告](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/REPORT.md)。 | E08 留到正式发布前补验。严格 Unicode 模型子项继续延期。第 2 期 144 项和第 3 期 225 项保留各自原批次范围。 |
| Linux arm64，glibc 2.36，受控 SSH | 当前封存重跑隔离传输 17/17，签名 App 已验双 Shell 历史、字节、父 Shell、真实文件、作业、降级及故障恢复。两个真实 WKWebView、八个真实浏览器组合通过。原 ZLE 五案继续按原切点引用。 [本批实机报告](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/REPORT.md) | 双 Shell 剩余控制切点、资源负例、实际人工及模型子案按 [续验清单](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/CHECKLIST.md) 继续。 |
| Windows x64，ConPTY | `wt5c1` 已在 D 盘实际安装、启动并通过三种 Shell、接管清稿、运行中关闭、进程重启、WebView2 实际交互、异常资源和标准卸载。真实临时脚本及 PowerShell 无模型验证均已留证。[内测包与逐项验收](../../.artifacts/tests/agent-terminal-input/windows-wt5c1/REPORT.md) | 更广的统一发布子案按逐项状态补验，包括多代次重绑、选区锚点及完整 Quality Gate。 |
| 当前源码与交付 | `2aaaaf75` 的 Bash 5.3 收敛和 `e63021ea` 的 PowerShell 7 收敛均已推送至 `origin/main`。两平台 Bash 5.3 资源和包内清单已核对，macOS 随包源码离线重建、前端全量测试及生产构建已通过。 | 以各平台最新候选提交继续实机验收。正式发布仍待完成。 |

## macOS arm64 本地验收

R04 已收口。Zsh 5.9／ZLE 5.9 与 Bash 5.3／Readline 8.3.6 本轮适用条款 63/63 通过，涵盖实际 App 崩溃重启、重绑与旧 PTY 输出、系统输入和显示、真实模型链路，以及安装后资源加载。严格 Unicode 模型子项继续延期，E08 留到正式发布前。旧 Bash 4.1／4.4 仍可普通编辑和运行 TUI，原生执行兼容性按需验证。

| 批次 | 制品与记录 |
| --- | --- |
| R01 | [DMG](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r01/ShellSpan_2.5.0_arm64_internal_r01.dmg) · [双 Shell 基线报告](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r01/REPORT.md) |
| R02 | [DMG](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r02/ShellSpan_2.5.0_arm64_internal_r02.dmg) · [SHA256SUMS](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r02/SHA256SUMS) · [双 Shell 验收与修复](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r02/REPORT.md) |
| R03 | [DMG](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r03/ShellSpan_2.5.0_arm64_internal_r03.dmg) · [SHA256SUMS](../../.artifacts/tests/agent-terminal-input/20261111-macos-internal-r03/SHA256SUMS) · [离线重建差异和实机复验](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md) |
| R04（历史内测交付） | 原报告、DMG 及逐案原件缺失。 [现存差异审计](../../.artifacts/tests/agent-terminal-input/20261113-ram-signing-preflight/sealed-inputs-audit-20.json) · [缺失路径登记](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/source-path-loss-and-restage.json) |

需要复验时，用 `pnpm native:prepare --acceptance` 准备资源，用 `node scripts/native-input-p2/matrix.mjs --local-only --list-cases` 核对 Bash 本地六项。真实 PTY 回归使用 Rust `native_production_` 测试组，实际 App 用例使用[现有实机入口](../../scripts/verify-ai-session-stream.mjs)。完整要求与取证规则见[统一验收标准](agent-terminal-input-acceptance-checklist.md)。

候选 42 的本地签名 App 实测 Bash 与 ZLE 四代重绑、旧传输迟到输出隔离和待解析输出时销毁控制器，共 6/6。逐案保留窗口原图、源码与签名摘要、实际 PTY 及正常退出记录。 [本地重绑与销毁审计](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/candidate42-local-lifecycle-audit.json)

B08 的本地签名 App 补验通过目录占用、符号链接拒绝 4/4，以及同数据目录重启 2/2。重启后真实文件工具读回原路径与字节，恢复原所有权，重新审批并在新 PTY 各接受一次，账本均匹配结算。 [文件链逐案审计](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/local-scratch-audit.json)

B02 实际 WKWebView 减弱动态效果 2/2。C06 签名 App 控制通道启动 10/10、真实 Shell 私有通道合包和顺序回归 12/12。D03 本地签名 App 系统拖选和复制 12/12，另通过系统剪贴板超时恢复。E05 的 ZLE 真实 SSH 窗口前后台焦点切换已通过，Bash 仍需同轮 App 与独立系统观察器回执，物理接管仍待现场。 [控制通道与减弱动态审计](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/local-wire-motion-audit.json) · [合包审计](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/candidate51-wire-coalesced/audit.json) · [系统复制审计](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/system-selection-audit.json)

## Linux SSH/SFTP 实施方案

本节在用户明确恢复 Linux SSH/SFTP 验收后执行。目标是 macOS arm64 客户端的实际 ShellSpan App 连接受控 Linux aarch64／glibc 2.36 主机。分别验收 Bash 5.3／Readline 8.3.6 和私有 Zsh 5.9／ZLE 5.9。`2aaaaf75` 的资源、真实 PTY 和浏览器证据保留原范围。恢复后选定最新候选并核对源码、依赖和资源差异，再确定可引用的旧证据与需要重跑的条款。

2026-11-13 本机续验从 `2e76d274` 加工作区开始。最终重建资源的 Bash `5.3/ssh/lifecycle`、双 Shell 前后切点的独立 relay EOF、真实 App 崩溃及同数据根重启均通过。十种历史配置、普通输入与 TUI、无 SFTP、未知 Main、后台作业及真实文件链分别留有签名 App 原始回执。首次失败与新身份复验分别留存。 [本批报告](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/REPORT.md) · [余项清单](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/CHECKLIST.md)

在 `2dafc497` 复核候选 42 时，两种 Shell 的回环 SSH 签名 App 用例各 48 项，最新结果共 96/96。最后一批接受前后断线及超时、接受前取消和历史配置复验 20/20。两种正式打包资源均通过独立签名 App 冒烟。现场减弱动态、系统剪贴板、前后台焦点和人工接管的操作与取证条件另见交接。 [当前续验报告](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/REPORT.md) · [逐案覆盖审计](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/ssh-case-coverage.json) · [人工交接](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/MANUAL-HANDOFF.md)

ZLE 的初始 `ZDOTDIR` 已修正并在两种实际 OpenSSH 环境、五种签名 App 历史配置中复验。候选 17 使用归属明确的临时 RAM 卷完成签名与链接，复验新采显示流、本地真实 PTY 和协议、前端与全功能 Rust。R04 本地 63 项继续保留原候选范围。当前候选的本地定向证据、剩余人工、模型和发布条件均单列。 [本机质量与差异审计](../../.artifacts/tests/agent-terminal-input/20261113-ram-signing-preflight/REPORT.md)

候选 19 已通过并归档四十九项本地签名 App 续验，包含双 Shell 接受键前、后的实际 App 崩溃和同数据目录重启、8192 字节原生接受与 8193 字节拒绝，以及多个提交切点的停止、取消和接管。两项显示回放失败按实际解析回调复验，后续控制切点继续串行取证。SSH 余项等待本机 Docker API 恢复后使用新夹具。 [候选 19 本地复验](../../.artifacts/tests/agent-terminal-input/20261113-candidate19-local-continuation/REPORT.md)

候选 20 的 ZLE 完整输入后接管和 Bash 持久意图后停止均已在签名 App 复验并归档，实际显示回放、同身份清稿及普通 Enter 均通过。 [ZLE 回执](../../.artifacts/tests/agent-terminal-input/20261113-ram-signing-preflight/candidate20-ram-c02-replay-retest/zle-input-complete-takeover-runtime-audit.json) · [Bash 回执](../../.artifacts/tests/agent-terminal-input/20261113-ram-signing-preflight/candidate20-ram-c02-bash-intent-short-tmp/audited-results.json)

候选 20 的 Bash 接受键前取消已在签名 App 通过并归档。ZLE 同项首次在 Cargo 构建阶段因磁盘空间不足退出，18 个原始文件已归档至原路径并核对内容、权限及扩展属性，三个 Cargo 依赖清单已恢复。TypeScript、CI 静态检查、AI 样式检查和 `git diff --check` 退出 0。前端全量测试需复验。 [续验报告](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/REPORT.md)

磁盘和 Docker 恢复后，前端全量与生产构建通过。候选 21 在匹配资源的封存目录通过 Rust 库 1,402 项及隔离传输 17/17，候选 22 主程序锁定检查、全功能 Clippy、集成 5/5 通过。候选 20 和 22 新增双 Shell 的 SSH 显式取消、复杂源码、错误资源摘要拒绝各 2/2，旧夹具已核对停止且端口已释放。 [本机续验报告](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/REPORT.md) · [逐案台账](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/attempts.json)

候选 25 的无模型本地文件链 2/2、真实 PTY 历史复验 7/7。候选 27 双 Shell 通过回环 SSH 接受前接管，实际 WKWebView 2/2，真实 PTY 的浏览器回放 8/8。候选 28 双 Shell 回环 SSH 运行中停止、取消及接管共 6/6，均观察一次实际接受、同身份开始和结算、退出 130 与单次文件效果。其余 SSH 控制切点、争用、委派和关闭按统一清单继续执行。 [SSH 运行中审计](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/candidate28-controls-audit.json) · [统一余项](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/CHECKLIST.md)

候选 30 已完成双 Shell 五个 SSH 控制切点 30/30，候选 32 争用、关闭运行终端、委派 6/6，候选 33 本地签名历史和作业 12/12。当前资源目录布局下，候选 37 四套资源重建和打包、双 Shell SSH 重点复验 14/14、真实 WKWebView 与浏览器回放均已通过。候选 39 修正隔离 SSH 测试驱动等待真实提示符，复验 17/17。R04 原报告、制品及部分旧封存和账本已不存在，历史结论按现存审计引用。现场系统操作及其他余项按统一清单执行。 [本机续验报告](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/REPORT.md)

| 顺序 | 工作 | 完成条件 |
| --- | --- | --- |
| 1. 冻结候选与夹具（A01–A06） | 冻结客户端源码和制品，核对构建工具链、Linux 架构与 glibc、镜像摘要、SSH 主机指纹和回环端口。用仓库构建入口重建两个 Shell 的 Linux 资源。为本批使用独立容器、账号、HOME、远端工作目录和 App 数据目录。 | 随包资源、远端读回、实际加载的 Shell、模块、relay 及适用的 ZLE Main/Core 摘要一致。列出必测用例，记录选中、执行、通过、失败和跳过数量。错误摘要、缺符号、实验资源和不支持的目标保留普通终端并拒绝 Agent 原生执行。 |
| 2. 验证 SSH/SFTP 与单次执行（B01–B08、E01、E02、E04） | 先跑隔离 SSH 回归，再用实际 App 在原用户终端验证 SFTP 上传与读回、独立 relay、终端尺寸及信号。Bash 跑五种历史配置、后台作业和生命周期共 7 项。ZLE 独立核对启动、同线程编辑、清稿、父解析器、hook/widget、信号和 EOF。覆盖父 Shell 工作目录及环境、8192／8193 字节边界、取消后用户 Enter、后台输出和停止。 | 上传及读回的路径、字节数和摘要相符，远端写入限于本批授权目录。批准的命令只接受一次并产生一次预期效果，拒绝或清稿后无文件效果。使用现有连接和终端标签，普通终端与无 SFTP 时的降级单列。 |
| 3. 验证断线、恢复与旧输出（C01–C07、D05–D06） | 两种 Shell 分别在接受键发出前后验证控制 EOF、SSH 断线和超时。按清单补停止、接管及 App 崩溃重启，使用原隔离数据目录重启并显式验证重连。保留旧连接尾包，观察恢复普通模式与新连接输出的顺序。 | 对照原请求、连接代次、提交意图、实际接受次数、文件效果和持久记录。接受键前零效果，发出后最多一次。结果不明保留恢复门禁和原操作引用，禁止重放。迟到 Started 只补事实，只有匹配的 Settled 才可结算；旧代次不能影响新终端。独立账本探针与实际 App 分别记账。 |
| 4. 补齐显示、人工交互与模型链（D01–D06、E05、E06） | 从本批真实 SSH PTY 采集窄宽切换、后台交错和重绑数据，覆盖 Chromium/WebKit 的 DOM/WebGL；实际 App 单独检查选择、复制、搜索、历史视口、被动焦点与接管。最后按授权时段运行双 Shell 真实模型的批准、后台作业和远端脚本文件链。 | 浏览器回放和原生 App 分别留证。模型案核对真实文件工具、批准后写入、SFTP 读回、返回的绝对路径和原父 Shell 执行。Direct 对照单列。严格 Unicode 模型子项继续延期。 |
| 5. 归档与清理（A05、E07、E08） | 独立核对 SSH/SFTP 回归及历史 scoped loopback HTTP/SSH 转发的半关闭、取消和超时。按 Shell 汇总条款，记录候选、命令及退出码、原始流、界面证据、远端效果和清理回执。 | 只清理确认归本批且已终止的进程、容器、目录和 CredentialRef。运行中或结果不明的操作保留引用。未覆盖或失败项注明恢复条件。正式发布前另核验最终 `main` 的完整远端 E08。 |

恢复后先用 `node scripts/native-input-p2/matrix.mjs --list-cases` 核对用例清单，执行时显式选择七个 `5.3/ssh/*` 对应项。隔离传输回归使用 `pnpm test:terminal-visible:ssh`，运行前核对其 Compose 资源归属。资源构建沿用 [Linux Bash 构建器](../../scripts/native-input-p2/build.py) 和 [Linux ZLE 构建入口](../../scripts/native-input-p3/linux-build.sh)。实际 App 沿用 [P2 SSH 夹具](../../scripts/native-input-p2/ssh.mjs)、[Bash App 入口](../../scripts/native-input-p2/app.mjs) 与 [ZLE jobs 入口](../../scripts/native-input-p3/app.mjs)。ZLE 的四个故障切点与旧 PTY 尾包独立执行，使用 `node scripts/native-input-p3/ssh-recovery.mjs --list-cases` 发现。实机状态、命令、证据和清理见 [ZLE SSH 故障恢复交接清单](agent-terminal-input-zle-ssh-recovery.md)。

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

独立批次 `wt5c1` 以 `e63021ea` 加两项修复重建原生资源和 NSIS，并在实际交互会话安装至 D 盘批次目录。三种 Shell 和真实模型单次执行通过。接管返回 `cancelled/notStarted`，随后 Enter 未执行清除的草稿，用户可以重新输入。运行中关闭与崩溃重启复验通过，7 项无模型 ConPTY 验证使用重建模块。[安装包](<../../.artifacts/tests/agent-terminal-input/windows-wt5c1/ShellSpan Windows Internal wt5c1_2.5.0_x64-setup.exe>) · [SHA256SUMS](../../.artifacts/tests/agent-terminal-input/windows-wt5c1/SHA256SUMS)

实际 WebView2 完成宽窄切换、历史视口、正反向选择、组合换行复制、搜索和焦点验证。错误摘要、未知配置、未封存验证目录均拒绝原生能力，仍可在普通终端使用 Neovim。两批标准卸载和清理完成，保留未结算恢复账本及交付证据。完整统一清单的发布余项单独留档。[修复清单与 35 项验收记录](../../.artifacts/tests/agent-terminal-input/windows-wt5c1/REPORT.md)

## 实施顺序

1. **R04 内测包已交付。** 历史范围见 [macOS 本地验收](#macos-arm64-本地验收)，当前候选的复验结果见 [本机续验报告](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/REPORT.md)。
2. **Linux SSH/SFTP 本批传输和 ZLE 无模型故障已通过，Windows 实机继续暂停。** 其余场景按各自候选、环境与授权继续。

   | 平台 | 先做 | 完成条件 |
   | --- | --- | --- |
   | Linux SSH/SFTP | 按 [Linux SSH/SFTP 实施方案](#linux-sshsftp-实施方案) 冻结候选和夹具，先跑隔离回归，再运行双 Shell 的实际 App。 | 双 Shell 分别取得 SFTP、relay、原生执行、断线重连及显示证据，并核对转发超时和本批清理。 |
   | Windows | 按 [Windows x64 研发计划](#windows-x64-研发计划)先交付内测安装包并验证 Shell 选择。 | PowerShell 7 的执行与桌面验收齐备，PowerShell 5.1 的普通终端和原生执行拒绝有实机证据。 |
3. **核对随包运行和清理（A03、A04、A06、E07）。** 验证实际包加载本批资源，核对错误摘要、未知构建、错误平台、缺符号及实验资源隔离。确认各批次对临时脚本、凭据引用、进程、目录和端口的归属，按现有流程清理并独立核对。仍运行或结果不明的操作保留引用与恢复门禁。按平台汇总每个要求的通过、失败、待验、跳过和不适用，保留失败与复验的关联。
4. **核验全平台结果和正式发布门禁（A05、E08）。** 各平台补齐适用项并核验最终制品与归档后，给出全平台结论。E08 在正式发布前按 [发布流程](../releasing.md) 补验。2026-11-12 复查时，[远端 `6dddb6f2` 的 Quality Gate](https://github.com/hi-fullmoon/ShellSpan/actions/runs/43133296775) 四个必需任务均失败，未记录执行步骤，Latest 接口仍返回 404。恢复后验证最终 `origin/main` 的完整门禁和真实 Latest 基线，再准备版本。

前台 App、实际模型和人工操作按安排的时段执行。每批保留源码与制品身份、实际退出码、原始证据、覆盖范围和待补项。归档失联时先核对原归档，复验使用新批次和新身份。
