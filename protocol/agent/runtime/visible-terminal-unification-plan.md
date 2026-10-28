# 可视终端统一实施计划

2026-10-26 Bash 后台退出期间的终端属性 EINTR 已修复：固定字节读取移入同一前台进程组内、不创建子进程的同步读取子 Shell，隔离父 Shell 后台退出的 SIGCHLD；帧格式、截止时间、完整回执和取消/恢复门禁保留。Bash 4.1.0、4.4.0、5.3 的 180/32 列完整用例及丢失/迟到回执九组真实 PTY 全部通过，六组完整用例累计新增 144 轮“自然退出＋停止”，并验证截断帧超时后下一条用户命令正常，原只读 LC_ALL 修复继续通过。首组 4.1 宽窗口与全量 Rust 并发运行通过。最终全量 Rust 按 4 线程为 1188 passed / 59 ignored，协议/验证入口 26 项通过；此前直接 printf 的独立 PTY 冒烟失败及单项复核记录均保留。Windows ConPTY、Linux 桌面、SSH、模型/UI E2E 和前端构建继续绑定各自冻结范围。源码仍位于主检出，未提交、推送或发布。完整范围、证据与历史文件副作用见[Bash/PowerShell 回显复查](./bash-powershell-native-display-review.md)。Zsh 最终迁回及窗口演示以[Zsh 复查报告](./zsh-native-job-display-review.md)中的协调记录为准；下列旧阶段段落保留各自冻结时点的状态。

2026-10-26 原窗口双显增量复查：初次 13 文件已由协调会话迁回并演示，随后发现接受前无条件 `zle -I` 让首个后台及无后台多行前台源码显示两份。隔离 worktree 已改为只对本次编辑开始时确有其他活跃/暂停受控原生作业的情况保留保护性重绘；两种普通源码的最终单元格次数均为 1，P9k 宽窄窗口仍保住 BG4/BG7 与着色，增量全量 Rust 1186 passed / 59 ignored。已有作业时的原生重绘仍可能留下片段副本，不代表重复执行；独立原生 `zle -I` 基线也为源码 2 份、BG4 完整，默认 Enter 为源码 1 份但丢 BG4。此增量尚未由本会话迁回或操作原窗口，详细增量清单和边界见下方复查报告；不外推 Windows 或其他平台。

2026-10-26 后续 Zsh 显示修复已完成本轮冻结原生复验：短 `job-*` 标记与原始脚本、私有 poll/stop、有界 ZLE 完整 BUFFER 接收均保留现有着色；每秒输出与长/短前台输入重叠的 BG4/BG7 在真实 32 列单元格中完整保留。最终 Rust 1186 passed / 59 ignored，真实用户 Powerlevel 宽窄窗口各自通过；源码独立 native parser 校验、迟到 M、取消/接管及恢复门禁均有回归。候选仍只在隔离 worktree，未迁回主检出或重启原窗口，待协调独审与原窗口演示；Windows、SSH、Linux、其他架构及完整模型/UI 的既定独立边界不因这些结果改变。以下旧阶段轮次不外推到本候选；当前实现、冻结文件及精确证据见[Zsh 显示候选复查](./zsh-native-job-display-review.md)。

更新：2026-10-25。阶段按独立范围交接；本计划不替代已有历史验收记录，当前路由以本文及更新后的 terminal-protocol-rfc.md 为准。当前工作保留在原checkout，未提交。

2026-10-24 Windows 续验更新：先前延期的 PowerShell 5.1/7 现已在 Windows 真机执行。当前后台实现为受控 console worker / Windows Job Object，替代下文历史 ThreadJob/Job2 候选；受控实机通过后，当前实现进入正常默认启用与显式回退的最终验证。完整源码、前台取消、原始流、状态迁移与后代清理的精确结果见[Windows 原生终端报告](./windows-native-terminal-acceptance.md)及阶段四报告。下文延期、默认关闭及早期门禁属于其当时版本，不覆盖随后源码；阶段四最终门禁未完成前不宣布整个Goal收口。

Windows 阶段四桌面、模型及失败记录见[独立桌面续验报告](./windows-desktop-terminal-acceptance.md)。截至2026-10-25，5.1/7的宽窗口/窄容器模型、原生源码显示、持续输出及停止，以及重连和双Agent争用已有逐轮通过证据。当前完整正常原生门禁与全量前端在两个独立冻结轮次通过，生产代码/测试/配置字节一致；保持Windows独立验收边界，不把旧组合失败改判或外推其他平台。下文2026-10-23的“源码一致”“未发现阻断缺陷”仍只适用于当时版本。

本地最新前端2611 passed / 6 skipped；先前独立Rust1182 passed / 57 ignored绑定其原冻结源码，后续模型工具描述的5项Rust契约回归通过。真实macOS Bash/Zsh和隔离SSH Bash/Zsh分别完成模型到原生终端、源码单元、后台观察及停止；显式Direct、本地/SSH重连和双Agent争用另有独立通过轮次。早期默认历史增量和只读SQLite共享内存差异均保留，未恢复或清空用户文件。Linux原生桌面、其他架构、既存独立HTTP/SSH门禁仍未验收。

## 第四阶段最终复查交接（2026-10-25）

交接后完整目录集合复查发现两份本任务文件未进入旧Windows1316项清单：`scripts/__tests__/llm-route-document-schema.test.mjs`和`src-tauri/examples/analyze_native_output_trace.rs`。旧Windows结果不证明它们，原单向比较的全树结论撤回。两份已同步并完成Windows schema专项2项、诊断example实际构建及全量前端2611 passed/6 skipped；当前1318项冻结清单及292个测试输入前后一致。完整目录双向比对新增/缺失/差异均空对应补验冻结时点（仅明确排除Finder/AppleDouble元数据）；验证后仅四份交接文档更新，当前新增/缺失及代码、测试、配置差异均空，不能表述为当前全树零差异；已证明不受影响的原生生产代码、模型和性能保持原记录，不重跑或混报。

本次已验证范围未发现剩余阻断回归。阶段四当前实现及材料完成复查，以下平台缺项继续显式保留，不宣布完整跨平台矩阵完成。HEAD仍为`b3cd168cb505ac233ba606ba75137c9e412f1fca`，索引为空；不创建commit/tag，不推送或发布，不运行版本准备。

### 改动文件与契约

| 范围 | 当前相关文件 | 最终行为 |
| --- | --- | --- |
| 原生提交与恢复 | `src-tauri/src/terminal_integration.rs`、`terminal_console_signals.cs`、`agent_runtime/native/terminal_execute.rs`及就近回归 | 原生编辑器提交完整批准源码；UTF-8分批/完整BUFFER ACK，source可能入队状态单调记录。取消/接管/未知P保持恢复门禁，旧generation及迟到帧不重放；合法无源码probe独立处理。 |
| Windows后台任务 | `src-tauri/src/terminal_jobs.ps1`、`terminal_job_host.cs`、`terminal_jobs.rs`、`tests/terminal_integration_windows.rs` | 受控console worker/Job Object，支持状态验证及实时同流输出。公开Members.Match降低捕获开销，保留原类型/扩展成员/未知值拒绝和三秒上限；六类真实扩展成员以具体原因、零访问计数和无源码效果验证。 |
| 原生显示与重连 | `src-tauri/src/models.rs`、`commands.rs`、`src/types/index.ts`、`src/stores/terminalStore.ts`、terminal registry/layer及`src/hooks/useReconnectSession.ts` | 后端真实ConPTY/build元数据驱动xterm；仅本地Windows使用，SSH不继承，旧/重连元数据正确清理，不持久化。PSReadLine着色/预测保留，不添加或回放输出，不保留agent-command-echo补显。 |
| 焦点与历史恢复 | `src/components/terminal/hooks/use-active-controller.ts`及测试、`src/lib/ai/agent-session-adapter.ts`及真实重连/争用夹具 | 延迟自动聚焦尊重较新的外部编辑意图；已结束会话不被迟到只读刷新复活。验证显式重试、同PTY互斥、接管、运行中关闭及原草稿/历史恢复。 |
| 隔离与模型契约 | `src-tauri/src/path_utils.rs`、`tests/windows_shell_history.rs`、相关PTY测试入口、`agent_runtime/model_tools.rs` | 绝对独立数据目录及首次ReadLine前真实私有历史路径；原默认历史单独审计。工具描述同步支持Windows默认开启、真实nativeJobControl与新Shell显式0回退，保留审批、directRequired、无隐式Direct和非sandbox边界，单次background默认仍false。 |
| 验收工具与材料 | `scripts/verify-terminal-broker-windows.mjs`、`verify-ai-session-stream.mjs`、`scripts/fixtures/`、原生HTML/TSX夹具及本目录报告/矩阵/兼容性表 | 真实模型/IPC/PTY与原生窗口证据；实际测试发现清单完整覆盖冻结输入。静态公共诊断插入前后核对AST，完整正常门禁关闭诊断。发布测试只优化自有真实Git夹具，无mock、无扩大期限或修改发布产品逻辑。 |

`direct`/`boundTerminal`选择绑定，不因effect、能力不足或输入形式自动切换；native `job-*`与Direct `proc-*`生命周期分开。审批、租约、generation/owner、取消、超时、恢复不确定性和旧event-v5历史读取边界保留。数据接收2秒、状态捕获3秒及执行前readiness5秒未扩大；只有原生测试的首次冷启动窗口统一为既有30秒预算，旧5秒失败仍保留。

### 实际命令与证据

| 命令/场景 | 实际结果及绑定 |
| --- | --- |
| 本地`pnpm test` | 夹具优化后2611 passed / 6 skipped，76.05s；源码/测试修改后已有全量结果。 |
| Windows原`pnpm test`、`pnpm build`及includes/styles/catalog | 当前完整集合`windows-frontend-complete-tree-20261025`：2611 passed / 6 skipped，610.78s，schema专项2项及诊断example实际构建通过；全部required steps exit0，保持原15000ms和4workers。旧1316项轮次仍只证明其原范围。 |
| `node scripts/verify-terminal-broker-windows.mjs` | 独立`windows-native-complete-normal-20261025`正常路径完整通过：fmt/check、Windows完整Rust1140 passed / 58 ignored、5.1/7 raw/前台/长job/严格拒绝/真实editor中断/交互/Direct及两轮原性能阈值；diagnostic=false。 |
| 模型工具Rust契约与协议/runner/schema回归 | 更新描述后5项Rust通过，26项JS契约通过；相关fmt/includes/diff检查通过。 |
| Windows真实模型与显示 | 默认开启四组合、当前重连/双Agent争用按各自冻结证据；最终描述的`current-7-tool-contract-second`为真实M3/PS7，7native+5Direct、21source cells/BUFFER、14租约、提前显示→更高revision仍active→真实stop、Focus草稿及实际窗口着色通过。 |
| macOS/隔离SSH | 实际本地Bash5.3/Zsh5.9、隔离SSH Bash5.2.37/Zsh5.9模型链路；本地Direct精确stdin/stdout、真实本地/SSH重连、双Agent争用和逐PID历史隔离分别通过。精确轮次见已有验收段，失败混合批次不整体改判。 |

