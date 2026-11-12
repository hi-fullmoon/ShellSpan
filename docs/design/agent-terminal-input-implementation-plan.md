# 原生终端后续实施计划

2026-11-12 更新。本轮 macOS arm64 本地 PTY 双 Shell 验收已收口，交付 R04 内测包。E08 完整远端 Quality Gate 延期至正式发布前补验。五个发布绑定继续按 [统一验收标准](agent-terminal-input-acceptance-checklist.md) 管理。Linux SSH 和 Windows 验收按原约定暂停，等待明确恢复。Bash 4.1／4.4 保留按需兼容验证。编辑器的生产配置见 [NIP 契约](../../protocol/agent/runtime/native-input.md) 和 [准入清单](../../protocol/agent/runtime/native-editor-admission.json)。

## 当前进度

| 范围 | 已有结果 | 仍需验证 |
| --- | --- | --- |
| macOS arm64 本地 PTY | R04 已通过实际 App 崩溃恢复、系统交互、安装启动、实际加载资源及离线重建核对。Zsh 5.9 / ZLE 5.9 与 Bash 5.3 / Readline 8.3.6 的本轮适用条款合计 63/63 通过。[本地验收报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md) | E08 留到正式发布前补验。严格 Unicode 模型子项继续延期。第 2 期 144 项和第 3 期 225 项保留各自原批次范围。 |
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

2026-11-12 完成该内测包的父 Shell、历史、作业、临时文件链及资源负例复验。Bash 5.3 六项本地实机模型用例均已取得通过证据，ZLE 七种历史设置和双进程历史读取通过。两种 Shell 的真实后台作业、模型临时文件链及重启读回均通过。实验、错误摘要、平台不匹配和缺符号的拒绝路径已核对，历史 SSH 转发超时项通过独立复验。

### 2026-11-12 macOS 补验与 R03

R02 冻结源码构建的签名验收 App 已在 Zsh 和 Bash 各完成两种切点。意图落盘后、接受键写入前均为零效果。接受键写入后、确认结算前均只有一次文件效果。重启使用原数据目录，原身份、账本记录与恢复门禁保持，重复请求、原审批及生产继续恢复均受阻。独立账本探针和实机结果分别留证。

R02 的 ZLE 模块将 Cargo registry 或 vendor 的绝对路径写入二进制，Mach-O 调试映射还记录了静态库绝对路径。macOS 构建现统一 Rust 源路径并移除链接器调试映射。R03 已实际安装、启动并核对实际 ZLE Main、Core 和模块，均与从安装包离线重建的文件逐字节一致。两种 Shell 的签名验收 App 已完成重绑、半 OSC/UTF-8 和旧 PTY 迟到输出隔离。安装 Bash 的实际加载、销毁后新会话和本人交互仍按逐项台账补验。[R03 DMG](../../.artifacts/releases/macos-native-input/20261112-r03/ShellSpan_2.5.0_arm64_internal_r03.dmg) · [SHA256SUMS](../../.artifacts/releases/macos-native-input/20261112-r03/SHA256SUMS) · [逐项验收与修复清单](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)

R03 离线验证还确认了 Bash 适配模块的同类路径差异。修复后 R04 的 Bash、适配模块及 relay 与离线重建逐字节一致。修正本地终端测试冗余类型转换，严格 Clippy 通过。R04 已完成 DMG 校验、独立安装、签名和包内资源核对。安装 App 串行启动两种 Shell，实际加载字节与包内一致，尾包均先于关闭提示，随后清理私有运行目录并正常退出。本人操作等用户另行安排。[R04 DMG](../../.artifacts/releases/macos-native-input/20261112-r04/ShellSpan_2.5.0_arm64_internal_r04.dmg) · [SHA256SUMS](../../.artifacts/releases/macos-native-input/20261112-r04/SHA256SUMS)

R04 签名验收 App 已补双 Shell 排空、销毁及独立后继，重绑与旧 PTY 迟到输出复验通过。Bash 新捕获的浏览器排空及重绑四组合通过。ZLE 的四组合 EOF、实时后台输出和完整重绑通过，其中重绑逐项匹配七个实际公开状态检查点。本人交互及其余适用条款按逐项台账继续。

同一 R04 冻结源码的签名验收 App 已通过双 Shell 的四个实际崩溃切点。两种 Shell 均为写接受键前零效果、写键后一次文件效果。四次重启均保留原请求、未结算持久记录和恢复门禁，未知操作继续保留引用。

