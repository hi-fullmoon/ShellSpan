# Agent 终端原生输入 P0 可行性报告

日期：2026-10-31。结论：**用户已明确授权正式采纳；pnpm 正式安装包及冻结的 macOS arm64 / GNU Bash 5.3 + Readline 8.3.6 完整组合通过 P0 限定范围验收，可以继续 P1。新命令生产写入路径仍未启用，P1/P2 未完成**。

初轮未修复控制中，持续后台输出与输入中缩窗令 Readline 重绘覆盖文字，虽有完整 PTY 字节仍不满足要求。该失败及后续对照保留；本轮已修正并正式采纳通用库规则与同流显示机制，最新正式验收见文末。本会话只完成 P0，可以继续原 P1；P2–P4 尚未实施。

上段与下方初轮结果描述未修正的正式栈，不代表全部原生方案不可能。续验证的无桥接对照、官方接口依据、原位追加回显与用户明确授权的通用终端依赖实验，见文末。专项通过不能替代完整兼容性验收，未启用生产路径。

没有启用新命令生产写入路径、删除旧实现、重设计无关 UI、改变权限/审批或用户配置。正式依赖的通用复制规则已按授权更新；没有 commit、push、tag 或发布。

## 冻结基线

- 初始 HEAD：`7b9ed07b5198ab9393a54880eada124252a5b4a5`。
- 修改前工作区仅有未跟踪实施计划。源码修改前建立 `.native-input-p0/baseline/`，保存 HEAD 归档、工作区补丁、计划原文、逐文件 SHA-256、Git index/status/HEAD 和工具版本。
- `HEAD.tar.gz` SHA-256：`cf81b1a2108ceaf3095597ef84a664d200873065eb1e850b6779a0fea2257d3b`。
- 计划原文 SHA-256：`40c35669598b6bf8efe7a9f451f7b495b6a3943a19d4d77f3c08f4c446556b1d`。初始补丁为空。
- 恢复时在新的空目录解开归档、应用保存的补丁，再恢复计划原文；不要覆盖当前工作区。
- `.native-input-p0/` 同时从 Git 与 Vitest 发现排除。可审查源码位于 `scripts/native-input-p0/`，下载、构建、测试凭据及证据都保存在忽略目录。
- 正式原型套件独立复制 Shell 与模块，保存 `suite-inputs.json` 和 `build-inputs.json`。实际测试二进制不会被后续构建覆盖。

## 环境与适用边界

| 环境 | 实际构建 / 结果边界 |
| --- | --- |
| macOS | 27.0.1 / 26A434，Darwin 27.0.0 arm64；Apple Clang 21，Rust 1.95.0，Node 24.21.0，pnpm 11.1.1；真实 PTY |
| GNU Bash 4.1 | 固定 GNU 4.1 归档、捆绑 Readline 6.0；macOS、Linux 容器本地与 SSH 独立验证 |
| GNU Bash 4.4 | 固定 GNU 4.4 归档、捆绑 Readline 7.0；同上 |
| GNU Bash 5.3 | 固定 GNU 5.3 归档、私有静态 Readline 8.3.6，官方补丁 001–006；同上 |
| Homebrew | Bash 5.3.20、外部 Readline 8.3.6；独立 macOS 验证 |
| 未修复的 5.3 / Readline 8.3 | 已复现事件钩子等待不消费输入；**不支持** |
| 系统 Bash 3.2.57 | 动态加载报 `_rl_done` 不可用；原生桥接不可用，旧生产路径保留 |
| Linux / SSH | Docker Desktop LinuxKit、Debian 12/aarch64、glibc 2.36、OpenSSH；回环动态端口，不外推裸机、musl/Alpine 或其他架构 |
| Zsh | 系统 5.9；只跑现有集成回归，新 ZLE 适配属于 P3 |
| PowerShell | 仓库 PSReadLine 2.4.5 资源存在；无 Windows/ConPTY 实机，5.1/7 新路径 **MISSING** |

每个 Shell 有独立 HOME、rc、inputrc、history，locale 为 `en_US.UTF-8`，默认 emacs 编辑及默认 INT。覆盖只读 LC_ALL、用户标量 PROMPT_COMMAND、ANSI 提示符、extglob、history 设置、父 Shell 函数和别名。自定义 INT、占用私有按键、其他输入提供者/事件钩子均不在已验证配置内。