Windows原生归档SHA `7e5983a073cfba0b0b4cd8332a0e5f436f41150dc48e576b49ab6d22ea86ee4e`，当前完整集合前端归档SHA `8f36f508e4c6e92ca44ee9fd54fdbdf293aee2ec13411b7e59cbfb6118814296`，最终描述模型归档SHA `cf9996c48a5dcc9e099e944798ffbe3d5ada4e2d0cae752e461333b87291f538`；均保存在独立Windows报告列出的自有证据目录。原生1316项与新前端1318项各自源/原数据历史审计通过；新增两份测试/离线example不进入终端生产路径，补验覆盖且双向集合无遗漏。模型的生产代码保持相同；App二进制按各构建阶段记录，不跨阶段声称同SHA。

### 未验项及资源边界

- Linux原生桌面、其他架构和既存独立HTTP/SSH门禁未验收；隔离Linux SSH不等于Linux桌面。
- Windows已验证真实Shell exit/Enter重连，未证明Windows idle-timeout；P9k无换行对照只覆盖真实主题140×24及语法预检接受控件，不是所有半行情形保证。
- 六项前端跳过、Rust忽略项及未运行的外部路径不作为通过；旧失败、历史增量、只读SQLite SHM差异均保留，不重写原件。
- Windows自有task/CLI树按UUID和owner清理，误构造诊断仅终止确证自有树；早期两个自有POSIX孤儿Shell及测试Docker项目已精确清理，未知进程和用户数据保留。未确认逐目录归属的临时夹具不猜删，默认历史不恢复、不清空。

最后仅更新本交接和报告的当前摘要；Windows独立报告保留完整因果与冻结版本，最终验收不等于提交或发布授权。

## 四阶段顺序

| 阶段 | 实施范围 | 进入下一阶段的条件 |
| --- | --- | --- |
| 一：规则与普通命令 | 固定 direct/boundTerminal 契约；普通单行命令经当前真实 PTY/SSH Shell；审批 effect 与路由分离；不支持输入在写入前拒绝；保留真实输出与恢复边界 | 本地/远端路由回归、真实 PTY/SSH、取消/超时/接管/输入恢复/断线不重放，以及相关构建测试完成并记录平台限制 |
| 二：原生多行提交 | 以 Shell 原生提交机制支持 LF/CR/Tab、完整脚本和 heredoc；保持当前 Shell 的 cwd/env/alias；不使用独立进程替代 | 每个实际支持的 Shell 验证脚本边界、Tab 不触发补全、多行编辑、取消恢复、原始输出；无法安全提交时执行前拒绝 |
| 三：当前 Shell 后台任务 | 当前 Shell 原生后台任务及其作业标识、输出、观察、停止与清理；不要把 direct 的 proc-* 冒充 Shell 作业 | 作业归属、取消、超时、重连、接管、输出交错及清理均有真实验证；保留独立进程生命周期的明确边界 |
| 四：移除补显并跨平台验收 | 定向替代移除 agent-command-echo 展示补丁；完成桌面 UI、模型到真实终端、本地/SSH、Windows/macOS/Linux 支持矩阵验收 | 全部目标平台有真实证据；未运行组合明确保留未验证；最后审查协议、历史兼容、审批、输出及发布门禁 |

未经用户另行授权，不创建 commit/tag、不推送、不发布；阶段二聊天只实施本阶段并交接，不启动阶段三。

## 阶段一契约

`direct` 继续使用独立本地进程或 SSH exec，保留结构化 stdout/stderr、proc-*、stdin/wait/kill 及已有权限和超时语义。

`boundTerminal` 是绑定用户当前真实终端的选择，普通单行命令只能归一化到 `terminal_execute`，不可因 effect、Shell 不可用、功能标志或输入形式自动切换 `exec_command`。原始输出经同一 broker 流进入终端显示与工具 capture；cwd/env/alias 由当前 Shell 继承，不注入冻结目录或另起包装 Shell。模型误调用原生 `exec_command` 也不能越过该选择。原生 IPC、command 注册、持久化 enum 和 event-v5 无新增字段，沿用现有类型；适配层现在完整传递 `timeoutMs`。

`sensitiveRead`、`stateChange`、`destructive`、`externalSideEffect` 的分类继续影响确认策略及原生拒绝规则。两种执行面均不提供文件系统或网络沙箱。`lifecycleTrust=directRequired` 在 boundTerminal 返回 `TERMINAL_DIRECT_REQUIRED`，提示用户显式切换 direct；审批完成不能使合作式 Shell 钩子变成可信进程生命周期证据。

多行/CR/Tab 返回 `TERMINAL_INPUT_UNSUPPORTED`；`background=true` 返回 `TERMINAL_BACKGROUND_UNSUPPORTED`。在阶段三前，tree-sitter-bash 语法树中的 `&` 运算符也在原生参数及输入边界拒绝，包括嵌套和 zsh 的 `&!`/`&|`。引号内字面量、转义字面量、`&&` 和 fd 重定向不应误拒绝。

该语法门禁是保守支持范围，**不是全 Shell 后台分类器**：PowerShell 的前缀调用运算符 `&` 也会被拒绝，错误明确说明此限制；本机无 pwsh，未进行 Windows 验收。别名、函数或可执行程序内部启动子任务不能由静态语法识别；这不是沙箱保证，生命周期不能可靠完成时保留 uncertain，不自动重放。后续阶段应以实际 Shell 的成熟语法能力补齐，不通过字符串拆分猜测。

取消、超时和接管沿用租约、限定中断与合作式结束确认；缺少可信操作完成则 uncertain。输入尚未提交时保留恢复门禁。断线与旧 generation 不重放命令，不建立第二个 SSH 终端，不降级成独立 exec。

## 阶段一支持与阻止矩阵

| 请求 | direct | boundTerminal |
| --- | --- | --- |
| 普通单行，包括敏感 effect | 原有独立执行及审批 | 当前真实 Shell；相同 effect 审批策略 |
| LF/CR/Tab、heredoc | 原有脚本执行 | 执行前拒绝；阶段二补齐 |
| background=true | proc-* 及原有管理工具 | 执行前拒绝；阶段三补齐 |
| 显式 directRequired | 独立生命周期 | 执行前拒绝，要求显式切换 |
| `&` 语法门禁命中 | 原有 Shell 解释 | 执行前拒绝，含 PowerShell 前缀调用限制 |
| 绑定终端断线或 integration 不可用 | 不影响原有 direct 条件 | 明确不可用，不路由或重放 |

## 阶段一交接与验证

实现文件：`native_adapter.rs`、`native/call_policy.rs`、`native/effect.rs`、`native/shell_policy.rs`、`native_contract/policy.rs`、`model_tools.rs`、`prompt.rs`；回归文件：`tests/native_adapter/core.rs`、`tests/terminal_integration.rs`、`scripts/__tests__/terminal-protocol-contract.test.mjs`；同步 RFC、兼容表和文件/脚本协议。

开始时已有的 `terminal-controller-layer.tsx`、双语文案、`agent-command-echo.ts`、对应测试与验证脚本均保留；兼容文档中的补显说明仅改为历史操作适用，不移除此补丁。阶段四再定向处理。

本阶段运行平台为 macOS arm64；远端门禁使用隔离 Docker Linux SSH Bash/Zsh，不连接生产服务器。Windows/PowerShell、Linux 桌面及其他架构均不得据此标为通过。

| 检查 | 本次结果 |
| --- | --- |
| `pnpm test` | 2603 passed、6 skipped；291 个测试文件通过、1 skipped |
| `pnpm build` | TypeScript 与 Vite 构建通过；保留已有 chunk 大小及混合静态/动态 import 警告 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 1158 passed、53 ignored，无失败；包含新增路由、审批与语法回归及真实 macOS Bash/Zsh PTY 验证 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `pnpm check:rust:includes` | 54 个 include 文件通过；保留原文件的上下文缩进，未整文件格式化 |
| `git diff --check` | 通过 |
| `node scripts/verify-terminal-remote-ssh.mjs` | 两次运行均为 11 项通过、最后 1 项 HTTP 探测失败，**完整 SSH 门禁未通过**；容器已由脚本清理 |

真实 macOS `/bin/bash` 与 `/bin/zsh` 的 `macos_native_*_visible_commands_preserve_shell_state_and_raw_display` 验证当前 Shell 的 cwd、env、alias、函数和选项继承、原始 ANSI、退出码、长输出截断与完整显示、取消/超时/接管，以及逐步输入期间取消、提交前暂停取消、接管、integration 丢失和后续用户输入恢复。新增真实 streaming 断言在 `sleep 2` 结束前观察 ANSI 输出，再确认工具 capture 包含相同字节。新增后台语法拒绝断言要求无终端写入、无租约、无阶段事件。路由测试仅验证归一化规则，不将其作为真实执行证据。

真实 SSH 通过项包括登录目录和启动脚本、普通 Bash/Zsh integration、控制面失效清理、`remote_bound_terminal_bash_reuses_source_shell_acceptance`、Zsh smoke、不支持 Shell 无第二 transport、无 SFTP 降级为普通用户 Shell、资源清理及 Direct SSH/SFTP 执行。Bash 复用验收直接检查同一 Shell 的状态和原始输出、取消/超时/接管、断线 uncertain、generation 递增、旧流拒绝及副作用文件只写一次，证明断线不重放。

完整 SSH 脚本的失败项为 `agent_runtime::native::http_probe::tests::isolated_ssh_probe_reaches_only_the_remote_loopback_service`，位于 `native/http_probe.rs:671`，错误为 `Target loopback HTTP request exceeded its total deadline; target loopback SSH transport exceeded its total deadline`，两次约 10 秒超时。后续隔离基线对照确认这是现存 scoped SSH 转发的阻塞模式问题，具体证据见下节；当前工作树没有修复该独立缺陷，不能宣称整个 SSH 门禁通过。运行记录：`/tmp/shellspan-stage1-ssh-final.log`、`/tmp/shellspan-stage1-rust-final.log`、`/tmp/shellspan-stage1-frontend-final.log`。阶段一代码与针对终端的验证已完成，完整 SSH 门禁仍有此缺口，是否进入阶段二由协调侧评审；本聊天不启动下一阶段。