R04 双 Shell 的显示模式退出与重绑已通过。浏览器补重复 enter 与外部 Unicode provider，实机确认取消 exit 发生在关闭前。无模型签名 App 的启动报文、运行中多 Agent 争用、委派及接受前取消共 16 案通过，另有 9 个真实 PTY 报文组件案和双 Shell 的实际只读查询复验。两种真实 Shell 的 2,000 毫秒预算未因多次查询续期，超期 Commit 被拒绝。安装 App 传入外部实验目录时，双 Shell 保持普通终端并正常退出。真实 P1 试验生产者的正式捕获、后台作业资格及握手拒绝已独立核对。其余控制矩阵和本人交互继续按报告核销。

R04 双 Shell 的七个切点分别执行停止、取消及接管，42 个签名 App 子案均已取证通过。保留首轮四个失败及各自复验。双 Shell 另已通过接受超时、控制 EOF、迟到 Started 和匹配 Settled、持久意图时并发重复调用及 8192／8193 字节边界。复验捕获仅改测试入口，R04 安装包保持原冻结。

R04 原生资源在独立测试冻结中补齐双 Shell 的引号 heredoc，分别核对实际文件和 stdout 的字面字符。无模型 App 另已复验语法错误、不支持输入和确认清稿后的回车。双 Shell 的完整提交身份与绑定拒绝 22 个签名 App 子案均通过，保留首轮两次真实键盘干扰及新案复验。11:17 只读复查时，`origin/main` 同提交的最新 Quality Gate 仍失败。

R04 受影响的临时脚本链已用两种真实原生 PTY 复验，文件工具返回的绝对路径在原工作目录及父 Shell 执行。6 项运行时、12 项本地存储测试均通过。模型审批及 App 重启读回复用 R02 原批次证据，Direct 对照单列。

R04 双 Shell 的实际宽高变化、长源码、宽字符及后台交错输出已在 Chromium、WebKit 的 DOM/WebGL 复验。ZLE 实际改变尺寸七次，四个组合通过。Bash 实际高度切换的 32 案及其中另行补验后台交错的 16 个组合通过。两种 Shell 都核对从公开 API 复制到实际光标的完整源码及实际后台输出。macOS 当前减弱动态效果关闭，实机对应子项待验。

R04 普通终端测试改用真实用户输入路径进入 Vim／Neovim，同时验证 Agent 执行拒绝保持用户租约、输入序号及文件。包内 Bash 5.3、系统 Zsh 5.9 各两案，系统 Bash 3.2 对照两案，全部通过。ZLE 在四种浏览器组合的 115 个停留帧中保留原选择，收尾的跟随视口保持底部。当前 App 的系统交互仍按约定时段补验。

R04 Bash 以新增真实 PTY 捕获补齐四种浏览器组合的历史视口自动证据。8 个停留用例通过正反拖选保留原选择、首行及相对位置，4 个跟随用例从原生长输入到真实命令输出结束均跟随底部。系统鼠标、系统复制及 App 本人视口仍待取证。

本人操作交接已核对 R04 安装副本签名、随包文件、显示取证权限、验收端口和现有入口。待约定时段执行双 Shell 的 `human-*` 与 `human-phase3`，自动取证入口单列。R03 尾包回车后的被动采样仍为原 App 前台窗口，后续截图显示设置表单。R02 Bash 的 MetaLeft 原事件发生时文档可见且聚焦，保留原失败和现场取证条件。

双 Shell 已用 R04 原生资源通过减弱动态效果的真实 PTY 复验。完整源码和光标在接受键前可见，零文件效果。一次实际接受键后各产生一次效果并结算。Chromium、WebKit 的 DOM/WebGL 八个组合及重采截图通过。实际 macOS 设置启用后的 WKWebView 子项仍待取证。

`raw-zsh` 交接输入已用 R04 随包上游归档独立构建。Zsh 5.9 的内置 ZLE 可普通编辑，生产原生准入拒绝该二进制。Vim 和 Neovim 的真实 PTY 各一案通过，与此前六案在同批通过。实际 App 启动仍按约定时段执行。

R02 和 R04 的八个通过案及两份 R02 原失败账本已用不可变副本复核。十份原账本均保持原身份、未结算及禁止自动重放。八个通过案的真实 App 崩溃、接受键及文件效果逐项重新对照。R04 四份保留 App 的严格签名复核通过，R02 沿用原批次的签名及进程记录。