GNU Readline 8.3 的失败与[官方 `readline83-001`](https://ftp.gnu.org/gnu/readline/readline-8.3-patches/readline83-001)描述和代码相符。后续使用固定哈希的官方 Readline 8.3.6，没有调用 `_rl_*` 绕过它。捆绑库的字符串版本可能滞后，证据同时记录数值版本和二进制哈希；不能凭 `BASH_VERSION` 推断能力。

## 原型机制

构建与复现命令见 [README](../../scripts/native-input-p0/README.md)。`enable -f` 与目标 `struct builtin` 提供加载入口。使用公开的 Readline 预输入/事件钩子、行缓冲区、光标、原生替换/接受和按键注册/查询 API，不链接 Bash evaluator 或未验证内部符号。

完整源码与计划通过私有 Unix socket 传输。Rust 使用 `serde_json`、`unicode-segmentation`、`shlex` 和 SHA-256；Python 使用标准增量 UTF-8 codec 和 JSON decoder。源码上限 8192 字节，缓冲区上限 131072 字节；接收期限 5 秒，动画预算 1.5 秒，减少动态效果直接应用完整输入。

真实编辑器就绪后，一个不执行源码的服务按键开始有界接收。草稿阶段在编辑器线程推进原文字素前缀；完整输入回执读回实际原生缓冲区，检查字节、光标、源码及计划绑定。普通用户输入阶段不安装事件钩子。

一次原生 Ctrl-X a 提交先完成原文的 Readline 接受重绘，再替换交还给 Bash 的内部行。回调内不执行源码。父 Shell 顶层执行实验固定计划 `p0_begin "$?"; builtin eval -- Q`；原生 builtin 在该边界恢复本次 INT 屏蔽并保留此前状态。实际结束码由可信提示符钩子记录，没有归一化或伪造。

history 设置不改写，条目保留实际包装，沿用现行协议的包装上下文边界；没有承诺字面 history 等于原文，也没有修改生产 `bash_native_submission`。控制描述符使用 CLOEXEC 与真实 atfork 子进程关闭回调。模块映射固定到 Shell 生命周期，采用核实的 `*_builtin_load/unload` 入口，停用时恢复钩子并关闭通道，避免 atfork 悬空指针。

## 实际检查与证据

| 检查 | 实际结果 / 路径（均在 `.native-input-p0/` 下） |
| --- | --- |
| 最终原型 macOS GNU 4.1/4.4/5.3 | 各 **45/45**，退出 0；`final-record/macos-*`，包含模块停用后真实子进程和延迟收包后的钩子退出 |
| 最终原型 Linux 本地 4.1/4.4/5.3 | 各 **45/45**，退出 0；`final-record/linux-*` |
| 最终原型 SSH 4.1/4.4/5.3 | 各 **45/45**，入口退出 0；每轮独立 known_hosts 的最终记录为 `ssh/runs/20261031-045831/`，`final-ssh-frozen-hosts.log` |
| Homebrew 5.3.20 独立补充 | 较早冻结模块 **43/43**，退出 0；`accepted/homebrew-5.3.20`；最终增量候选另有真实探针 |
| 普通与超视口输入、选择/搜索、提交画面 | Chromium/WebKit × DOM/WebGL × 亮暗主题；32/40/100/180 列，完整公开缓冲区与真实用户输入对照通过 |
| 最终整体前缀替换的完整浏览器门禁 | **0/8，退出 1**；`final-render-gate.log`、`final-record/macos-5.3/browser/unicode6/full/` 中的结果、状态和 PNG |
| 最终增量 `rl_insert_text` 候选 | 原生探针 **3/3**，退出 0（后台/缩窗、模块停用、钩子退出）；浏览器 **0/8，退出 1**；`insert-final-native.log`、`insert-final-render.log`、`insert-final-record/browser/unicode6/background-only/` |
| 现有前端契约 | 5 文件 **110 项通过**；`frontend-regression.log` |
| 现有 Rust 执行回归 | **23 项通过**；`rust-execute-regression.log` |
| 现有源码展示与重绘浏览器 | 均退出 0；`legacy-source-browser.log`、`legacy-redraw-browser.log` |
| 现有命令装饰浏览器 | 首轮 Zsh 回执超时；独立用例及完整重跑通过。最终 **5 通过 / 3 忽略**及浏览器通过；`legacy-presentation-final.log`。首轮失败仍保留 |

每个用例保存原样 `pty.bin`、resize/read/request 时间线、真实私有回执、运行时 Shell 身份、受控副作用文件和原生信号对照。浏览器读取实际录制字节，仅使用公共 xterm API，不安装投影、假光标、选择/搜索覆盖或输出过滤。版本为 Playwright 1.63.0、Chromium 153.0.8010.12、WebKit 26.6、xterm 6.0.0。状态、版本和截图保存在各捕获套件内部；这是原生字节的真实浏览器回放，不构成线上 Tauri/Broker 验收。

## 阻塞复现与后续门禁

真实后台进程依次输出 `BG_1` 到 `BG_5`。同时输入 Unicode 长命令，窗口在 180、40、32、100 列之间改变。五段文字都存在于 `pty.bin`，但最终 xterm 缓冲区缺失 `BG_1` 等输出。八个浏览器组合全部复现。

整体替换候选的真实画面：[覆盖前](../../.native-input-p0/final-record/macos-5.3/browser/unicode6/full/chromium-dom-dark-background-before.png)、[覆盖后](../../.native-input-p0/final-record/macos-5.3/browser/unicode6/full/chromium-dom-dark-background.png)、[最终公开缓冲区](../../.native-input-p0/final-record/macos-5.3/browser/unicode6/full/chromium-dom-dark-background.json)。增量候选的对应证据在 `insert-final-record/browser/unicode6/background-only/`。

运行 `background-resize-unicode` 原生用例，再用实际捕获运行浏览器门禁即可复现。断言是此前输出仍可回看，不能只断言原始字节存在，也不能删除该断言。原生整体前缀替换和增量插入分别留下证据。

这阻止满足 T06，并使有后台输出的 T08 不能接受。禁止以前端历史改写、过滤、假光标、反复重放屏幕或静默取消后台支持来掩盖。下一步先解决 Shell 原生异步输出与编辑器重绘的协调，再跑相同矩阵；需要减少现有支持场景时，必须由用户决定。

已验证取消/接管、已有草稿保护、确认后真实字符/光标变化、摘要/身份不符、期限、重复及迟到提交、部分帧/输入中/确认后/提交后的控制 EOF。提交先赢使用真实 INT；真实副作用可能只完成一部分，不重放或倒回。Bash 4.1 内建循环原生 INT 状态可能为 128，外部前台程序为 130，保留真实值。提交后控制通道关闭保持不确定。

未覆盖：生产 Broker/审批/持久提交记录接入、应用崩溃恢复、重连授权、Windows/ConPTY、新 ZLE/PSReadLine、裸机/x86_64/musl、自定义输入插件/INT、PROMPT_COMMAND 数组、独立 CR 用例和新路径 TUI/凭据专用输入。P1–P3 仍需独立验收。

## 构建与分发

GNU 归档、Readline 补丁固定哈希，Rust 固定 Cargo.lock；每个目标独立构建。GNU Bash/Readline 声明 GPL-3.0-or-later，完整源码/补丁/notices 保留于隔离构建目录，Rust license 标识由 Cargo metadata 记录。没有新发行包、安装器或业务主机上传。

后续分发需按 OS/架构/libc/Bash 导出能力生成模块，使用不可变内容寻址暂存、加载前哈希检查及依赖 notices/源码来源。已验证不可变暂存和哈希记录；签名、跨平台发行与线上启动回退仍属后续阶段。当前 P0 失败证据不授权生产切换。

## 修改文件与最终检查

- `scripts/native-input-p0/`：C 加载入口、Rust 原生桥接/计划编码、锁文件、GNU 来源清单、构建脚本、真实 PTY/SSH/浏览器验证、诊断入口和 README。
- `scripts/verify-terminal-native-input.mjs`、`package.json`：可复现门禁与命令登记；`.gitignore`、`vitest.config.ts`：排除验证产物及临时构建。
- 本报告、实施计划 P0 执行标记，以及当前 RFC、命令展示说明、执行测试矩阵：记录失败门禁、证据和后续限制，没有改动线上 schema。
- `protected-source-audit.log` 对修改前 `src/`、`src-tauri/` 哈希清单校验通过，生产源码没有变化。`git diff --check`、原型 `cargo fmt --check`、两个 JavaScript 入口语法检查均通过。
- 完整前端/完整 Rust 发布门禁未运行；本轮运行的是与 P0 和旧输入保护直接相关的回归，不宣称整个项目已通过发布检查。

## 续验证：因果证据与合规候选

续验证开始时保留了 P1 已有的 source-free `inputObservation` 改动和其他工作区内容。新增基线 `.native-input-p0/continuation-baseline/` 包含完整已跟踪差异、P0/P1 未跟踪源文件归档及 P1 六个所属文件的 SHA-256 清单。续验证没有改动这些 P1 文件；并行的 SFTP 改动也不属于本任务。

### 无桥接实验补齐了什么

`background-causality.py` 的 `pure` 模式完全不加载扩展、不创建控制 socket、不注册编辑器回调。运行相同冻结 Bash/Readline、HOME/inputrc、locale、提示符、源码、后台进程和 180→40→32→100 列变更；实际用户键盘输入使用 ICU `Intl.Segmenter` 的完整字素分批推进，总预算 1.5 秒。`enable -p`、rc、运行时身份、history、原样 PTY 和完整时序都保留。

实验同步仅用受控提示符文件和实际 tty 模式，不把 stdout 作为执行授权。浏览器在 `observed-end` 截止，避免把退出测试时的 Ctrl-C 重绘混入故障判定。

| 相同 Bash 5.3 / Readline 8.3.6 的对照 | 原生采集 | 8 个浏览器组合 | 证据目录（`.native-input-p0/background-causality/` 下） |
| --- | --- | --- | --- |
| 无桥接，用户编辑＋缩窗 | 退出 0，BG 五次各一次 | 0/8；部分 BG 被覆盖 | `2026-10-31T05-23-02.073Z/pure` |
| 仅加载桥接，仍由用户输入 | 退出 0 | 0/8 | 同轮 `loaded-user` |
| 无桥接，仅编辑、不缩窗 | 退出 0 | 8/8 | `2026-10-31T05-27-26.331Z/pure` |
| 无桥接，仅缩窗、不编辑 | 退出 0 | 8/8 | `2026-10-31T05-27-27.508Z/pure` |
| 无桥接，不编辑、不缩窗 | 退出 0 | 8/8 | `2026-10-31T05-27-28.714Z/pure` |
| 受控 SSH 无桥接，编辑＋缩窗 | 退出 0 | 0/8 | `.native-input-p0/continuation-ssh-causal2/ssh-5.3-pure` |

因此，旧桥接不是故障发生的必要条件；但旧桥接覆盖得更多，不能把所有问题归咎于“原生限制”而不修正桥接。

### 官方接口与当前源码依据

阅读依据是固定 GNU 归档中的 `doc/rltech.texi` Redisplay / Readline Variables / Signal Handling 章节、`display.c`、`terminal.c` 和 Bash 的相关调用，而不是网页摘要。维护者 HTML 偶发超时，以本地已校验官方源码包为准。

- [GNU Readline Redisplay 文档](https://tiswww.case.edu/php/chet/readline/readline.html#Redisplay)：`rl_on_new_line` 是对实际已移动到新空行的通知，不是发现任意后台输出的接口；`rl_save_prompt/restore_prompt` 与 `rl_message/clear_message` 处理应用自身的消息区，不会接管其他进程直写 PTY。
- 目标源码 `terminal.c::rl_resize_terminal` 默认进入 `_rl_redisplay_after_sigwinch`；后者在旧显示位置执行 `rl_clear_visible_line`。没有经过 Readline 的后台写入已经移动了实际光标，旧显示位置可能含有真实输出。
- `display.c::rl_redisplay` 对超视口输入还包含 `_rl_clear_screen(0)` 分支。模块没有调用这些内部符号，也没有靠内存热补丁改变它们。
- 公共 `rl_redisplay_function` 允许原生提供者；公共 `rl_done` 是接受当前真实编辑行的接口。新候选仍以真实 Readline buffer、point/end 和完整摘要绑定为准，用户源码不在回调内执行。

### 明确拒绝的体验补偿

仅在开始调用 `rl_crlf/rl_on_new_line` 不能解决故障。尺寸变化时保留旧片段、整屏空行滚动，以及按行数只动画很短前缀的实验，虽然有些能保留 BG 标签，但引入了额外空白、滚动或草稿重复。这些 `start-rebase`、`geometry-rebase`、`viewport-safe` / `preserve` 只是拒绝实验，不作为符合原位体验的通过方案。

### 新原生候选与通用依赖实验

`append-display` 在占有不可变草稿期间安装 Readline 的公开 redisplay provider，只输出**真实编辑缓冲区新增部分**，不复制期望源码当回执，不保存另一个展示文本，不计算像素/列宽/光标，不发清屏或大段空行，也不在 resize 时重放长草稿。仍按全部字素预算推进，没有缩成短前缀。提交在原生按键回调中以已核实的 `rl_done` 接受，交还固定计划给父 Shell 顶层；取消/结束恢复原有 provider。

此候选单独使用时 BG 标签保留，但复制文本仍会丢字，不能据此判通过。核对了 [xterm 官方类型说明](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts) 和当前 6.0.0 `Buffer.ts`：`reflowCursorLine` 只重排内容，不移动光标；resize 后继续追加会覆盖已重排的字符。相关 [上游问题 #6130](https://github.com/xtermjs/xterm.js/issues/6130) 也区分了光标行截断和光标位置问题。

用户已明确允许**隔离的通用依赖修复实验**。`xterm-cursor-reflow.patch` 仅在现有 opt-in reflow 时保留终端自己的光标 cell offset，用既有 BufferLine 重排函数及行插入、删除、裁剪事件恢复活动光标和保存光标；不读取命令、源码、操作或租约元数据。它是独立源码副本中的通用终端规则实验，不是业务层 `_core` 修改、getLine/selection/search 覆盖或源码投影。

原包 Buffer SHA-256 保持 `7d48cc12cf3c32b9cac1b6f6cfcee01215a1edb66e0dab48ceb3f87d9c25b422`。独立 bundle/patch/source 的哈希在 `xterm-reflow-lab/manifest.json`；本实验没有修改原始 NPM 包、生产终端代码或终端依赖的锁定条目。工作区另有并行依赖更新，最终用成熟 YAML 解析器逐项确认四个 `@xterm/*` importer、package、snapshot 与 HEAD 一致，见 `terminal-lock-preservation.json`，没有恢复整个锁文件。另做了同源码、同 esbuild 的未修复控制，排除构建器差异。

### 最新研究组合检查

| 检查 | 结果与证据 |
| --- | --- |
| append provider，macOS Bash 4.1 / 4.4 / 5.3 | 各 45/45，退出 0；`append-native-4.1.log`、`append-native-4.4.log`、`append-full-native.log` |
| append provider，真实 SSH 三个 Bash 构建 | 各 45/45，退出 0；`continuation-all-ssh-native.log`、`ssh/runs/20261031-064313/` |
| 三个 macOS 构建的完整研究浏览器门禁 | 各 8/8；`append-browser-4.1.log`、`append-browser-4.4.log`、`append-full-browser.log` |
| 相同真实流，原包或相同构建器的未修复库 | 完整复制流断言 0/8；`continuation-append-reflow.log`、`continuation-bundler-control.log` |
| 通用依赖修复＋原生追加提供者 | 完整复制流 8/8；`continuation-append-dependency-lab.log` |
| 超视口长脚本同一严格门禁 | 8/8；`continuation-large-dependency-lab.log` |
| 受控 SSH 修复组合 | 8/8；`continuation-ssh-append-browser.log`、`continuation-registered-ssh.log` |
| `reflowCursorLine=false` 通用依赖默认行为 | 128 个真实捕获状态与原库逐字段相同；`xterm-default-control.json` |

新的浏览器断言不只检查 BG 标签：对追加模式，将同一真实 PTY 字节写入有 resize 与无 resize 的两台实际终端，比较完整复制流；普通/长输入要求全文搜索和选中文本等于真实源码，从开始到光标的复制内容精确为原提示符＋源码，没有额外空行、重放或丢字。旧候选的全状态基线比较保留；拒绝实验没有以局部比较改称通过。

当前决定：单独光标补丁和异步切换对照不是完整方案。同流显示与通用复制组合已获用户新的正式采纳授权，并完成正式包验收，见文末；原生产命令写入链路仍保留。生产状态/权限/持久提交接入属于未完成的 P1/P2，不外推 Windows、其他架构或用户插件。

新组合的[SSH 输入中实际画面](../../.native-input-p0/continuation-ssh-causal2/ssh-5.3-append-display/browser/unicode6/background-only-cursor-reflow-dependency-lab/chromium-dom-dark-background-before-submit.png)与[超视口实际画面](../../.native-input-p0/background-causality/2026-10-31T06-06-30.379Z/append-display/browser/unicode6/background-only-cursor-reflow-dependency-lab/chromium-dom-dark-background.png)没有整屏空行滚动或整段草稿恢复；共享终端的真实后台输出仍可能与输入交错，未伪造为隔离输出区域。无桥接对照和每个候选的公开缓冲区、完整复制流、编辑阶段 CSI 只读记录、实际 resize/输入时间线都在相应套件目录。

注册入口已验证：`continuation-research-entry.log` 为 `--browser-only --research-profile` 的退出 0；`continuation-registered-ssh.log` 为独立回环 SSH 研究入口退出 0。`continuation-protocol-regression.log` 的现行协议契约 16/16 通过，语法、原型 Rust 格式和 `git diff --check` 通过。正式发布全套仍未运行。

最终并发保护复核：P1 的 Broker、相关两个 Rust 测试及审计文档共四个文件与续验证基线逐字节相同。并行 SFTP 工作扩展了 `src/types/index.ts` 和 typed IPC，两个文件整体哈希变化；`audit-p1-preservation.mjs` 用成熟 diff 与 TypeScript AST 在内存重建基线，对 P1 三个 interface 以及 `invokeGetTerminalBrokerSnapshot` 的完整函数文本逐字比对，通过并保存在 `p1-preservation-audit.json`。没有为恢复哈希撤回并行改动。原包 xterm Buffer 与终端依赖锁定条目不变，没有遗留本任务的 SSH 容器，没有 commit、push、tag 或发布。

### 光标补丁单独使用的兼容性对照

`terminal-compat.py` 通过真实 OS PTY 采集固定终端程序、未加载桥接的 GNU Bash 5.3 / Readline 8.3.6 以及系统 Vim 的实际输出和 resize；`terminal-compat.browser.mjs` 将原样字节交给 Chromium/WebKit × DOM/WebGL 的公开 Terminal API。终端程序的固定输入是库断言的受控刺激，不是伪造 Shell 回执。仅普通 Bash 编辑用例另以实际执行结果文件核实原生编辑结果；这些检查均不构成生产 Broker/Tauri 验收。

冻结记录在 `.native-input-p0/dependency-compat-pty-v4/`，注册入口的完整复跑见 `compat-registered-complete.log` 及其指向目录，含 PTY、时间线、逐文件哈希、全部公开 buffer/cursor/selection 状态和实际截图。早期 v1–v3 的失败原样保留。首次补查发现的长行裁剪光标丢失及 saved cursor 错位已在隔离补丁中修正：重用现有 reflow 行长计算，保留允许为负数的 resize 局部锚点，并分别映射活动和保存光标。没有修改生产源码、输入权限或选择接口。

| 兼容性检查 | cursor-only 对照结果（不含后续复制修复） |
| --- | --- |
| 非行尾光标、宽字符及组合字符下的光标位置 | 每例 4/4；缩放后字符位置及实际覆盖字符一致 |
| pending wrap、非 pending 的边界列 | 每例 4/4；继续输出不覆盖前文 |
| 同时改变行列数、活动长行被 scrollback 裁剪、上方历史裁剪 | 每例 4/4；包含小容量 scrollback 的真实裁剪 |
| 保存/恢复光标、有 scrollback 时保存光标 | 每例 4/4；恢复位置和继续输出符合预期 |
| 滚动区 | 4/4；实际 DECRQSS 回复证实 resize 后按原库规则重置为全屏，未私读滚动区字段 |
| 备用屏和真实 Vim resize/移动/退出 | 每例 4/4；公开完整状态与同构建器原库一致 |
| 连续 9 次缩放，Unicode 内容及继续输出 | 4/4 |
| 制表符已在 16 列展开，再缩到 8 列 | cell 不变量 **4/4**，原有空白和 B 的逻辑列位置保留；复制契约 **0/4**，`A       B` 成为 `AB` |
| Tab 在缩到 4 列后才到达、显式设置 tab stop | 每例 **4/4**；按实际列数和 stop 展开为 `A  B`，不要求等于 16 列展开结果 |
| 普通原生 Readline 编辑，错误地始终开启 true | Unicode 与 ASCII 两例均 **0/4**；SIGWINCH 自身重绘与库重排叠加，重复草稿。属于配置不适用，不能等同于默认关闭模式的补丁回归 |
| 普通原生 Readline 编辑，保持默认 false | 全状态与原库一致；ASCII 无重复且可见行内容正确，实际编辑/提交结果正确。硬换行后“复制等于无换行源码”不成立是保留的更强诊断，**不是原始产品要求或新增门禁** |

早期未区分适用范围的 18 例记录中，始终 opt-in 得到 60/72 通过、12/72 失败；原始日志保留，这个汇总不再充当当前产品门禁。普通用户全局 true 是不适用配置，普通默认 false 的无换行源码等值检查是额外诊断。T05 原要求是使用原生缓冲区、回看与复制一致；T08 要求重绘不改变源码或提交次数，没有要求无 owned 路径参与的 Readline 硬换行必须从复制结果消失。普通编辑的有效门禁是默认 false 的原生状态/复制行为与原库一致、实际编辑执行正确。owned append 的完整可见文本、复制、源码绑定及真正丢字检查继续是硬门禁。

Tab 的判断依据是当前官方包 `InputHandler.tab` / `Buffer.nextStop`：Tab 只按到达时的实际 x 和 tab stops 移动光标，末端受当前列数限制。已展开后再缩窗的用例中，公开 cell 显示 `A` 后 7 个空 cell 仍在，`B` 仍在逻辑列 8；因此没有证据说这些 cell 被光标补丁覆盖或裁剪。丢空格来自原库 `SelectionService.selectionText` 对每个物理行先 trim、再拼接 wrapped 行。这个真实 T05 缺陷由文末的通用序列化补丁修正，对照失败及正确性断言都保留；“缩窗后才到达 Tab”仍按实际列允许 `A  B`，不强行比较不同到达列的展开宽度。

### 异步回执驱动的所有权窗口：失败对照

`ownership-window.py` 使用冻结的真实 Bash/module、私有控制通道和实际提交按键采集 9 个场景，浏览器通过公开 `term.options.reflowCursorLine` 切换。测试控制器显式记录 open/close 以及被延迟投递的**真实**回执；不据此承认执行、提交或还权，原生授权和 source binding 不变。原始回执到达时间也保留，延迟仅施加于实验显示控制器，不伪造原生事件。

| 条件 | 结果与分类 |
| --- | --- |
| 提交、输入中取消、确认后取消、接管、本地已知 EOF | 串行实验中可在发出 prepare 前开 true、在发出还权/提交前关 false；还权后的普通用户草稿显示及真实执行正确 |
| 提交进入真实 Vim，迟到 Prepared 在 TUI 内交付 | 已关闭的显示窗口忽略迟到回执，不重新开 true；Vim resize/退出及随后用户输入正确 |
| false 已恢复，但原生尚未接受提交，此间发生 resize | **失败**；原生仍持有的长草稿被按 false 规则裁剪，完整复制断言失败；实际命令仍只执行一次 |
| 原生通道 EOF 已清理草稿，显示 close 通知未交付 | **失败**；实验显示选项仍为 true，不能证明普通编辑已经恢复默认模式 |
| Prepared 显示投递延迟，等收到后才开 true | **失败**；此前原生追加和 resize 已发生，事后开 true 不能恢复已丢内容 |

这不是“只在原生拥有草稿时 true”已经成立的证明：开在 prepare 之前存在取得所有权前窗口，关在提交之前存在原生仍持有草稿的窗口；改为等回执又受迟到和失联影响。该异步方案没有同一有序流上的显示切换边界，也没有生产 Broker/renderer 的恢复协议。因此，普通编辑 true 的失败归类为配置不适用，异步切换失败归类为边界协调缺失；两者不能混作光标补丁的同一根因。新的同流实验见下一节，原始失败保留。不能把前端显示确认升级为执行授权，不能宣称现在已接入生产，也不能用默认 false 对照通过豁免这些竞态。

当前 patch SHA-256 为 `8ee40207601e24bdf9370519f77db625536d88d9dd9436ae276e18f91fe83a7e`；bundle 为 `48b817a5131d97bafe6cb02824fc8aa10e05e58bd897d71b070d59aa7ae6abf6`。同构建器原库和候选的哈希在 summary 中随证据冻结。

`pnpm test:terminal-native-input:p0:compat` 和既有 `--research-profile` 仍使用 cursor-only/异步切换对照，保留其真实失败退出码；普通硬换行的强源码等值已改为诊断，不再阻塞验收。这些对照与 `:inband`、`:copy` 的组合修复作用域不同，不能以任意一个入口的汇总替代正式采纳决定。

相关协议契约仍为 16/16。额外直接检查 NPM 源码的 strict TypeScript 时，原库与隔离补丁均有相同 6 个诊断（vendor catch 类型、包内缺失 `vs/nls` 和 global 类型）；没有把该检查标为通过，也没有修改 vendor 或加忽略注释规避。生产依赖、锁文件、P1 与并行 SFTP 改动继续保留。

实际画面：[普通编辑缩窗后的重复草稿](../../.native-input-p0/dependency-compat-pty-v3/browser/chromium-dom-native-edit-narrow.png)、[Vim 窄屏](../../.native-input-p0/dependency-compat-pty-v3/browser/chromium-dom-vim-tui-32x10.png)。缺陷有完整原样流和断言，不采用业务层光标、选择或搜索覆盖进行补偿。

### 同一真实 PTY 流内的显示模式实验

官方依据分别核实了已安装 6.0.0 的 `InputHandler`、`Buffer`、public typings，以及 [xterm 公共 parser API](https://xtermjs.org/docs/api/terminal/interfaces/iparser/)、[hook 执行时序](https://xtermjs.org/docs/guides/hooks/)、[iTerm2 SetUserVar](https://iterm2.com/documentation-escape-codes.html) 和 [2026 同步输出语义](https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md)。没有找到直接控制 `reflowCursorLine` 的标准 escape 模式；2026 只同步呈现，不能被改用为重排模式。文档间对 APC hook 的描述存在漂移，已安装版本的公共接口不提供它，本实验没有使用 APC。

可复用的是文档化的 OSC 1337 `SetUserVar=key=base64` **载体**。实验键 `ShellSpanP0ReflowCursorLine` 与公开 `term.options.reflowCursorLine` 的关联，是本次隔离研究定义的显示扩展，不是 iTerm2 已有重排语义，不分配新的 CSI/OSC 标准模式编号，不修改正式 TSP 协议。只识别两个完整常量负载，其他 key/value 返回未处理；OSC 分片、终止符和编码状态都由 xterm 现有 parser 处理，没有自写字节解析器。

`inband-display.patch` 仅应用到独立 C 源码副本，生成独立 module。真实 provider 安装时在首个新增草稿字节之前写入 on；接受行完成原生 CRLF 后进入下节的原生提交显示保护，再写 off，直到 Readline 已返回才恢复默认 provider；取消、接管和控制 EOF 的清理路径也在恢复默认绘制前写 off。每次信号立即 flush 到同一 PTY。浏览器的同步 OSC handler 只设置这个公共显示选项，不等待渲染，不读 source/lease/command 元数据，不访问 `_core`，不写光标、buffer、选择或搜索。

SIGHUP 另暴露了原型轮询 hook 的协作缺陷：Bash 会通过公共 `rl_signal_event_hook` 安装退出处理，而轮询输入没有进入常规 interrupted-read 分支。固定 GNU 源码与文档核实后，隔离 C 副本在重新进入 Rust 前调用该已有公共钩子，并先在同一 PTY 写 off；回调正常返回时再按仍有效的 provider 状态恢复 on。没有直接调用私有 Bash signal handler，没有替换用户 signal handler，也没有把真实退出码改写成成功。旧模块基线有相同超时，旧失败和新探针均保存。

强制 SIGKILL 无法由已死亡进程补发字节。实验显式验证：在真正内核 PTY EOF 通知前选项仍为 true，只有终端传输结束清理才恢复 false。这个 EOF 清理不是 shell 命令结束回执，不授予输入权，也不把可能提交的命令标为未执行；生产端的对应清理和重连实现尚未接入。

`pnpm test:terminal-native-input:p0:inband` 是独立入口。原生阶段独立完成真实 prepare/commit/取消和进程验证，**从不等待浏览器**。浏览器阶段只回放原样录制字节：一轮逐段处理，另一轮逐字节分片并让 resize 在 queued write 解析前立即发生；checkpoint 的等待仅用于测试断言，不是原生提交权限。后台输出场景将相同实际流同时交给有 resize 和无 resize 的两台公开 Terminal，比较完整复制流及五条 BG 输出。

最终记录为 `.native-input-p0/inband-runs/2026-10-31T07-47-56.795Z/`：原生 **15/15**；Chromium/WebKit × DOM/WebGL 两种回放策略各 **60/60**，入口退出 0，测试源码前后哈希一致。逐段解析的同构建器未修复 xterm 控制有 **52/60** 用例失败，修复候选没有失败；queued 策略中原库也能通过，因为这一顺序让 resize 先于待解析正文发生，不把它当作光标补丁必要性的证据。

`inband-parser-boundaries.mjs` 再将同一真实录制中的 on/off 包在每个字节边界拆开，在包尚未结束时执行 32→40 列 resize，公共 parser 的模式值只在完整终止后改变，复制到**实际光标**的内容与不 resize 的公开 Terminal 一致，**408/408**，见 `inband-parser-boundaries-handoff.log`。这是额外的库级分片/resize 断言，不伪称新的 Shell 几何验收；未把未写入的 viewport 空白行算作 PTY 输出，也未归一化内部空格或已输出换行。

修正后的模块又完成 **45/45** 原生回归，见 `handoff-native-regression.log`；协议契约 **16/16**。普通用户编辑仍使用 false；外部真实 stdout 可以切换这个不可信显示变量，但没有 native draft 时 commit 仍被拒绝，未生成 SubmissionAccepted。SIGHUP 真实以信号结束，正常 exit 保留 7；没有把这些状态改写成退出 0。SIGKILL 的测试明确区分 EOF 前模式尚未清理与真正 PTY 结束后的显示清理。

### 提交接受窗口的隐藏包装保护

源码审阅不能用 `rl_done` 排除问题：目标 Readline 的 dispatcher 在 `_rl_dispatch` 返回后仍执行 `RL_CHECK_SIGNALS`；`rl_resize_terminal` 的默认绘制分支也不以 `rl_done` 为门禁。因此，在 `p0_accept_line` 完成而返回行已换成 plan 时恢复默认 redisplay，确实存在 SIGWINCH 绘制隐藏 plan 的窗口。

`commit-resize.py` 使用真实线程持续变更 OS PTY 行列，未延长原生回调、未插入模拟信号或回执。未修正 module 在**第一次提交、255 次真实窗口变更**时就泄漏了包装：原样 PTY 含有 `p0_begin "$?"; builtin eval -- ...`；实际副作用仍只发生一次。原始失败保存在 `commit-resize-before-fix/commit-resize-mlbhdskw/`，未删除断言或改用过滤。

修正在独立原型 `bridge.c` 中，继续只使用公开 Readline 接口：原文接受绘制结束后、Rust 替换隐藏返回行之前，安装只用于已接受交接窗口的无输出 redisplay provider。`p0_finish_input` 结束草稿显示并发出 off，但暂不恢复默认绘制；父 Shell 已完成 Readline 返回和固定计划解析、进入首个 `p0_begin` builtin 时才恢复默认 provider，随后原有 Rust 边界恢复 INT。新一轮原生 pre-input 和卸载提供明确的恢复后备边界。没有新增信号屏蔽或私有 Readline 调用，没有更改执行计划或以浏览器 Running 事件恢复。

实测顺序是：原文接受/CRLF、保护隐藏返回行、off 字节、Readline 返回、原生 builtin 恢复默认绘制、实际命令输出。密集缩窗也不能令默认 redisplay 读取隐藏 plan；执行授权仍是原生匹配的 commit 和一次真实按键。

修正后 GNU Bash 4.1 / 4.4 / 5.3 各 **64/64** 连续提交通过，短文、Unicode 和长文轮换。每次提交前实际读回 native buffer 与 UTF-8 point=end；每次均只出现一个 SubmissionAccepted 和一份对应副作用，原始 PTY 没有包装标识。5.3 的同流模式另严格检查原文完整字节在 off 之前、off 在实际输出之前；4.1/4.4 使用各自固定 Readline、普通原型 module，不冒称这两个构建已验证同流扩展。日志分别为 `commit-resize-fixed-4.1.log`、`commit-resize-fixed-4.4.log` 和 `commit-resize-final-5.3.log`，二进制哈希、逐次几何变化与原样 PTY 均保留。

这仍是 macOS arm64、固定 GNU Bash 5.3 / Readline 8.3.6 的隔离原型；没有据此宣称 Linux/SSH、tmux/screen、其他架构或 Windows 已支持该显示扩展。正式能力协商、上线分发、终端 EOF 恢复和 Broker/Tauri 接入都未实现。本轮新增复制修复见下节；技术结果不能自动授权采纳通用规则变化。

### 通用复制序列化修复与适用范围

可审阅补丁为 `scripts/native-input-p0/xterm-copy-serialization.patch`，SHA-256 `848172022f39f1ea42e312cef093333f3a6fa39504016ffe87d702945e256446`。它仅改隔离副本的 `SelectionService`，并把现有 `getWrappedLineTrimmedLength` 参数类型拓宽到 `IBufferLine[]`，后者没有运行时行为变化。独立构建目录为 `.native-input-p0/xterm-copy-lab/`，对照是相同构建器的 cursor-only 版本。未修改生产 node_modules、lockfile 或业务层 `getSelection/search/getLine`。

实现只读取真实 buffer cell、`isWrapped` 和当前选择范围：软换行后仍有实际内容时，保留逻辑行内部的空 cell；用原有 reflow 行长计算排除宽字换行占位；逻辑行尾的空尾行继续裁剪，实际输入的 U+0020 空格保留；硬换行及列选择维持原处理。备用屏可能在缩窗后保留旧行宽，序列化使用实际 `line.length`，避免以视口列数裁掉仍在原生 buffer 中的字符。每个逻辑行范围只扫描一次，不引入逐行重复扫描整个长行的二次复杂度。没有命令、source、operation、lease 或期望文本缓存。

这里的**作用域是全局通用复制规则**，不受 `reflowCursorLine=false` 保护，也不只影响 owned append。默认配置下，普通历史输出若具有同类软换行内部空 cell，复制值也会从错误的 `AB` 修正为 `A       B`。这是有意修复的原库缺陷。代表性普通 Readline 编辑与原库一致，只证明这些用例没有意外回归，不能宣称所有旧配置、所有复制内容完全不变；这项全局影响已向用户说明并获本轮正式采纳授权。

参考了固定上游 [SelectionService 测试](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/browser/services/SelectionService.test.ts) 的词选择、宽字、整行与列选择语义。上游文件使用 Mock，未将其单测计入通过数；本轮用实际 PTY 输出和浏览器标准鼠标事件重现相关行为。现有未修改的 SearchAddon 自身也按软换行保留内部空白并排除宽字占位，本轮直接使用它验证搜索命中和实际选中文本，没有修补搜索或公共 buffer API。

复现入口：`pnpm test:terminal-native-input:p0:copy`。最终证据为 `.native-input-p0/copy-runs/2026-10-31T08-48-37.817Z/`，入口退出 0，前后测试源码哈希一致；`review/` 已保存实际 bundle、manifest、补丁和验证源文件归档：

| 检查 | 结果与适用范围 |
| --- | --- |
| 复制/搜索相关有效用例组合 | **344/344**：320 个库配置组合、12 个配对的 owned in-band 组合、12 个普通默认编辑组合；覆盖 Chromium/WebKit × DOM/WebGL |
| cursor-only 对照 | 同一有效范围 **56 个失败**，包含已失败的 owned Tab 复制及搜索选择场景；没有排除这些场景来宣称通过 |
| 普通编辑与未修改原库直接对照 | **12/12**，ASCII、Unicode、真实 quoted-insert Tab 的状态和复制结果逐项一致；真实编辑执行正确，普通 Tab 的实际文件及 history 保留 Tab |
| owned 原生源码绑定 | 3 个真实 Bash 用例（Tab、宽字、硬换行），私有回执 SHA、原生完整 buffer 和 UTF-8 point=end 均匹配；实际副作用原样、一次提交、无包装泄漏 |
| owned 复制与历史 | 上述 3 例各在完整输入、8/16/32/100 列及提交后历史检查；完整复制值与同一真实流的无 resize Terminal 一致。Tab 先在相同列实际到达，再重排，未伪造不同到达列等价 |
| 软/硬换行、空白及 Unicode | 包含 Tab 跨多行、内部擦除的空 cell、空软尾行、真正输入的行末空格、宽字占位和部分选择、组合字/emoji |
| 浏览器选择行为 | 真实正向/反向拖选、正向/反向列选择、双击词/空白、三击逻辑行均通过；没有业务层选择覆盖 |
| 其余相关兼容性 | 复用真实长行 trim、保存光标、重复 resize、备用屏和 Vim 录制；补查备用屏软换行/Tab 缩窗，保留真实旧行宽及旧复制行为；全部原生行长、cell/cursor 状态保持一致 |

统计明确保留两类负对照：把普通编辑强行设成全局 true，以及不启用同流显示配对的 owned provider；它们不是当前候选配置。旧异步切换失败证据也保留，其相同边界条件已由不变的 15 例同流记录覆盖。真正的 owned 完整文本、参考流、Tab 空白和原生绑定检查没有降格。普通 Readline 的无换行源码等值诊断仍记录 12 次差异，但该诊断不是 T05/T08 原始目标，不计为新的产品缺陷。

初版复制补丁暴露过空软尾行额外空格，以及备用屏旧行宽被视口列数截断两类回归，已修正；`copy-browser-v1.log`、`copy-alternate-before-fix.log` 和对应补丁/bundle 归档保留。备用屏两项针对性检查在修复前共 16 个配置组合失败，最终仍纳入上述完整门禁，没有删掉用例。

本轮复用已通过的同流显示 **15/15、两种策略各 60/60** 及三种 Bash 的 **192 次提交**，没有重跑这些无变动矩阵。入口检查原生 C 源码/补丁及 module 哈希不变；它依赖报告中的冻结原型证据和 GNU 构建，缺失时不会跳过校验。生产 xterm 源码和终端锁定条目、P1 和并行 SFTP 继续保留；未提交、推送或发布。strict TypeScript 检查仍只出现原库相同的 6 个 vendor/包类型诊断，未冒称全量发布检查通过。

上述隔离阶段没有遗留已复现的适用场景失败。用户随后明确允许通用光标/复制规则及同流显示机制纳入正式实现，原仅隔离的采纳阻塞已解除。以下正式阶段不扩大为业务层投影、私有状态/公共 API 覆盖或新执行授权。

## 正式依赖采纳与 P0 收口（2026-10-31）

用户在协调会话明确选择“允许纳入正式实现，继续分阶段实施”，问题已说明复制修复影响默认配置历史输出，以及此前最终光标/选择改写的限制。这是新的正式授权，不是从隔离实验推定的同意。

本轮冻结于 `.native-input-p0/formal-adoption-baseline/`：HEAD `7b9ed07b5198ab9393a54880eada124252a5b4a5`；当前工作区二进制 diff SHA `554fd6df03431032cdd6c0df1100d5ee855efef63ec0f629ff978dc681faf803`，全部未跟踪源文件归档 SHA `203e1a50e14b28f1a1148b06a719980ba052b4bcb9338800be6c939275f4facd`。保留当前 package/lock/workspace 原文和未修复 xterm 原包，没有覆盖并行 SFTP。语义比对确认非 xterm lock graph、所有现有 dependency/devDependency 声明与本轮开始一致。

### 正式包与可重建性

- 仍精确使用 `@xterm/xterm: 6.0.0`，`pnpm-workspace.yaml` 正式登记 `patches/@xterm__xterm@6.0.0.patch`；pnpm patch hash / 文件 SHA-256 均为 `5aabb3510e24bc66ce0f30f510dbdcc534fce6de974287bab34d7d78d85df622`。原 sonner 补丁和 overrides 保留。
- 补丁由官方 `pnpm patch` / `patch-commit` 生成并安装，包含 3 个 TS 源文件及 UMD/ESM JS、对应 source map。没有手工编辑 node_modules/dist 或手写脆弱的 minified JS 文本补丁。通用源补丁逐字节保持批准的 `8ee402...`、`848172...`。
- 构建输入为 NPM 包记录的固定 Git commit `f447274f430fd22513f6adbf9862d19524471c04`，官方 archive SHA `82337f91a9df63998d89ba906389d5152a2e8278b558ea72c5dec25ec93a591e`；TypeScript 5.5.3、webpack 5.94.0、esbuild 0.25.2 走上游 project/build 配置。构建树位于独立临时目录，避免祖先项目类型污染。
- 上游锁缺少 esbuild 平台节点，采用单独 pnpm 完整性锁定的 npm 10.9.2 / 官方 esbuild 二进制，并通过支持的 `ESBUILD_BINARY_PATH` 构建；核对 JS bridge 与固定工具包相同，没有伪造上游 lock integrity。源/工具锁/二进制与 7 个生成文件摘要均在 `scripts/dependency-builds/xterm/artifacts.json`。
- 独立干净重建逐字节匹配正式安装包，见 `formal-reproduce.log`、`xterm-package-builds/2026-10-31T09-28-09.245Z/manifest.json`。维护方法及许可证说明见 [构建说明](../../scripts/dependency-builds/xterm/README.md)。NPM MIT LICENSE 保留；原型 GNU 许可/来源沿用前述说明，本阶段不分发原生 module。

| 正式安装运行产物 | SHA-256 |
| --- | --- |
| `lib/xterm.js` | `0f0dc87fd125337179b13eea3e3d5f6a9c6e9a7f7dddc99b3964a6c035b70b4f` |
| `lib/xterm.mjs` | `4758148eb6d781877c419e065e53c54dc1a5d943763a89a275986f3ebc1668a9` |

### 正式包门禁

候选直接从正式 `node_modules/@xterm/xterm` 加载；每个验证入口核对 pnpm patch hash 和安装的 source/runtime 摘要，不再次给候选套实验补丁。对照通过 `pnpm patch --ignore-existing` 提取原包后独立生成，不能和正式候选混淆。

| 检查 | 结果 / 证据（`.native-input-p0/` 下） |
| --- | --- |
| 复制、重排、选择/搜索、宽字、trim/保存光标、备用屏等适用组合 | **344/344**；`formal-copy.log`，实际正式 UMD 包 |
| 普通默认编辑直接原包对照 | **12/12**；`formal-ordinary-stock.log`；不推导全局复制行为不变 |
| 同流真实原型，逐段 / queued 逐字节 | 各 **60/60**；`formal-inband.log`、`formal-inband-queued.log`，使用正式显示模块及正式包 |
| 实际包内的 resize 分片边界 | **408/408**；`formal-boundaries.log` |
| 显示控制器真实浏览器 | **52 项 / 4 个 engine/renderer 组合**；拒绝 raw/legacy/重复接入、分片、EOF 迟到、释放、配置保持、无终端输入；`formal-display-fixture.log` |
| 全几何、短长/超视口、Unicode、复制/搜索及亮暗主题 | **8/8**；`formal-geometry.log`；正式 UMD |
| 旧终端源码展示、重绘、装饰 | 均退出 0；`formal-legacy-source.log`、`formal-legacy-redraw.log`、`formal-legacy-decorations.log`，真实旧 PTY 回放、生产 ESM；保留旧链路 |
| 控制器/registry/选择等就近回归 | **166/166**；`formal-terminal-unit.log` |
| 当前前端构建 | `pnpm build` 退出 0；`formal-frontend-build.log`，保留既有 chunk/dynamic-import 提示 |
| 完整前端测试 | **2893 通过 / 3 失败 / 6 跳过**；2 个 AI 展示文件的 3 条断言在 HEAD 源码 + 同依赖但**移除 xterm 补丁**的隔离基线仍失败，见 `formal-ai-baseline-focused.log`。未修改无关 AI/SFTP 来过检查，**不宣称整个工作区 Quality Gate 通过** |

完整正式门禁汇总为 `formal-runs/2026-10-31T09-51-15.140Z/result.json`（full PASS）。新入口又验证了未指定旧 capture 的真实重新采集链：`formal-fresh-copy-chain.log`（copy PASS），以及显式 manifest/参数回放：`formal-repro-entry.log`。`pnpm test:terminal-native-display` 默认读取仓库就近真实 PTY 片段 fixture；独立临时项目从冻结依赖安装后，在没有旧捕获目录时通过 52 项检查，见 `formal-clean-controller.log`。冻结回放和重采集严格区分，缺失/摘要不符不会 skip。fixture 可由 `export-native-display-fixture.mjs --captures <successful capture>` 重新导出，不伪造生命周期回执。

### 冻结目标、模块与下一阶段

完整 P0 通过仅覆盖批准前最新报告已验证的组合：**macOS arm64 + 固定 GNU Bash 5.3 / 静态 Readline 8.3.6 + 默认 emacs/INT + 受控 HOME/locale/提示符 + 正式 patched xterm 6.0.0**。45 个原生语义/恢复用例、192 次提交（4.1/4.4/5.3 各 64）在原生源码及 module 不变时复用；后两种版本的低层证据不等于新显示扩展已验收。原生产 legacy 支持不减少，不外推 Windows、Linux/SSH 新显示扩展、其他架构或用户插件。

可接入实现 `src/lib/terminal/native-input-display.ts` 只在显式 native binding 下安装，使用公共 parser/option；当前 production registry 无调用。它没有源码/lease 元数据或生命周期、ready、执行回调；stdout 同文最多改不可信显示。原生唯一草稿、父 Shell 顶层提交、隐藏包装保护、取消/接管/EOF/HUP 和无重放保持。显示清理与真实输入授权不混用，细节见 [接入边界](../../protocol/native-input-display.md)。

线上标识和能力协商留给 P1；新命令生产写入、原型分发和生产 EOF/重绑接入留给后续阶段。**P0 限定范围通过，可以继续原 P1；P1 整体未完成，P2–P4 未实施。**P1 只读观察与并行 SFTP 均保留，未提交/推送/tag/发布，未对业务主机执行副作用验收。