### 协调审核补充：协议一致性与 HTTP 基线对照

已定向移除 RFC 合作式威胁模型下仍生效的 effect→Direct 强制路由条款，同步 roadmap、当前 test matrix 和远端复用方案中的同类规则。统一为 effect 只控制审批/native deny；显式要求独立进程生命周期的请求在 boundTerminal 写入前拒绝，要求用户显式切换 direct。合作式威胁模型和历史 acceptance 文档中的既往事实保留。协议回归增加当前规范断言并禁止旧路由措辞，`pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs` 最终 12 项通过。

HTTP 调查未盲目重跑完整门禁，而是在同一个隔离 Docker fixture 中逐层验证：

1. `docker compose -f tests/ssh-e2e/compose.yml exec -T ssh python3 -c ...urllib.request.urlopen("http://127.0.0.1:18081/", timeout=3)...` 实际返回 HTTP 200 和 Directory listing，证明 fixture HTTP 服务可用。
2. 使用 OpenSSH `ssh -W 127.0.0.1:18081` 的 direct-tcpip 通道发送完整 GET，实际返回 HTTP/1.0 200、Content-Length 和完整正文，证明同账号、同端口的 SSH 通道与服务端转发权限可用。只使用隔离 fixture 的测试账号和独立 known_hosts 文件。
3. `git archive HEAD` 导出原基线 `8627c0c5ee1fd04b9e7020086caa701837e3a17d` 到 `/tmp/shellspan-stage1-baseline.5bqy2L`，共享当前 Cargo 依赖/target，但不修改当前工作树。对未修改的基线运行上述单项 ignored/exact 测试，10.03 秒后得到与当前实现完全一致的双重超时。记录：`/tmp/shellspan-stage1-http-baseline.log`。
4. 因果实验只在临时基线副本的 `port_forward.rs` 中，在成功创建 direct-tcpip channel 后、建立内部 loopback pair 前增加 `session.target.set_blocking(false)`。同一测试不改断言、不改 timeout、不改 HTTP 实现，0.15 秒通过。记录：`/tmp/shellspan-stage1-http-diagnostic.log`。该实验不是当前代码修复，也不是完整门禁通过证据。
5. 实验后删除临时副本中的这一行，恢复原基线再执行同一测试，再次以同一双重超时失败（10.03 秒），形成“原基线失败→仅非阻塞设置通过→恢复基线失败”的对照。记录：`/tmp/shellspan-stage1-http-baseline-restored.log`。HEAD、当前工作树及恢复后的临时副本 `port_forward.rs` 的 SHA-256 均为 `59342e08a41573cbc4851007733825fd0ad13a281d0e22936cd01d015b190b66`。

因果解释：现有 `open_scoped_loopback_connection` 将阻塞 SSH session 的同一 channel 交给 `bridge_single_connection`，两个线程分别用 channel 与 stream 并发下载/上传。所用 ssh2 依赖 `Session` 文档明确说明相关对象共享 Mutex，阻塞 read 会阻止同 session 上的其他调用。服务端等待 HTTP 请求时，下载侧阻塞 read 可持锁，使上传侧无法写出请求；转为 nonblocking 后现有 WouldBlock 分支可让出锁，单项测试即通过。该缺陷位于基线已存在的 scoped SSH transport，独立于本阶段的 effect 路由修改。

当前 `src-tauri/src/port_forward.rs`、`native/http_probe.rs` 及 `tests/ssh-e2e` 与 HEAD 完全一致。后续独立修复需评审 nonblocking 桥接、取消、超时、EOF/半关闭和资源回收，再运行完整 SSH 门禁；不能仅凭此诊断的一项通过就关闭最终验收缺口。

未验证：Windows/PowerShell（本机无 pwsh）、Linux 原生桌面、其他架构、真实模型经桌面 UI 的完整调用及视觉显示验收；本次证明的是生产 broker/PTY/SSH 与适配层规则，桌面跨平台端到端验收仍属于阶段四。PowerShell 前缀 `&` 的限制需要在对应 Shell 的成熟解析能力可用后处理。

阶段二前置：读取本计划及当前 git status，保留上述展示补丁及全部无关改动；遵守 boundTerminal 不隐式 direct、审批不降级、uncertain 不重放和当前 Shell 状态继承约束。多行支持必须先设计原生提交与取消恢复，再解除现有拒绝，不能直接删除控制字符校验或把多行粘贴等同于原生安全提交。

## 阶段二：当前生效设计与支持矩阵

本节取代上文阶段一的多行/Tab拒绝及 PowerShell 前缀 `&` 限制。普通命令仍不隐式 direct，审批 effect/native deny、租约、冻结 target、generation fencing 和不重放约束不变。后台任务管理仍属于阶段三。

| Shell/组合 | 当前原生提交 | 本阶段证据与限制 |
| --- | --- | --- |
| macOS Bash 5.3 / Readline | 完整源码以成熟 `shlex` 库编码成一个参数，保留物理换行；实际可见提交包含整段源码和固定原生结构，语法检查后在当前 Shell 顶层 `builtin eval` | 本机原生编译 `/tmp/shellspan-stage2-bash/bin/bash`；真实 PTY 验证。没有替换系统 `/bin/bash` |
| 隔离 Linux SSH Bash 5.2.37 / aarch64 Alpine | 同上；不建立第二 PTY、不走独立 exec | 隔离 Docker 的真实 SSH/PTY；成功、取消及重连不重放验证 |
| Bash 4+ 其他版本 | 通过 Readline 能力探测后开放同一机制 | 实际验收为macOS 5.3与SSH 5.2.37；其他版本未单独运行，不据此宣称逐版本验收 |
| macOS `/bin/bash` 3.2.57 | 普通单行保留；LF/CR/Tab脚本输入前明确拒绝 | 缺少 `bind -x` 完整缓冲区捕获，不能可靠证明实际 accepted line；真实测试断言无租约、无写入 |
| macOS Zsh 5.9 / ZLE | 原生 quoted-insert 填充完整缓冲区；固定匹配当前 Shell 的绝对路径做只读解析；一次 accept-line | 真实 PTY；包含 Bash grammar 不支持的 Zsh `for item (one two)`，没有要求合法 Zsh 先通过 Bash 全语法检查 |
| 隔离 Linux SSH Zsh 5.9 / aarch64 Alpine | 同上 | 真实 SSH/PTY；登录用户 Shell 绝对路径来自已有后端身份；PATH改变不会替换解析器 |
| Windows PowerShell 5.1 / PowerShell 7 | PSReadLine Insert + Parser.ParseInput AST；prefix `&` 与 Background pipeline 分开判断 | 实现和 Windows ConPTY用例已补充；**原生验收延期**，用户安排后续到Windows运行，本机未运行、不宣称通过 |
| 已有自定义 Bash INT trap | 保留普通命令及用户 trap；复杂输入前拒绝 | 中断不能证明整体停止时通过控制面保留 uncertain，不把正常结束当作可靠取消 |
| Readline/ZLE未开启、没有原生能力广告、当前Shell路径不能固定、集成失联 | 复杂输入前明确拒绝 | 无 silent direct；部分输入失联继续受输入恢复门禁限制 |
| Zsh `INTERACTIVE_COMMENTS` 关闭且多行源码包含注释节点 | 输入前明确拒绝，不修改用户选项 | 非交互 `-n` 与默认ZLE的注释语义不同；成熟AST识别注释节点。真实验证覆盖完整/非法/未闭合含#源码无写入、无副作用；显式开启原生选项后，同一8192字节密集引号源码成功 |

### 提交、审批与真实命令行

`commandLine` 是审批冻结的完整原始源码，8192 UTF-8字节上限不变。Bash 的 `submittedCommandLine` 另行记录实际 accepted line，使用固定结构：

```bash
(exit "$?"); builtin eval -- Q
```

`Q` 由现有成熟 `shlex::try_quote` 将原始源码编码成一个 Shell 参数，解码后逐字节一致；物理换行保留，没有将脚本拼成单行，也不按行分别提交。该结构完整包含源码，真实Readline回显会显示它；没有把源码换成不可查看的内部变量 stub。原始源码的审批、参数记录与 effect 判断继续生效，固定结构只提供校验和当前Shell顶层求值，不增加模型控制的其他语句。后端在任何输入前独立重算并核对该结构，注册原始源码和实际 accepted line；Shell的S事件必须逐字匹配实际 accepted line，不以原始源码冒充实际提交值。工具结果保留两者。Zsh/PowerShell没有该结构，S事件仍匹配原始完整缓冲区。

原生 eval 在当前交互Shell顶层运行，保持 cwd、env、已有 alias/function 和选项；不在验证函数作用域内执行源码，不使用子Shell或临时脚本。Bash交互多行缓冲在Ctrl-C后可能继续后面的物理行；这里的原生 eval 提供单一可中断求值单元。`$?` 在求值前恢复，后续命令可继续使用脚本产生的状态。`LINENO`、`BASH_SOURCE`、诊断和Shell历史反映原生eval/可见提交结构，不承诺与逐条交互提交的行号/调用上下文相同。`return`、`exit`、`set`遵循实际Shell顶层脚本语义；会退出Shell或自行改变中断处理的脚本仍受合作式生命周期边界约束。

Bash Agent 的普通短命令也使用同一引用封装，使 `!important` 等字面量不经过 Readline 的历史展开，避免在命令开始前报错并跳过生命周期回调。短命令继续使用普通输入路径，包括 Bash 3.2；完整脚本接收器、后台作业和已有能力门禁保持各自约束。封装由后端独立重算并逐字核对；原始源码、实际提交行与退出状态分别记录，不修改用户的 `histexpand` 选项或手动输入行为。

ZLE按原生完整缓冲区解析后执行，所以在同一缓冲区新定义再调用的alias会按Zsh自身语义返回127；alias状态仍保留，并在下一缓冲区调用成功。Bash源码按当前Shell原生eval语义处理；本阶段没有把这些Shell语言差异改写成统一的虚构行为。

### 原生编辑与输入恢复

LF/Tab/CR编码为专属 Ctrl-X加普通字符的原生编辑操作；Readline/ZLE使用自己的 quoted-insert，PSReadLine使用自己的 Insert。最后的专属提交键只发送一次。没有使用XON/XOFF键，也不依赖 bracketed-paste 开关。完整缓冲入队和最终提交之间保留150ms取消边界，reduced motion也不跳过此边界；全程与取消/接管共享同一操作锁，并保留提交前的上下文、控制面、能力和所有权重校验。