WKWebView 减弱动态效果已补双 Shell 的现有无模型 App 入口。验收用例核对媒体查询、同身份的私有 PrepareInput、接受前的实际显示和接受后的单次文件效果。冻结前端、TypeScript、24 项入口测试及双 Shell 原始 PTY 报文读取通过，实际 App 仍待系统设置启用及约定时段。

R02 ZLE 的真实模型后台作业、文件链和重启读回已按原始 App 和模型事件复核。R04 的适配模块摘要发生变化，待已授权时段用现有入口复验这三条本地链路。严格 Unicode 模型子项维持延期。

双 Shell 的本人历史视口入口已编译。实际 App 将核对本人滚轮、拖选、PTY 尺寸确认、缩窄及新输出后的历史锚点，以及回到底部后继续跟随。操作和独立截图检查待约定时段。

当前新冻结的本地回归通过。前端 3,790 项执行与发现逐名按次数相符，另有 95 项跳过。Rust 1,397 项通过、104 项忽略、2 项按范围排除。生产构建、终端边界、Rust include 及严格 Clippy 均通过，39 个原生资源文件与 R04 冻结一致。远端 Quality Gate 仍失败，未完成的实际 App 验收继续按报告安排。

剩余 App 入口统一使用通过本地回归的冻结副本。交接清单含双 Shell 本人操作、减弱动态效果、普通终端降级及独立系统选择补验，另列 ZLE 三条真实模型链。按已约定时段启动并逐案留证。[交接清单](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/r04-final-handoff.json)

11 月 12 日本人实机验收中，Zsh 与 Bash 的九步键入、拖选和系统复制均通过，运行中争用及任务切换均通过。Zsh 实际 App 缩窄后视口回到底部，选区文本仍在。相同原始字节及尺寸在 WebKit 的直接 resize 和 FitAddon 对照中保留锚点，已为下次实际 App 复验补记缩窄前后的视口和焦点。Bash 实机在缩窄和新输出后均保留历史锚点，并在本人回到底部后跟随新输出。原入口因收尾采集顺序退出 1，已从两路观测核对 54 个原始 PTY 帧，并修正采集器及上传校验，待签名 App 复验。六案被动焦点记录已归档，历史失焦原因仍待定位。[逐项报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md) · [批次回执](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/r04-human-handoff-receipt.json)

双 Shell 在 2 倍像素比的 167→116 列下均通过签名 App 本人复验，历史停留、选择锚点、底部跟随和真实 EOF 归档均有证据。Zsh 的 1 倍像素比 180→125 列也通过。原 Zsh 视口跳转和 Bash 采集退出 1 均保留。原 Zsh 失败停在 `HISTORY_059`，同尺寸复验停在 `HISTORY_066`。首次跳转的前台与显示器时间线继续在 E05 定位。最新冻结的全量前端用例 3,790 项通过、95 项跳过。[逐项报告与复验记录](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)

普通终端 E04 已完成双 Shell 签名 App 验收。上游 Zsh 5.9 与系统 Bash 3.2 使用真实本地 PTY 和普通用户输入入口，完成 Vim 编辑、正常退出及普通输入恢复。前台和后台 Agent 请求均由生产准备接口拒绝，输入序号和执行面保持，无文件效果。原自动用例收到外部按键的失败及后续取证调整独立归档。[逐项报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)

E07 已只读核对 14 个已结束的签名验收 App、十份应保留的原账本、DMG 挂载及 1432 端口。24 个隔离数据库的只读副本中，两类已知测试引用元数据计数均为零，原库及 WAL 摘要匹配。最新 E04 冻结的前端全量回归 3,790 项通过、95 项跳过。E05 已对齐三次普通 Zsh 中断的受信任键盘事件与实际前台时间线，R03 尾包回车的实际接收控件和 Zsh 原视口跳转原因仍待补验。[逐项报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)

B02 在 macOS 开启减弱动态效果后完成双 Shell 签名 App 实机复验。实际 WKWebView 偏好、接受前完整 340 字节输入和零文件效果均已核对，放行后各只有一次接受写键和一次文件效果。[实机审计](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/r04-submission-cd9308ca-12f2-4b8f-90e4-f19a9b99210a/reduced-motion-audit.json)

E06 的 ZLE 后台作业、原生文件链和同隔离数据重启读回已在 R04 冻结签名 App 的本地 PTY 中通过。13 次真实模型请求及 14 次工具调用均核对完成，后台作业身份和脚本内容在原路径与重启前后保持。已将 8 个确认终止并归本批所有的临时资源移入废纸篓，保留原始证据。严格 Unicode 模型子项继续延期。[逐项报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)

E05 实机已记录两次输入前的前台切换。追加自动投递案在第 61 秒、文本和回车前后均采到同一 ShellSpan 终端输入框，Zsh 未按预期退出。本人输入案保留第 61 秒采样，随后等待窗口焦点超时，在交接命令前正常退出。后续须在本人输入时段核对真实按键后的 PTY 尾包及焦点，原厂商表单异常继续保留。[实机采样和清理](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)

后续本人输入在同一 R04 窗口采到实际终端输入框焦点，版本尾包先于退出提示，App 退出 0，私有 ZLE 目录已移除。R03 原日志的模型发现早于尾包回车，随后的原截图显示已有模型发现反馈的厂商表单，结合冻结源码定位为回车前已进入厂商表单场景。原失败及缺失的精确接收控件记录继续保留。双 Shell 的 E05、A05 和 E07 均已核对。[原异常与逐项报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)

已逐文件对齐当前工作区、最新 E04 验收冻结与 R04 制品冻结。R04 之后差异集中在测试、验收入口和实施计划。以实际安装、启动及加载核对过的 ShellSpan 2.5.0 arm64 R04 DMG 交付本地内测，收口时再次核对 DMG SHA-256 和安装副本严格签名。[源码与制品核对](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/r04-current-source-package-audit.json) · [R04 DMG](../../.artifacts/releases/macos-native-input/20261112-r04/ShellSpan_2.5.0_arm64_internal_r04.dmg) · [SHA256SUMS](../../.artifacts/releases/macos-native-input/20261112-r04/SHA256SUMS)

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

1. **macOS 本地验收已完成，交付 R04 内测包。** 本轮范围及证据见 [macOS 研发计划](#macos-arm64-研发计划)与 [本地验收报告](../../.artifacts/tests/agent-terminal-input/20261112-macos-r02-followup/REPORT.md)。
2. **Linux SSH 和 Windows 实机暂停。** 用户明确恢复后，按各自候选与环境继续。

   | 平台 | 先做 | 完成条件 |
   | --- | --- | --- |
   | Linux SSH（C05、D01–D06、E01、E02、E06） | 在受控 Linux arm64／glibc 2.36 主机使用实际 App，分别核对 Bash 5.3 和 Zsh 5.9 的 Shell 摘要、SFTP 上传与读回、relay 和原生终端绑定。先跑正常输入、执行和后台作业，再注入断线、EOF 和重连。 | Bash SSH 7 项齐备，ZLE 独立验证启动与信号。窄宽窗口、终端生命周期、尾部输出、未知结果围栏及重连后的新代次均有实际证据；独立复核 SSH/SFTP 和历史回环转发超时。 |
   | Windows | 按 [Windows x64 研发计划](#windows-x64-研发计划)先交付内测安装包并验证 Shell 选择。 | PowerShell 7 的执行与桌面验收齐备，PowerShell 5.1 的普通终端和原生执行拒绝有实机证据。 |
3. **核对随包运行和清理（A03、A04、A06、E07）。** 验证实际包加载本批资源，核对错误摘要、未知构建、错误平台、缺符号及实验资源隔离。确认各批次对临时脚本、凭据引用、进程、目录和端口的归属，按现有流程清理并独立核对。仍运行或结果不明的操作保留引用与恢复门禁。按平台汇总每个要求的通过、失败、待验、跳过和不适用，保留失败与复验的关联。
4. **核验全平台结果和正式发布门禁（A05、E08）。** 各平台补齐适用项并核验最终制品与归档后，给出全平台结论。E08 在正式发布前按 [发布流程](../releasing.md) 补验。2026-11-12 复查时，[远端 `6dddb6f2` 的 Quality Gate](https://github.com/hi-fullmoon/ShellSpan/actions/runs/43133296775) 四个必需任务均失败，未记录执行步骤，Latest 接口仍返回 404。恢复后验证最终 `origin/main` 的完整门禁和真实 Latest 基线，再准备版本。

前台 App、实际模型和人工操作按安排的时段执行。每批保留源码与制品身份、实际退出码、原始证据、覆盖范围和待补项。归档失联时先核对原归档，复验使用新批次和新身份。