未提交时取消/接管先限定中断整个编辑缓冲区、退役未提交操作，不再发送提交键；只有受信任prompt或新generation才能解除 `TERMINAL_INPUT_RECOVERY_REQUIRED`。失联、generation变化和不确定执行均不重放。运行中取消与超时必须证明尾部副作用没有执行。Bash集成为提示符安装的INT反馈处理器只用于输入期；已提交前台命令恢复用户的原始默认INT处理，普通单行复合命令也覆盖此修复，不覆盖用户自定义trap。

Rust边界仍只接受LF/CR/Tab三种控制字符，并检查源码、实际引用后的提交结构及编码后的编辑输入长度。生成结构最多32768字节，编辑输入最多65536字节；任何超限都在租约/PTY写入前拒绝，不截断。控制解码字段上限32768字节、总缓冲131072字节，并同步结果JSON schema。真实8192字节边界包含密集引号及多字节文本，超过源码字节上限的请求断言无写入。

CR保持原始字节，CRLF也不会自动转LF。POSIX脚本需要LF换行；引号内CR/CRLF字面量有真实验证。裸CR按原生Shell语言解释，可能成为参数的一部分或造成解析错误，不能当作通用换行承诺。

### 语法与控制协议

Shell的原生只读解析器是对应语言的语法判断来源，不用Bash全语法限制Zsh。Bash传递extglob/extquote/interactive_comments与POSIX解析选项；Zsh传递当前解析选项，禁用子解析器的启动文件、交互、作业控制等执行状态。子解析器只做no-exec校验，不执行源码。任意原生诊断都会拒绝，不匹配易变的英文warning。

原生 `-n` 对未闭合heredoc不一定报错，因此另以成熟tree-sitter的 `heredoc_start` / 非missing `heredoc_end` 结构证明结束；不能证明的heredoc输入前拒绝。该检查只处理heredoc，不把无关Zsh语法的ERROR当作非法脚本。包含前置写文件的未闭合引号/if/heredoc验证必须无前置副作用，且用户下一次Enter不能执行残留。Bash/Zsh的后台运算符和原生coproc仍拒绝；这不是全语言沙箱或对子程序行为的静态保证。

内部隔离控制流新增I（prompt-start/end之间的能力广告）、C（Zsh原生INTERACTIVE_COMMENTS状态）、J（原始源码、固定拒绝原因）和U（Bash自定义INT处理带来的中断不确定性）；同样受integration/generation身份、顺序、字节边界及exact-line校验约束。公共capability增加 `nativeScriptInput`，Rust/TS/JSON schema同步。J产生failed工具结果，记录 `inputRejection`、原始源码及实际提交结构，不伪造已执行源码的退出码；仍等可信prompt清理门禁。无新增Tauri command，无event-v5版本或持久化surface枚举变化。

### 阶段二验证与交接

实现文件：`terminal_integration.rs`、`terminal_broker.rs`、`session.rs`、`native/terminal_execute.rs`、`native/shell_policy.rs`、`native_adapter.rs`、`native_contract/policy.rs`、`native/runtime.rs`、`model_tools.rs`；类型/协议：`src/types/index.ts`、tool-contract与terminal-protocol-v1 JSON schema、当前RFC/兼容说明；回归位于就近Rust测试及 `scripts/__tests__/terminal-protocol-contract.test.mjs`。`scripts/verify-native-script-display.mjs`只重放真实PTY记录到xterm，不合成补显、不执行源码、不替代桌面/模型端到端验收。

| 本阶段检查 | 实际结果 |
| --- | --- |
| `pnpm test` | exit 0；2604 passed、6 skipped；291个测试文件通过、1 skipped。记录 `/tmp/shellspan-stage2-frontend-final.log` |
| `pnpm build` | exit 0；TypeScript/Vite通过，保留已有chunk/import及构建时间警告。记录 `/tmp/shellspan-stage2-build-final.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | **唯一最终运行** exit 0；1165 passed、0 failed、55 ignored，48.74秒。执行handle `75194` 已确认完成；日志 `/tmp/shellspan-stage2-rust-verified.log` 仅此一次运行 |
| `SHELLSPAN_TEST_MODERN_BASH=/tmp/shellspan-stage2-bash/bin/bash cargo test --manifest-path src-tauri/Cargo.toml --lib native_modern_bash_complete_script_acceptance -- --ignored --nocapture` | exit 0；原生Bash5.3真实PTY180列通过，19.35秒，`/tmp/shellspan-stage2-bash-verified.log`。额外以 `SHELLSPAN_NATIVE_SCRIPT_NARROW=1` 覆盖32列：exit 0，19.46秒，`/tmp/shellspan-stage2-bash-narrow-verified.log`。分别确认handle `1185`、`33215`真实完成 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib remote_native_complete_scripts_bash_and_zsh -- --ignored --nocapture --test-threads=1` | exit 0；同一单项内真实SSH Bash5.2.37和Zsh5.9通过，8.25秒，`/tmp/shellspan-stage2-ssh-verified.log`，handle `98762`已确认完成。环境采用 `scripts/verify-terminal-remote-ssh.mjs` 的隔离fixtureEnvironment，先 `docker compose -f tests/ssh-e2e/compose.yml up -d --wait`，完成后down清理 |
| `pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs` | exit 0；13项通过。记录 `/tmp/shellspan-stage2-protocol-final.log` |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`pnpm check:rust:includes` | 通过；54个include文件保持所在模块缩进，没有整文件移动缩进 |
| `pnpm check:ai-styles`、`pnpm check:llm:catalog`、`git diff --check` | 通过；LLM目录56个模型/4个负例；无新增UI改动或临时业务日志 |
| `node scripts/verify-native-script-display.mjs /tmp/shellspan-stage2-bash-visible.bin` 及 `/tmp/shellspan-stage2-bash-narrow.bin` | 两个真实PTY记录在xterm/WebKit中重放通过，已实际查看生成截图；完整源码和实际原生结构可见。旁边 `.json` 记录source/accepted line及真实180/32列几何，`.rendered.txt`为渲染后的可检索文本，`.png`为截图；不是桌面/模型端到端替代证据 |

最终Rust运行前已确认此前cargo test进程结束，使用全新唯一日志，按执行handle确认exit 0。早期 `/tmp/shellspan-stage2-rust-final.log` 有旧运行并发写入形成的混合诊断，**不得作为最终门禁证据**。最终运行对应HEAD为 `8627c0c5ee1fd04b9e7020086caa701837e3a17d`，`git diff HEAD -- src-tauri/src | shasum -a 256` 为 `ea8c6fdcc11bd72fa7f107f802acdd7421a6d6367a4d7847a2424c17a32d65eb`；本阶段没有commit。

真实本地验收使用生产Registry/Lease/SessionManager到原生PTY的链路，证明完整多行、引号、Tab、heredoc、原样CR/CRLF、状态/选项继承、前一退出码、原始ANSI在结束前可见、完整source和实际accepted line、唯一副作用、退出码、reduced motion、提交前取消/接管后用户Enter无残留、运行中取消/超时/接管无尾部副作用、普通单行复合命令取消/超时、自定义INT trap的限制及uncertain、语法拒绝无前缀副作用、控制面失联门禁。真实SSH验收直接复用生产broker和原生编码，证明两种Shell的完整脚本/流式输出、cwd/env/alias/function状态跨命令保留、ixon开关不被改变、提交前取消/接管、运行中取消/超时/接管、断线uncertain、generation递增、旧integration拒绝和副作用只执行一次。状态机/解码单元回归另覆盖乱序、错误source/accepted line、非法原因、旧身份、异常prompt不能重新授权未确认缓冲区；它们不冒充真实Shell执行证据。

### 尚未验收与阶段三前置

- Windows原生验收按用户安排延期，后续到Windows运行。执行 `pnpm test:terminal-visible:windows`；也可分别运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib terminal_integration::tests::windows_powershell_5_1_visible_command_integration -- --ignored --exact --nocapture` 与 `windows_powershell_7_visible_command_integration`。必须核对普通单行生产Registry路径、PSReadLine键安装与真实能力广告、完整LF/CR/Tab/here-string、prefix `&`、后台pipeline拒绝、完整commandLine、原始流、前一状态、取消/超时/接管及输入恢复。当前只完成实现、静态契约和测试用例准备，不宣称Windows编译或ConPTY运行通过。
- Linux原生桌面、其他架构及真实模型经桌面UI的完整调用仍未验收；本阶段Docker/SSH与真实PTY/xterm重放不能替代它们。阶段四继续完成这些显示与端到端项。
- 阶段一既存HTTP/SSH转发缺口继续保留。当前 `port_forward.rs`、`native/http_probe.rs` 与fixture相对HEAD无改动，没有重跑完整长门禁，不宣称完整SSH脚本通过；之前基线因果证据仍有效。
- 阶段三由协调正式验收后，在另一个新聊天启动；本聊天不创建或启动。新阶段先读取当前计划和git status，保护全部无关dirty变化及现有agent-command-echo/UI/文案补丁。不得恢复隐式direct、放松审批/native deny、取消exact accepted-line校验、重放uncertain，或自动更改Shell选项绕过门禁。
- 后台实现必须以当前Shell真实作业及所属generation/租约为依据，不能把direct的proc-*当作Shell作业。延续当前源码/固定提交结构、字节上限、原生编辑与取消恢复契约；在取得真实后台验收前保持后台请求拒绝。合作Shell生命周期仍不作授权或强隔离证据。自定义trap、Shell语法/版本限制及Windows延期不得被静默当作已通过。

既有 agent-command-echo 及相关UI/双语文案改动保持原样，阶段四再定向替代移除。本阶段没有创建commit/tag、推送或发布。

## 阶段三：当前 Shell 原生后台作业

本节取代阶段二的后台请求拒绝。本聊天只实施阶段三并交接协调审核，不创建或启动阶段四。既有 UI、布局、双语文案及 agent-command-echo 改动保持原样；没有 commit/tag、推送或发布。

### 当前设计

- `boundTerminal.background=true` 在当前真实 Shell 以原生异步子 Shell 启动完整批准源码，真实源码和输出留在同一 PTY/SSH。Bash/Zsh 通过成熟 shlex 引用和各自只读解析，在异步子 Shell 顶层 eval，不使用另一个执行面/SSH exec 执行源码。继承 cwd、env、已有 alias/function 和选项，恢复 Bash 异步子 Shell 关闭的 alias 展开及前一退出码；后台状态不反向修改父 Shell。`direct` 的 proc-*、stdin/wait/kill/超时及清理保持原实现，无隐式回退。
- 随机 `job-*` 绑定冻结 target、terminalSessionId/generation、integration、Agent/task 和唯一启动 operation。准备、注册和每次输入均重算固定提交关系并校验绑定；同一启动不能再次准备。冻结提交结构与实际 S 确认的 `acceptedCommandLine` 分开，不能把批准源码冒充实际 accepted line。
- 原生异步作业命令有固定唯一前缀 `( : job-...;`。查询/停止使用 Shell 原生前缀 jobspec，不用日志/源码中的任意句柄子串。Bash 使用机器可读 jobs -p，Zsh 使用 zsh/parameter 的 jobstates/jobtexts；不解析人类表格。暂停作业保持存活，TERM 针对正确原生组，CONT 让暂停组处理终止信号。原生作业观察仍属合作式边界，不作授权或强隔离证据。
- 状态包含 starting/queued/running/stopped/stopRequested/exited/rejected/uncertain；启动提交完成、原生启动确认、存活及退出码分别记录。`launchConfirmed`、`nativeActive`、`controlLost`、观察版本/时点/共享序列范围和清理原因不能相互替代。未知退出码保持 null，不补零；确认不活跃的句柄退休，即使退出码未知也不能再控制新作业。
- 启动完成释放租约。模型沿用 run_terminal_command、wait_process、kill_process，按 job-*/proc-* 分派。原生 job 不支持隔离 stdin/stdout/stderr；输出明确 sharedTerminal，允许多个作业/前台交错。启动 timeout 覆盖就绪、编辑、提交与确认，不等于后台寿命；wait 超时不停止作业。管理必须取得当前提示符和租约，不能向用户前台程序输入控制源码。
- 启动确认缺失保留句柄及 uncertain，不重放源码。同一未失联绑定可通过新的、已精确 S 确认的管理命令观察/停止；prepared 记录本身不能使延迟 B/F 变成新观察。断线、关闭、generation/integration 失效永久设置 controlLost，不能在新代次按旧 PID/job slot 重新取得控制。任务取消/应用退出只清理登记作业，不能确认时保留审计。
- 无保存 profile 的源 SSH boundTerminal 仍可获得后台和 wait/kill 工具；切换执行面后已有句柄不被工具目录永久隐藏。Direct 无 profile 不能新建独立执行；job stdin 明确不支持。owner/task、句柄类型、代次和目标校验在后端保留。

### 编辑背压与控制帧

Readline/ZLE原生编辑按Unicode边界分成最多512编码字节的quoted-insert块，另加Ctrl-X Ctrl-A检查点键。当前Windows候选每批最多8192解码后UTF8字节，经Ctrl-X Ctrl-B只读就绪确认后发送Base64数据，原生接收器在2秒内读取至不提交的Ctrl-X Ctrl-F终结符，公开PSReadLine Replace保留原始CR/LF/Tab，GetBufferState读取实际缓冲区。原生着色与预测保持启用；Windows实机验收状态按独立报告记录。H广告检查点，A回传实际完整缓冲区，逐字匹配后才能发送下一块。I=1的旧bootstrap没有H时不开放完整输入。超过512字节的普通单行也走该路径，无能力时输入前拒绝；不以延时假定PTY已消费。

写入源码前先用只读 A 确认空缓冲区；已有用户 draft 时拒绝且不写入/不清除。Bash 未提交取消使用原生 Readline discard widget，避免异步 Ctrl-C 打断 bind-x 回调。L 包含递增序号和实际空缓冲区，绑定原 integration/generation/operation 及成功入队的清理键；准备记录、旧序号、迟到/重复或不同绑定的确认不能放行。提交键一经准入即撤销 clear scope，不能把清理快捷键写入运行程序。清理不发送 Enter，超时保持隔离和租约门禁，L 不解除检查点异常的 sticky 隔离。User Enter 准入即关闭提示符门禁，不等待异步 S 才判断用户程序开始。

源码/提交/编辑输入上限仍为 8192/32768/65536 字节，最后一项包括初始只读探测、所有检查点及最终提交键。最后确认后保留 150ms 取消边界。取消/接管唤醒等待者并与提交锁串行，停止后续块和 accept-line。源码已写入后的 A 丢失/不匹配隔离输入直到新 generation，普通提示符、空 A 或同代次重装 integration 不能解除；初始只读探测未确认时不清理任何可能存在的用户 draft。真实故障用例让真实 Shell 只确认初始空缓冲区、对后续编辑不再回传 A，验证等待中取消/接管、无后续提交和无副作用；新 generation 解除隔离另有状态机覆盖，不能表述为该本地故障用例已做真实重连。

只有交互父 Shell 写控制帧。子作业在私有 integration 目录原子发布数值 receipt，父 Shell 查询后串行发送 F/B。使用固定 /bin/mv、/bin/rm，不受 PATH 变化影响；子 Shell 的目录钩子不污染父 cwd，用户自己的钩子保留。同步 PS1 展开的 Q 为唯一受限子 Shell 例外，每个主提示符只发一次。正常观察/关闭清理私有元数据，失联不伪造清理成功。

### 支持矩阵与延期

| 组合 | 当前范围 |
| --- | --- |
| macOS Bash 5.3、Zsh 5.9 | 真实 PTY/Registry/Lease/Broker；宽窄输入、并发、生命周期及故障隔离，最终命令见下方验证记录 |
| 隔离 Linux SSH Bash 5.2.37、Zsh 5.9 | 复用源 SSH PTY，无保存 profile 的冻结 target；作业、长输入、混合流、父/子 cwd、真实重连代次及唯一副作用；完整 HTTP 门禁仍有既存独立缺口 |
| Bash 3.2、未广告 H/K、monitor 关闭或不支持编辑器 | 后台或长/完整输入前拒绝；保留短普通命令和用户原有选项，不隐式 Direct |
| PowerShell 5.1 / 7 | ThreadJob/Job2、对象 InstanceId、output-only PSHost、内存状态复制、实时管道转发及异步停止的守卫候选和未来 ConPTY 用例；默认关闭，未 Windows 编译或原生运行，不计作验收 |

Windows 按用户“先待定，后续到windows上运行”延期，不安装环境。候选在准备 Shell 前要求可信 Rust 进程设置 `SHELLSPAN_NATIVE_POWERSHELL_JOBS=1`，并检测 ThreadJob 的 Job2 输出类型、StreamingHost、PSReadLine 检查点和 host 编译；修改子 Shell 环境不能开启冻结标志。单有 StreamingHost 不能证明普通/native stdout/stderr 实时显示。代码持续将真实管道交给当前 host 渲染，在格式化前捕获源码状态；初始化失败不声称源码执行，未知退出不补零。

后续先在 Windows 运行 `pnpm test:terminal-visible:windows`。明确准备候选验证环境后，在启动 Cargo 的 PowerShell 设置 `$env:SHELLSPAN_NATIVE_POWERSHELL_JOBS='1'`，分别运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib windows_powershell_5_1_native_shell_jobs -- --ignored --nocapture --test-threads=1` 和 windows_powershell_7_native_shell_jobs。同样检查普通 Write-Output、native stdout/stderr、Write-Error 的提前显示，状态/alias/function/cwd、exit 0/7、native exit 7、throw、错误后输出、Read-Host 拒绝、外部子进程停止无尾部副作用及清理。module 闭包、StrictMode 和非默认 runspace 上下文仍需原生确认，静态实现不作兼容承诺，不能提前启用生产候选。

### 阶段三最终验证与交接

本节记录冻结代码的实际命令、日志、handle 和统计；早期试验不作为最终门禁。阶段四仍负责真实模型经桌面 UI 的端到端、跨平台显示及定向移除补显，本聊天不启动。

最终代码仍基于 HEAD `8627c0c5ee1fd04b9e7020086caa701837e3a17d`，无新 commit。冻结后 `git diff HEAD -- src-tauri/src | shasum -a 256` 为 `8d68d69e0699de1feef356234f0d416892bb6cbf750037fa360da79371b7b673`；该值包含此前阶段的 tracked Rust 差异。新增文件另验 SHA-256：

- `src-tauri/src/terminal_jobs.rs`：`977873fe97d9984f0c436fa8031e010811007bdf8796a3552dbc630f3912ed72`
- `src-tauri/src/terminal_jobs.ps1`：`34c811bbb31b5519aa7af53bc214829b04a66a0b2633110d1c93d83b7f00197b`
- `src-tauri/src/terminal_job_host.cs`：`2fae9d488a7a9cfd984834043e57b3cce28cfeee684f578e9bc7bfdc4577c325`

| 最终检查 | 实际结果与唯一日志 |
| --- | --- |
| `pnpm test` | exit 0；2606 passed、6 skipped，291 files passed、1 skipped，83.46s。handle `53789` 已退出；`/tmp/shellspan-stage3-frontend-verified.log`。release-regression 的预期失败子进程诊断不是主测试失败 |
| `pnpm build` | exit 0；TypeScript/Vite 通过，保留既有 chunk/import 警告。handle `14653` 已退出；`/tmp/shellspan-stage3-build-verified.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | exit 0；1176 passed、0 failed、57 ignored，56.17s。handle `52962` 已退出；`/tmp/shellspan-stage3-rust-verified-2.log` |
| `SHELLSPAN_TEST_MODERN_BASH=/tmp/shellspan-stage2-bash/bin/bash cargo test --manifest-path src-tauri/Cargo.toml --lib native_modern_bash_complete_script_acceptance -- --ignored --nocapture` | exit 0；1 passed，40.35s，180列真实 PTY。handle `44757` 已退出；`/tmp/shellspan-stage3-bash-verified-2.log` |
| 上一命令另加 `SHELLSPAN_NATIVE_SCRIPT_NARROW=1` | exit 0；1 passed，40.65s，32列真实 PTY。handle `19458` 已退出；`/tmp/shellspan-stage3-bash-narrow-verified.log` |
| `SHELLSPAN_TEST_MODERN_BASH=/tmp/shellspan-stage2-bash/bin/bash cargo test --manifest-path src-tauri/Cargo.toml --lib native_modern_bash_missing_editor_checkpoint_quarantines_until_reconnect -- --ignored --nocapture` | exit 0；1 passed，10.90s。handle `3611` 已退出；`/tmp/shellspan-stage3-bash-fault-verified-2.log`。真实缺失确认、等待中取消/接管唤醒及无后续源码提交/副作用 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib remote_native_shell_jobs_bash_and_zsh -- --ignored --nocapture --test-threads=1`，使用隔离 fixture 环境 | exit 0；1 passed，15.94s，单项内真实 SSH Bash/Zsh。handle `75612` 已退出；`/tmp/shellspan-stage3-ssh-jobs-verified.log` |
| 同一 fixture 运行 `remote_native_complete_scripts_bash_and_zsh -- --ignored --nocapture --test-threads=1` | exit 0；1 passed，8.75s，覆盖受新检查点/清理影响的前一阶段完整脚本。handle `94014` 已退出；`/tmp/shellspan-stage3-ssh-scripts-verified.log` |
| `pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs` | exit 0；15 passed，1.51s。handle `39041` 已退出；`/tmp/shellspan-stage3-protocol-verified.log`。包含 A/H/L/K/B/F 私有字段、长度、状态、job 类型/共享输出及 PID 非权威约束 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | exit 0；`/tmp/shellspan-stage3-fmt-final.log` |
| `pnpm check:rust:includes` | exit 0；54 include 文件通过。handle `78818` 已退出；`/tmp/shellspan-stage3-includes-final.log` |
| `pnpm check:ai-styles`、`pnpm check:llm:catalog` | 均 exit 0；56 模型和4负例；`/tmp/shellspan-stage3-styles-final.log`、`/tmp/shellspan-stage3-catalog-final.log` |
| `git diff --check`；HTTP/fixture 范围核对 | exit 0。`port_forward.rs`、`native/http_probe.rs`、`tests/ssh-e2e` 相对 HEAD 无差异，未顺手修复独立 HTTP 问题，也未把完整 SSH 脚本标全通过 |

最终门禁按命令串行运行，均保留真实 handle 并等待退出；没有旧进程并发写同一路径。`/tmp/shellspan-stage3-bash-verified.log` 的旧轮次 exit 101 保留但不作通过证据。取消窗口修复后才生成新的冻结版本记录；没有把偶然绿色重跑作为修复依据。

原生版本现场核对：本地 Bash `5.3.0(1)-release (aarch64-apple-darwin27.0.0)`，`/bin/zsh 5.9 (arm64-apple-darwin26.0)`；隔离 SSH Bash `5.2.37(1)-release (aarch64-alpine-linux-musl)`、Zsh `5.9 (aarch64-alpine-linux-musl)`。macOS 系统 Bash 3.2 的普通短命令及明确能力拒绝由完整 Rust 现有原生用例覆盖；不把现代 Bash 的结果移记到 Bash 3.2 后台能力。

### 验收事实、自审与资源

- 真实 PTY/SSH 证明启动后提示符可复用、前后台并行、多作业输出交错、cwd/env/alias/function/前一退出码继承、自然成功/非零/127、暂停存活、正确作业组停止、PATH 改变不破坏元数据、用户 EXIT trap 覆盖后的未知退出码。状态继承以真实后台写入的独立临时证据文件核对，原始混合流没有被过滤拼接成隔离 stdout。
- 确认缺失、启动取消/接管、任务清理及无残留 Enter 有真实无副作用证据。既有用户 draft 的只读探测拒绝后，在生产回合结束对应的 `release_turn` 后由用户 Enter 实际提交原稿，验证未清除/未拼接 Agent 源码；没有放宽 turn guard。已收到源码前身份变化的请求在边界明确拒绝；有实际接受/执行证据后失联仍为 uncertain/no replay，两者没有混为退出0。
- 就近状态回归验证 prepared 不等于 accepted、旧 B/F 不刷新观察、L 只有已入队且序号/原绑定匹配才确认、旧/迟到 L 不能放行新 clear、未完成恢复阻止新租约、accept 键准入立即撤销 clear scope、User Enter 在 S 前关闭门禁、其他 Agent/task 拒绝，以及新 generation 与旧控制事件隔离。这些是状态/协议证据，不冒充真实 Shell 执行。
- SSH 的无保存 profile target 复用真实源 Shell；重连前真实 ANSI 前缀和唯一文件副作用已发生，重连后实际读取计数仍为1，旧句柄 controlLost、停止请求被拒绝。旧 PID/job slot 没有被导入新代次。原生宽窄 PTY 和独立 SSH 证据仍不替代真实模型桌面端到端。
- 正常完成/停止的登记作业通过原生表/对象观察收束；不确定退出码保持审计，已确认 inactive 的句柄退休。未清理或重命名用户原有作业。测试进程均已退出；Docker compose down exit 0，`/tmp/shellspan-stage3-ssh-cleanup-final.log` 记录三个隔离容器与网络移除，随后 compose ps -a 无容器。失联无法使用旧连接删除远端私有文件时不宣称成功，隔离 fixture 的最终销毁保证本轮测试资源收束。

本阶段新增 `terminal_jobs.rs`、`terminal_jobs.ps1`、`terminal_job_host.cs`；修改 integration/broker、原生 terminal_execute/runtime、facade/prompt/model schema、native arguments 类型、session 私有元数据清理和就近测试；同步 TS job 观察类型及协议/schema/矩阵。继续使用现有 `terminal_execute`、wait/kill 和类型化 native IPC，没有新增 Tauri command、persisted surface 或 event-v5 版本。已有展示补丁和相邻 UI 未改动。

Windows 原生、Linux 原生桌面、其他架构和真实模型经桌面 UI 仍按矩阵保留未验证。Windows 候选默认关闭，不能因静态/Rust 构建通过而启用；阶段一独立 HTTP/SSH 转发缺口继续保留。阶段三已完成当前可运行平台实现、自审与交接，等待协调统一审核；本聊天到此结束，不自行进入阶段四。

## 阶段四：定向移除、当前契约与验收交接

本节为阶段四当前实现，保留前三阶段的历史证据及严格契约。本阶段使用原 checkout，没有 commit/tag、push 或发布；未自行将整体 Goal 标记完成。

### 修改范围与实际修复

- 删除最初新增的 `src/lib/terminal/agent-command-echo.ts`、其测试及 `scripts/verify-agent-command-echo.mjs`；移除 controller 中该投影的引用、缓存和输出拼接，以及双语 `agentDirectCommand`/`agentOutputTruncated` 键和兼容文档补显段落。相邻 turn/input/占用保护保留；历史 JSONL 不重写，普通 Direct 工具结果仍在会话中读取。
- 同一 turn 已有输入保护时，后续租约沿用该保护和冻结目标，不切工作台、终端选择或键盘焦点；释放租约也不再 focus。初次可见终端 readiness 的既有聚焦行为保留。隐藏面板取消已排队的自动 focus 帧，回调再次核对当前目标、可见性和实际连接的 host；不改变布局和控件。
- 修复 facade 的 process 结果目标投影：native `process-job-*`/`process-proc-*` 必须先等于授权 native target，其 owner 必须等于冻结 host，随后才投影到 public host。`finish_native` 的 call/native name/target/effect/summary 门禁保持原样，伪造 native target 或 owner 仍拒绝。
- 未提交取消只恢复一次，输入线程退出时不重复中断新的提示符。Zsh 使用原生 ZLE widget 清空 `BUFFER`/`CURSOR`、重绘既有提示符并发送严格 L 确认；Bash 沿用 Readline L。初始空 A、原身份/代次/operation、已入队与递增序号、accept 后撤权、异常 sticky 隔离均保留。已提交取消仍走真实中断。
- 原生 job 的一次 wait 继续多次实际观察，能够发现首次 running 后的自然退出。下一轮至少预留本次最大确认往返耗时的两倍，初始下限为两倍 150ms 提交边界；余量不足则不再编辑，按原 deadline 可取消等待，返回真实旧观察时点/版本及 waitTimedOut。没有延长调用 deadline、补退出0或用迟到 A/L 解除隔离。真实回归在首次 running 观察后才放行子作业 exit7，要求同一次5s wait发现退出；另1s wait不能隔离健康编辑器，随后10s kill必须真实停止。
- 只读 skills/files 发现不再 `resumeEndedSession`。真实关闭后迟到的目录刷新必须保留 cancelled/ended；重开属于显式提交/配置或成功验证新 target 的重连动作，重连先读取新快照再决定 resume。没有修改取消状态为 idle 的断言，也不重写已结束历史。
- Direct 保留原 `proc-*`、stdin、wait/kill、结构化输出和退休语义；仅在工具描述/RFC 明确终态 wait/kill 会退休句柄，不应再查询，缺失退出码不补零。

本阶段涉及 controller/`hooks/use-active-controller.ts`、`agent-session-adapter.ts`、native adapter/runtime/terminal_execute、integration/broker 和就近回归；新增 native-jobs 原生验证页、原生编辑器布局辅助脚本与可选依赖清单。本阶段未编辑 `terminal_jobs.rs`/`.ps1`/host `.cs`；其中 `.ps1` 已由并行的阶段三 Windows 续验会话修改，归属和当前校验见下文，不能称这三个文件当前均未变化。没有新增生产 Tauri command、surface enum 或 event-v5 版本。

### 证据方法与可复现命令

真实默认模型为配置中的 `MiniMax-M3.1-Flash`，route `route-661c9e20-1dbd-43c7-88b4-f81f2cb2ab43`。原生验证走生产 facade/native runtime/Registry/Lease/Broker、同一真实 PTY/SSH 和生产 xterm。使用 `requestApproval`，只批准本轮逐字源码或从完整、SHA校验过的结果取得的登记句柄；scope 的 externalSideEffect 仅用于本轮实际多行分类，没有修改生产审批/effect/native deny。stdout/stderr 不伪造隔离 job 日志。

`node scripts/verify-ai-session-stream.mjs --native-jobs --data-scope com.shellspan.validation.stage4` 为本地验证；本地 Bash 加 `SHELL=/tmp/shellspan-stage2-bash/bin/bash`，SSH 分别加 `--native-jobs-ssh bash`/`zsh`。`--native-jobs-focus` 使用实际 Focus composer，从开始严格检查草稿/选择/焦点；`--native-jobs-direct` 在同一真实会话显式切 Direct，严格执行五次 launch/stdin/wait/launch/kill。

非 Focus 工作台验证单独记录初始命令阶段（允许首次 readiness 聚焦）。首个真实 tool/result 与 lease released 都到达后，用户再选择另一终端、切工作台并聚焦草稿；下一段原始源码审批等待该边界成立，后续 launch/wait/stop 全程监控。验证页按照实际 section/Focus 面板可见性传入 isVisible，不将初始自动聚焦或隐藏面板的延迟帧误归因给目标 Agent。

完整显示检查同时保留 marker、alias/function、heredoc/Tab 和完整源码检查：批准 source 与 job.commandLine 相同，实际 submitted/accepted 逐字相同；用实际目标 xterm cell 定位0-based prompt起点，不从 isWrapped 推断 ZLE 主动换行。辅助脚本仅把该 accepted line 装入另一个真实原生编辑器，校验 BUFFER SHA，**不 accept、不执行源码、不向实际 target 写补显**。其原生绘制流提供行/cell边界，实际目标的每一行 source cells 必须逐格一致。Bash bind-x 的 BUFFER 确认会临时清屏，参考记录在其返回后使用原生 clear-screen/bell 顺序边界收集重绘；不使用固定 sleep 假设重绘完成。

该辅助验证只适用 POSIX Bash/Zsh，需 Python3、`scripts/requirements-native-layout.txt` 中的 pexpect4.9.0/ptyprocess0.7.0；本机实测 Python3.14.4，未安装或更改用户依赖。SSH布局参考使用本阶段既有隔离 fixture 内的相同 Shell。runner 的 proof 端点仅127.0.0.1随机token、每轮一次、有限请求/trace大小；Shell、transport、compose、executable 来自 runner 已知配置，不接受 HTTP 任意指定。参考 trace 不能单独算模型/桌面验收。

后期发现另一个不属于本阶段的 `tauri:dev` 窗口，未终止或操作。最终矩阵使用 Tauri 已支持的 config.identifier 隔离 sessions/artifacts 到 `~/Library/Application Support/com.shellspan.validation.stage4`，正常复用既有 route credential reference 和系统钥匙串，没有发明环境变量、复制明文凭据或修改用户配置。

### 失败证据与边界

早期失败均保留，不与最终唯一通过日志混写。关键因果记录包括冻结 public/native target 不匹配、Zsh 重复 Ctrl-C/原生清除、短 wait 截止前新开 poll、关闭后 `session/ended` 被目录读取触发 `session/resumed`。关闭因果在真实无模型 PTY 场景可重复：`/tmp/shellspan-stage4-close-metadata-before-20261023.log` 及 `shellspan-terminal-contention-6a62749c-dd71-447e-aa61-6ca02696de25.json`；修复后的 metadata-fixed 与实际双 Agent 整链分别验证。

`a8b9f8fb` 旧笼统视图失败只知发生在首 setup 阶段，缺少字段，不能事后断言具体原因或用随机绿跑解释。新版 `f5810a8b` 记录到另一 TerminalPane 的延迟 focus（不是源 Agent终端）：section/选择/29B草稿都正确，leaseOwned=false；据此分清初始契约、用户边界与可见性/自动 focus，保留所有视图断言。

显示诊断 `50b4a058` 的完整源码和 marker 都在，仅无换行 alias/function 末态缺失；最终继承刺激使用合法完整输出行，生产字节流不改写。原生无 integration 的单次基线 `/tmp/shellspan-stage4-plain-zsh-no-newline.bin` 及其 rendered/cells 文件同时保留两者，不能据此声称原生必然擦除，也没有用 raw 到达代替最终显示通过。`9a8b7692` 是列0文本参考不等价 ZLE 原生折行；后续用原生布局逐 cell 证明完整 actual accepted line。`8ba8c7ef` 的源码改写被精确审批拒绝。`3a10de9b` 的 Direct 五步本身完成，随后模型额外查询已退休句柄导致整轮失败，未把该 exit1 计作整体通过，也未改退休契约。

实际桌面截图 `/tmp/shellspan-stage4-zsh-desktop-20261023.png` 已查看，显示真实完整源码和提前输出；其 controller 显示代码后续保持相同。后续 Mac 锁屏未绕过，不能声称补采了最终像素截图；最终显示以实际 Native WebView target 的逐 cell/原始流记录审查。早期等待截图的无条件暂停已删除，不以暂停延时作为完成边界。

本阶段没有执行 Windows/PowerShell 原生验收，候选默认关闭。本阶段启动时的延期安排随后发生变化：用户在阶段三会话 `01a1676c-b33b-7732-aa51-317aa1a71d08` 明确要求“现在连接 Windows，继续完成之前延期的 Windows 原生终端验收”，该独立续验正在进行；其 Windows 结果归该会话审查，不合并为本阶段通过。继续保留上一阶段原生验收命令。Linux 原生桌面、其他架构未运行；Mac客户端连接 Docker Linux SSH 不等于 Linux桌面验收。既存 HTTP/SSH 转发缺口未修，终端专项通过不表示完整 SSH 门禁通过。

### 最终模型矩阵与原始证据

以下均为真实模型/Native WebView 整轮 exit0；每轮7个可视工具结果 completed，包含实际审批、当前Shell状态、完整多行/Tab/heredoc、提前输出、3次wait、真实stop和末条exit7。完整 source cells 逐行全匹配，source/native BUFFER SHA一致；句柄与实际 terminalSessionId/generation/operation/租约相符。绝对证据归档 `/tmp/shellspan-stage4-evidence-20261023/index.json` 保存每份原始JSON路径、SHA和native布局trace。

| 实际组合与模式 | 最终唯一日志、执行handle | 结果与归档 |
| --- | --- | --- |
| macOS arm64 Bash5.3，真实Focus composer；随后显式Direct | `/tmp/shellspan-stage4-model-local-bash-long-prompt-final-20261023.log`；41727已退出 | exit0；80x24、17行完整source cells、14/14租约；Direct恰好5个completed，stdin13B、stdout=`received:direct-stdin\n`、exit0，第二proc真实kill为Cancelled。`local-bash-focus-direct.json`；原始d89a027a-62eb-4f6f-b77a-52d2bed97c84 |
| macOS arm64 Zsh5.9，首命令后实际用户工作台边界 | `/tmp/shellspan-stage4-model-local-zsh-hidden-focus-fixed-20261023.log`；66940已退出 | exit0；12行完整source cells、10/10租约；initialView/result51后，workingView明确为另一session、Workbench、29B草稿且editorFocused，之后全部管理保持。`local-zsh.json`；原始b86a1274-6000-4552-80fe-0c0290dbed2a |
| Mac客户端→隔离 Linux SSH Bash5.2.37，原源PTY、无保存profile | `/tmp/shellspan-stage4-model-ssh-bash-native-redraw-20261023.log`；22935已退出 | exit0；170x40、起点16、12行完整source cells、14/14租约、earlyOutput=true。`ssh-bash.json`；原始9bd1c5d7-2bb4-406e-84f0-d3ba10c35222 |
| Mac客户端→隔离 Linux SSH Zsh5.9，原源PTY、无保存profile | `/tmp/shellspan-stage4-model-ssh-zsh-native-layout-20261023.log`；84387已退出 | exit0；170x40、起点16、12行完整source cells、14/14租约、earlyOutput=true。`ssh-zsh.json`；原始fdfe4b84-7643-4845-b2cd-bd7d368f90fe |

本地Bash使用阶段二已存在的 `/tmp/shellspan-stage2-bash/bin/bash`，没有替换系统Bash。Bash3.2普通短命令/能力拒绝沿用真实原生回归，不把Bash5.3后台结果移记给Bash3.2。布局辅助不执行approved源码，整轮真实执行仍只在上述冻结目标进行。

### 最终回归、门禁与日志

| 实际命令/范围 | 最终结果、唯一日志、已退出handle |
| --- | --- |
| `pnpm test`，包含隐藏focus新增就近回归 | exit0；2601 passed、6 skipped，290 files passed、1 skipped，73.52s；`/tmp/shellspan-stage4-frontend-focus-frozen-20261023.log`；57957。release-regression预期失败子进程诊断不代表主测试失败 |
| `pnpm build` | exit0；TypeScript/Vite通过；`/tmp/shellspan-stage4-build-focus-frozen-20261023.log`，57957；保留既有chunk/import警告 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib`，最终描述同步后的冻结代码 | exit0；1177 passed、0 failed、57 ignored，57.96s；`/tmp/shellspan-stage4-final-rust-frozen-20261023.log`；61560 |
| `SHELLSPAN_TEST_MODERN_BASH=/tmp/shellspan-stage2-bash/bin/bash cargo test --manifest-path src-tauri/Cargo.toml --lib native_modern_bash_complete_script_acceptance -- --ignored --nocapture` | exit0；180列真实PTY；新增单次wait自然exit7/1s不隔离后kill与原完整脚本/作业/取消契约全部通过，42.77s；`/tmp/shellspan-stage4-bash-wide-final-20261023.log`；20741 |
| 上条另加 `SHELLSPAN_NATIVE_SCRIPT_NARROW=1` | exit0；32列真实PTY，同一完整范围，44.71s；`/tmp/shellspan-stage4-bash-narrow-final-20261023.log`；14290 |
| `native_modern_bash_missing_editor_checkpoint_quarantines_until_reconnect -- --ignored --nocapture`，同Bash路径 | exit0；1 passed，10.84s；`/tmp/shellspan-stage4-bash-fault-final-20261023.log`；88079；没有放宽缺失A后的sticky隔离 |
| 隔离fixture的 `remote_native_shell_jobs_bash_and_zsh`、`remote_native_complete_scripts_bash_and_zsh`，均 `--ignored --nocapture --test-threads=1` | 两项各exit0；真实SSH Bash/Zsh；`/tmp/shellspan-stage4-ssh-regression-final-20261023.log`；25311；具体fixture环境沿既有SSH脚本，执行器 `/tmp/shellspan-stage4-ssh-regression.mjs`。不是完整HTTP门禁 |
| `node scripts/verify-ai-session-stream.mjs --terminal-contention` | exit0；真实两Agent同PTY、拒绝草稿、显式重试、同时准入仅一胜者、接管、运行中关闭、无关目标保留、重复关闭及迟到metadata不重开；`/tmp/shellspan-stage4-contention-final-all-20261023.log`；34819。`contention-fixed.json`归档99b9a57a-7c7c-4786-a040-35f67d7335eb |
| `--terminal-contention --no-model` | exit0；真实PTY关闭+两surface持久取消+迟到实际adapter目录读取仍ended；`/tmp/shellspan-stage4-close-metadata-fixed-20261023.log`；51248。归档 `close-before.json`/`close-fixed.json`保留原失败和修复后因果，不冒充模型执行 |
| `--terminal-reconnect --no-model` | exit0；真实本地TTY闲置断线/Enter、多次重连、原会话/草稿、关闭面板恢复readonly history和拒绝伪造ancestry；`/tmp/shellspan-stage4-reconnect-local-final-20261023.log`；18227 |
| `--terminal-reconnect-ssh --no-model` | exit0；真实SSH对应重连/历史范围；`/tmp/shellspan-stage4-reconnect-ssh-20261023.log`；79057。后续仅调整reconnect取新快照的调用顺序，本地final验证及adapter117项回归覆盖该顺序 |
| `pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs` | exit0；16 passed；`/tmp/shellspan-stage4-protocol-descriptions-final-20261023.log`；1550；包含无补显、私有控制、原始流及无隐式Direct规则 |
| `use-active-controller` + `terminal-controller-layer` 就近回归 | exit0；47 passed；`/tmp/shellspan-stage4-hidden-focus-regression-20261023.log`；40812；真实controller方法spy仅观察调用，不替换实现 |
| adapter + workspace controller相关回归 | exit0；117 passed；`/tmp/shellspan-stage4-adapter-final-20261023.log`；3936；显式配置/提交resume仍保留 |
| `cargo fmt ... -- --check`、`pnpm check:rust:includes` | exit0；54 include保持上下文缩进；`/tmp/shellspan-stage4-fmt-final-descriptions-20261023.log`、`/tmp/shellspan-stage4-includes-final-pass-20261023.log` |
| `pnpm check:ai-styles`、`pnpm check:llm:catalog` | exit0；`/tmp/shellspan-stage4-styles-final-all-20261023.log`、`/tmp/shellspan-stage4-catalog-final-all-20261023.log`；56模型/4负例 |
| `node --check scripts/verify-ai-session-stream.mjs`、Python AST、native fixture TypeScript及`git diff --check` | 通过；原生布局工具另由四Shell真实矩阵实际调用验证；没有将独立基线重放作为模型通过证据 |

Native模型验证中的 TAURI `Couldn't find callback id` warning 保留在日志。其出现于工具/布局证明后及终端/页面清理阶段，验证器卸载、取消监听/关闭transport后仍有异步IPC回执；不能称“零警告”。它们没有被屏蔽，整轮 exit0与租约释放、作业终止、持久取消/关闭断言分别核对。

### 冻结校验与资源归属

本阶段验证基于 HEAD `8627c0c5ee1fd04b9e7020086caa701837e3a17d`。全量 Rust 验证的 tracked diff SHA 为 `d37c00c8039d484b1721de01b972c2e09d4f6ab1a59ce2bbb6924c2257736577`，对应 `/tmp/shellspan-stage4-final-rust-frozen-20261023.log` 于2026-10-23 20:37:26 +0800完成的1177 passed/57 ignored，包含前三阶段差异。它标识该次已验证冻结版本，不标识持续变化中的实时工作树。阶段三 Windows 续验又于21:00:28修改了 `tests/terminal_integration.rs`；本阶段不覆盖该并行改动，最后一次观察的当前 tracked diff SHA 为 `34a4b809e760cedb3a598012084dd7a68a12145251968d4c3762cc94283c660c`，不把它冒称为上述全量验证版本。

`terminal_jobs.rs` 和 host `.cs` 校验仍分别为 `977873fe97d9984f0c436fa8031e010811007bdf8796a3552dbc630f3912ed72`、`2fae9d488a7a9cfd984834043e57b3cce28cfeee684f578e9bc7bfdc4577c325`。`.ps1` 的阶段三历史 SHA `34c811bbb31b5519aa7af53bc214829b04a66a0b2633110d1c93d83b7f00197b` 保留为历史值；当前完整读取核对值为 `fe4ab9067acd7c856afa7bdc31a83005ce9495be2701c8fe330658baac4e45a4`，mtime为20:35:51 +0800。实际 read_thread 编辑记录 `exec-2ab9b292-7111-4310-804f-ab0b02df3089` 确认该修改来自上述阶段三续验会话。与其保留归档 `/tmp/shellspan-windows-native-20261023.tar.gz`（内含旧 SHA）比较，唯一代码变化是 Add-Type 移除显式 `-ReferencedAssemblies`，保留运行时默认引用，并加上 System.Console/Automation 的说明；这是该会话针对远端 Add-Type 引用失败后的修复。本阶段没有还原或重写该脚本。

当前 `.ps1` 的静态包含检查命令 `cargo test --manifest-path src-tauri/Cargo.toml --lib terminal_jobs::tests` 已确认 handle66585 实际退出0；`/tmp/shellspan-stage4-final-current-powershell-static-20261023.log` 为1 passed、0 failed，重新编译后通过。`terminal_jobs.rs` 测试及 `terminal_integration.rs` 的 `include_str!("terminal_jobs.ps1")` 读取当前脚本；这只证明当前 Rust 静态包含/契约检查，不证明 Windows 编译、ConPTY或PSHost原生通过。

生产前端SHA：controller `4216883d7cce16279c400584025f46930a176572720e3f2930a240e0854973f0`；隐藏focus hook `0219ec8dfc58428c6d359c90ed48f49f79fb8c45709cfca69fdfdb8bb59300af`；adapter `da31dbc399e2e9ae57fe3014e18d6efb0faa9a3ffeef095f0710f7a86941842e`。验证脚本最终校验另保存归档索引；文档自身随后追加交接，不形成循环校验。

本阶段所有明确归属的Native验证器、其私有签名App、真实测试句柄均等待退出；暂停QA的旧轮仅终止已记录的私有App PID94448，由原runner收到143并收束，整轮未计通过，旧b23测试会话随后通过正常cancel/archive/delete API定向清理。没有全局pkill。资源核对时出现的未知 `.shellspan-dev-RTjGqM` PID18764与原 `/Applications/ShellSpan.app` PID87046没有执行任何终止操作；后续ps不再列出它们，不归因为本阶段清理。

本阶段创建的3个隔离SSH容器及网络已compose down exit0，随后ps -a为空；记录 `/tmp/shellspan-stage4-final-ssh-cleanup-20261023.log`。所有正常/失败测试只清理自有session/profile/host信任；保留独立审计JSON、原生布局trace及临时验证专用数据根，没有清空用户数据。`port_forward.rs`、`native/http_probe.rs`、`tests/ssh-e2e` 相对HEAD继续无差异。

本阶段当前可运行平台的实现、相关测试与上述真实模型/显示证据交由协调审查；Windows本阶段未验、独立续验进行中，其他未运行矩阵仍未验证，整体跨平台Goal不在本会话标complete。

### 2026-10-23 再次审查

21:32 +0800复查未发现阶段四新增的阻断缺陷或验收材料遗漏。重新检查了public/native目标和owner校验、未提交取消恢复、wait原截止时间与自然结束观察、租约释放和隐藏面板焦点、关闭后只读目录刷新及显式重连、Direct句柄退休，以及无补显的原始流/实际cell证据。归档的11份源码SHA与当前文件全部一致，4份模型JSON的SHA、7次completed结果、完整source cells、提前输出、全部租约释放、stop后nativeActive=false/controlLost=false和末条exit7均重新核对；Focus组合的5次Direct调用保持完整。本次没有重跑模型、SSH或桌面矩阵，继续引用上文各自的真实验收版本。

当前HEAD为 `b3cd168cb505ac233ba606ba75137c9e412f1fca`；较原验收HEAD新增的是独立的终端初始化提示提交，不将其记作本阶段提交。本次 `git diff -- src-tauri` 的SHA为 `83bb2904e072470f27bef9a4a4182e6272b95a6bed986ed0f35f0d111ddf133a`，只标识本次tracked Rust差异；未跟踪的Windows三份文件SHA仍为上文记录值。历史冻结SHA和当前工作树继续分别记录。

本次补跑 `use-active-controller`、`terminal-controller-layer`、协议契约共63项，`session-adapters` 36项，全部通过；`pnpm exec tsc --noEmit`、`pnpm check:rust:includes`（54份）、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`通过。当前全量 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 实际退出0，1177 passed、0 failed、57 ignored，58.16s；日志 `/tmp/shellspan-stage4-rereview-rust-20261023.log`，handle43572。TypeScript日志 `/tmp/shellspan-stage4-rereview-typecheck-20261023.log`。这些macOS回归不构成Windows编译/ConPTY/PSHost验收，也不关闭Linux桌面、其他架构或既存HTTP/SSH缺口。Windows继续独立续验；本次仅追加复查记录，没有修改产品代码、创建commit/tag或推送。

### 2026-10-24 当前工作树再审查

本次重新读取当前实现及两份 Windows 报告，检查真实终端路由、编辑批次与取消/接管门禁、原截止时间、租约/焦点、只读刷新不恢复已结束会话、显式重连和 Direct 证据。未发现新的 macOS/SSH 阻断问题，但不能确认当前 Windows 候选无回归：独立报告中的持续输出丢失和输入中断恢复未通过项仍是验收阻断，候选继续默认关闭。本次不启动 Windows 新一轮实现或模型矩阵。

四份既有模型 JSON 的归档 SHA 均匹配，分别重新断言7个 completed 结果、租约全部释放、提前输出、全部 source cells 相等、source/native BUFFER SHA相同、stop后 nativeActive=false/controlLost=false及末条exit7。Focus组合的5个 Direct结果、结构化stdin输出及exit0也匹配。生产 controller、focus hook、adapter仍与2026-10-23源码清单一致；当前 runner、协议测试、native-jobs及contention fixture已因续验发生变化，旧清单只标识历史版本，不作为当前这些文件重新通过模型矩阵的证明。

复查修正两类材料遗漏：主计划补齐独立桌面报告入口并限定旧复查结论的版本范围；桌面报告明确已通过的应用历史隔离与仍待复验的参考工具，并将非Enter终结描述更新为当前已实现、原生安全验收未完成。另按现有 include 上下文仅格式化 `tests/terminal_editor_windows.rs`，未修改其行为或其他产品实现。

本次实际退出0的检查：6份就近测试文件109项（包含adapter36项，不重复累计），TypeScript检查、Rust全量1180 passed/0 failed/57 ignored（60.79s）、cargo fmt、56份Rust include、AI样式、LLM catalog、runner语法及diff空白检查。日志分别为 `/tmp/shellspan-stage4-audit-current-tests.log`、`/tmp/shellspan-stage4-audit-current-typecheck.log`、`/tmp/shellspan-stage4-audit-current-rust.log`；include首轮失败已定向修正并复跑通过。未重跑桌面、真实模型或SSH矩阵，亦未将macOS测试计为Windows验收。HEAD仍为 `b3cd168cb505ac233ba606ba75137c9e412f1fca`，未提交、打tag、推送或发布。
