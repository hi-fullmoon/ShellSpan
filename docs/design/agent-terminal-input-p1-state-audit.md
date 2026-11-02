# Agent 终端输入 P1 状态、协议与恢复验收

实施开始：2026-10-31；验收完成：2026-11-01（Asia/Shanghai）。P1 在 macOS arm64、固定 GNU Bash 5.3 / Readline 8.3.6 与正式 patched xterm 6.0.0 组合上限定通过，包含统一状态、所有权准入、持久提交意图、NIP/1 与真实故障验证。原冻结日期、UTC 产物名称和哈希保留。全量发布门禁仍有下文列明的失败；P2–P4 未实施，应用创建终端仍使用原输入路径。

## 冻结基线与修改边界

- HEAD：`7b9ed07b5198ab9393a54880eada124252a5b4a5`；没有 commit、push、tag 或发布。
- 完整 P1 开始状态：`.native-input-p0/p1-full-baseline/` 的 status/head/hashes 和工作区归档。worktree.patch SHA-256 为 `1a24b4e7f0f0f0835482a5edc27de16c6a8254282532ce665a67866bd4e8e84d`；untracked.tgz 为 `21e486f9b060e6ac4bc0591986f37d148e7dfb542306047f97598a6ceddd8010`。归档只供隔离复查，不能覆盖当前工作区。
- 保留 P0 依赖采纳及所有并行 SFTP 修改。正式 xterm 补丁 SHA-256 保持 `5aabb3510e24bc66ce0f30f510dbdcc534fce6de974287bab34d7d78d85df622`。
- 用户已批准通用 xterm 光标重排/全局软换行复制规则及同流显示机制；该授权不允许业务层文字/光标/选择覆盖。
- 没有真实业务主机副作用验收；没有新增权限、审批、冻结目标或用户配置。新增 UI 仅为原状态条的阶段文案，沿用现有布局、焦点和操作入口。
- 早先独立审计的开始归档保留在 `p1-state-baseline`；它是历史证据，不再描述当前状态权威或 P0 准入结论。

## 唯一所有者与模块边界

| 数据/权威 | 当前唯一写入者 | 兼容及读取边界 |
| --- | --- | --- |
| 生命周期、首次停止原因、mayHaveSubmitted、开始/结束事实 | Broker 现有 `TerminalCommandOperation.data.lifecycle`，由 `terminal_command/state.rs` reducer 修改 | 旧 9 状态为投影；执行器不再维护独立 submitted 布尔值 |
| 源码、授权绑定、全操作身份 | 不可变 `CommandIntent` | 保存既有 request/capability/approved call/frozen target；执行仍重新校验既有权限及目标 |
| 实际提交表示和摘要 | 不可变 `ExecutionPlan` | legacy editor、native inline Bash、Job launch/control 明确区分；不发给前端 |
| 完整输入证明 | 当前操作内 `FullInputProof`，真实私有回执匹配后建立 | native 严格读实际 UTF-8 字节、point/end 和摘要；legacy editor/私有 Job control 使用各自明确证明 |
| 终端代次、输入 owner、lease ID/revision | `SessionRecord` / Broker 最终输入准入 | LeaseManager 只保留 turn/角色/接管、前端 ready、事件及资源注册；启用 Broker 时没有第二个可独立授权的 owner |
| 停止撤销 | 同一 Broker→operation 锁顺序，Agent owner 旋转为 Revoking 并递增 lease | 所有旧 Agent continuation/accept 失效；只允许当前 scope 的必要 clear/System interrupt |
| 可执行提交互斥 | 操作共享的 submission_gate | 原执行器和 NIP adapter 共用；无第二套 submitted mutex/状态 |
| 私有 NIP 请求槽/期限/回执指纹 | `terminal_command/coordinator.rs`，作为 Broker 子模块访问现有 operation | 不另存生命周期/lease，不隐式写 PTY；每操作只能 claim 一次，P2 才提供生产传输队列 |
| 跨进程不重放 | SQLite SubmissionJournal 唯一调用键 | 完成后也保留去重墓碑；源文、计划、摘要和凭据不入库 |
| sourceMayBeEnqueued | Broker 准入在实际回调之前置位 | 含模糊投递，不证明完整输入、执行开始或结束 |
| pending/recovery/clear | SessionRecord 原门禁 | 退役、释放和前端清理不能证明空编辑器或抹除不明状态 |
| 前端 lease 视图 | 既有 controller 管理资源；新快照只派生文字 | 不授予 owner/ready/审批、不清输入抑制或恢复门禁 |

新增模块位于 `src-tauri/src/terminal_command/`，复用现有 Broker，没有拆出新的全局状态容器。
普通 attach 仍是 legacy；native mode 只在显式连接初始化选择，失败不热换模式。

## 生命周期及全部事件规则

12 个 phase 为 AwaitingReady、Preparing、Typing、InputConfirmed、SubmissionAttempted、Running、Completed、CancelRequested、Cancelled、Failed、Uncertain、RecoveryRequired。
旧 Submitted 投影覆盖提交前各阶段，因此不能从旧名字推断已经 accept。

下表给出每个事件的所有接受条件。未列出的状态/事实组合一律拒绝，且不得修改任何生命周期事实。
相同 phase 不一定是幂等：新证明/撤销事实可在 phase 不变时被接受。

| 事件 | 接受条件及结果 | 幂等条件 |
| --- | --- | --- |
| Ready | AwaitingReady → Preparing | Preparing |
| BeginInput | Preparing/Typing/InputConfirmed 且尚未可能提交 → Typing | 事实完全相同 |
| ConfirmInput | 相同可编辑条件 → InputConfirmed | 事实完全相同 |
| AttemptSubmission | 仅 InputConfirmed 且尚未可能提交 → SubmissionAttempted，may=true | 无；重复提交拒绝 |
| LegacyAttemptSubmission | 旧路径可编辑阶段 → SubmissionAttempted，may=true | 无 |
| Started | SubmissionAttempted；或已可能提交的 CancelRequested → Running/保留停止 | 已见 start 且 Running/Uncertain |
| LegacyStarted | Preparing/Typing/InputConfirmed/SubmissionAttempted/CancelRequested，且未被本地撤销或已可能提交 → may=true/start=true | 同上 |
| Settled | may=true 且 SubmissionAttempted/Running/CancelRequested/Uncertain → Completed；有停止原因则 Cancelled，ended=true | 已有 ended |
| LegacySettled | Running/CancelRequested 且未被无提交撤销 → 相同结束投影 | 已有 ended |
| RequestCancel/TimedOut/TakenOver | 非终态首次请求 → CancelRequested，原因首次获胜；先原子撤销 owner | 已有原因或终态 |
| WithdrawBeforeSubmission | 未可能提交的 CancelRequested：仅记录撤销，保留 phase | 事实完全相同 |
| NoOwnedDraft | 已撤销且未可能提交的 CancelRequested → Cancelled；调用方必须实际无 source 投递 | 无新增事实时 |
| LegacyInterruptEnqueued | 已撤销且未可能提交的 CancelRequested：记录中断已准入，仍等待旧编辑器返回 | 相同事实 |
| LegacyEditReturned | CancelRequested 且已准入旧中断且未可能提交，或受信源码拒绝 → Cancelled | 无 |
| DraftCleared | CancelRequested 且未可能提交/受信拒绝 → Cancelled；未提交的 Uncertain/RecoveryRequired/Failed 仅登记真实 clear | Cancelled |
| PreparationFailed | 非终态且未可能提交 → Failed | 无 |
| ParserRejected | 非终态登记受信源码拒绝；有停止原因保留 CancelRequested，否则 Failed | 无 |
| SettledUncertain | Running/CancelRequested → Uncertain，保留真实结束事实 | 无 |
| InputLost | 非终态或 Uncertain → RecoveryRequired | 无 |
| ControlLost/TransportClosed/ApplicationExit | 非终态 → Uncertain，不推断未执行 | 终态 |

`terminal_command/tests.rs` 使用 21 条独立状态/事实路径 × 24 个事件，共 **504 格**，
覆盖所有 phase、提交前后停止、parser refusal、无 source 本地退出、真实清理与不明状态。
每格记录 accepted/rejected/idempotent，并断言拒绝/幂等不改事实、may 单调、只有真实 clear 事件生成草稿空证明、
native attempt/start/end 前提、停止原因不可覆盖。
生成的完整表在 `p1-validation/state-matrix.json`；这是纯 reducer 证据，不能充当原生回执。

### 原生与 legacy 事件隔离

native 只接受绑定的 NIP 回执推进 strict 事件。旧 S/E 不再成为同一 native 操作的第二个状态写入者。
legacy S 是独立明确证据，不可借其宽松条件越过 native InputConfirmed。
取消后迟到的合法 Prepared/Progress/Confirmed 校验绑定后丢弃，不能重开输入或阻塞真实 DraftCleared。
旧 identity 拒绝且不污染后继；当前绑定冲突则隔离。

本地 settle_unsubmitted 只登记撤销；source 曾可能投递时不得伪造 DraftCleared。
legacy 中断及编辑器返回使用单独事实，不冒充 native 空缓冲证明。正在清理的对象延迟退役。
lease 释放后仍无 clear/结束证明时 User Enter 被拒绝，Ctrl-C 继续沿用受限例外。

## 提交持久化、准入和崩溃窗口

SQLite WAL + synchronous=FULL、user_version=1；Unix 根目录/文件 0700/0600，拒绝链接和未知格式，
运行打开不 CREATE。call key 为 SHA-256(JSON([agent,task,operation]))；记录完整身份和 noAutoReplay，
不保存源码或包装。Runtime configure 只登记固定绝对根路径；文件和 SQLite 初始化在首次 native 后台操作或恢复查询的 spawn_blocking 中串行进行，避免新增 Tauri 主线程阻塞。
未结算查询最多 4096，按 Agent 过滤；跨进程恢复门禁只针对首次后台初始化时读出的记录，
同进程 live intent 保留原交互准入，不能据此阻止已确认开始的 legacy pager 退出。
数据库缺失/不可读是恢复失败，不能回退到无去重路径。

顺序：建立 AwaitingReady 意图 → 既有前端/目标/所有权就绪 → 原生准备及完整证明 →
原权限/目标/期限检查 → durable intent → **重新执行原权限、冻结目标、代次、取消、总/帧期限和能力检查** →
native arm/真实确认 → Broker 最终准入先登记 mayHaveSubmitted → 唯一传输入队 → 可信结果 → 结算意图。

文件事务不持有 Broker/operation 锁；最终输入准入只做内存条件和入队。
同一 submission_gate 串行化停止与提交，Broker→operation 锁顺序保持一致。
原执行器四种 accept 路径均增加 fsync 后检查，没有绕过现有权限、Job 或固定目标验证。

| 崩溃/错误窗口 | 证据与恢复 |
| --- | --- |
| intent 前 | 不登记提交；仍需独立证明草稿安全 |
| intent 已持久化、尚未 arm/accept | 记录保守保留；可能实际零次，不自动重输入 |
| 最终准入后、传输失败/回执前 | may=true；结果不明，不重发 accept |
| Started 后、结束前 | 有真实开始，结果不明；保留记录 |
| 真实结束后、业务 ToolResult 前 | 只按已有可信结束结算；缺失结果仍遵守现有 reconciliation |
| fsync 后期限/lease 变化 | 拒绝 arm/accept，保留待恢复意图 |
| 数据库真实不可用 | 断开能力、保留输入恢复门禁；没有 key 或副作用 |
| 重启/重连、旧调用重试 | 相同 call key 在 lease/source 前拒绝；换 generation/commandId 不绕过 |

真实 NIP SIGKILL 测试有两个窗口：完整原生 proof+durable intent 后、arm/admission 前；
以及实际 arm/key/Started/ONCE 副作用后、结束前。子进程被实际 SIGKILL，父进程确认 signal 9，
仅回收自己测试 SID 的孤儿进程。新 Broker+新真实 PTY 读取同一数据库，未决记录仍存在，
同调用在 prepare/键入前拒绝，新的 accept 计数为零，副作用保持零次或一次。
原始 crash/restored PTY、私有回执和元数据位于 sigkill-intent/sigkill-accepted evidence。
另有四窗口纯 journal 杀进程探针，其单独 /bin/sh 仅证明存储边界，不标为原生 E2E。

## 协议、显示和接口

正式版本、connection/operation 分层、schema、错误码、131072 帧/8192 源码/32768 计划字节上限、
1–5000ms 单调预算、请求去重、真实构建 profile 与完整证明见
[冻结协议](../../protocol/agent/runtime/native-input-v1.md) 和 [schema](../../protocol/agent/runtime/native-input-v1.schema.json)。

构建器 `scripts/native-input-p1/build.py` 从固定 GNU/P0 源码重建，不依赖时间戳目录。
manifest 同时核对源文件和 Shell/module 制品 SHA；测试拒绝陈旧制品。
正式 builtin 为 ss_native_input_v1 系列；P0 默认报文仍可独立运行。

同流正式显示键为 ShellSpanNativeInputV1；只在显式 negotiated native 模式安装公开 parser。
`closeAfterPendingOutput` 使用公开 terminal.write 回调排空后卸载；它不授予命令/ready/lease 权限。
真实半个 OSC 包 EOF 后关闭、重绑和新连接 startup off 已有 Chromium/WebKit × DOM/WebGL 检查。
排空/dispose 不重置 OSC/UTF-8 parser 状态；该用例明确依赖真实 startup off 的 ESC。
转 raw/不支持 Shell、旧代次队列/尾字节和新普通文本顺序留 P2 真实 registry 验证，不能 reset/清屏/重放历史。
旧控制器重复释放不能影响后继；raw/legacy 未安装。生产 registry 接入留 P2。

现有 `get_terminal_broker_snapshot` 返回全投影 snapshotSequence 和 inputObservation：
阶段、may、完整证明、durable intent、真实 draftCleared、输入/恢复门禁、安全提示和脱敏 displaySource。
未变化读取保留序号；owner/gate/proof 等变化不再依赖旧 legacyRevision。
Job 私有控制不含 displaySource，执行计划/摘要/原生缓冲不发给前端。
新增 `get_terminal_submission_recovery` 通过 spawn_blocking 查询；Rust command/注册、
TypeScript DTO 和 typed IPC 已对齐。

前端仅在当前 terminal ID/generation、Agent/task/operation 及新完整快照游标匹配时更新状态文字。
现有 terminal-integration-state 事件附带同源只读观察，让实际输入确认及 S/E 更新阶段，
不能用未改变的 integrationStateRevision 丢弃更高的命令快照游标，也不逐帧发起额外 IPC 查询。
新快照永不恢复 inputBlocked、terminalOwned、ready 或接管确认。
现有 role=status/aria-live=polite 保留，只报告阶段，不逐字播报。
新增中英文键完整对应，不改变状态条布局、尺寸、颜色、按钮或键盘/焦点。

## 验证记录与阶段边界

统一可重建入口：`pnpm test:terminal-input:p1`。结果与每步命令/退出码/耗时保存到
`.native-input-p0/p1-validation/summary.json`；原始实际捕获在 `p1-evidence`。
完整源码门禁结果保存在 `p1-full-baseline` 对应 final/full/build 日志。

| 验证 | 当前结果 |
| --- | --- |
| reducer/codec/journal | 9 项及 504 格；含冷启动恢复查询，另一个 subprocess helper 显式 ignored |
| Broker / executor / lease | 35 / 23 / 11 项；包括完整快照游标的门禁、lease 和 durable fact 回归 |
| 真实 NIP/1 | 13 项通过；真实 proof、非法 UTF-8、300 queries、取消/迟到/旧代次、唯一 writer/旧通道拒绝、父 Shell 环境、运行中断、真实存储失败、SIGKILL/重启、stdout 仿冒/EOF、实际 vi 模式拒绝 |
| 浏览器正式显示 | 4 组合 / 68 断言通过，原生 PTY 捕获、动态 100→32 列和真实输出；截图及摘要保留 |
| 真实旧 Bash / Zsh / checkpoint / P0 默认协议 | 1 / 1 / 2 / 45 全部通过；固定源码的原有能力回归，不代表 ZLE 新协议通过 |
| 前端状态/controller/pane/registry/旧协议 | 5 文件 134 项通过 |
| pnpm build | 通过；保留已有大 chunk/dynamic import 提示 |
| 完整 pnpm test | 2915 通过、3 个既有 AI 断言失败、6 skipped；与 P0 独立基线中的同 3 项对应，不宣称全绿 |
| 真实运行时审批/委托/存储/终端提交 | 14 项通过 |
| 完整 Rust 扫描 | 串行记录 1354 passed / 2 failed / 99 ignored；用于全量风险扫描，最终源码相关验证以 P1 入口及后续定向复验为准 |
| Clippy all-targets/all-features -D warnings | 5 个非 P1 错误：file_preview.rs 三项、preview_package.rs 一项、既有 user_question_workflow.rs 一项；P1 文件无 Clippy 错误，不宣称 Quality Gate 全绿 |
| fmt / include / diff | cargo fmt、77 个 include! 文件及 git diff --check 通过 |

统一入口 12 步退出 0；最终能力范围补充后，原生 13 项、9 项状态/存储及 16 个真实捕获文件的 schema 复验通过，显示复验为 68 项。最终源码哈希及命令日志保留在 p1-full-baseline；制品 manifest 保存实际 Shell/module 与生产者源码摘要。当前 Bash SHA-256 为 5dee075b3f45fa4e069c0ef15efd43901a033f327efa2636658027e2f94fbeb2，NIP module 为 109d05c6b45eac1cddb52a7b69a20c1f8d0b0bc63b3f2ad1e9a379d39bf7ed11。

全量 Rust 中的工具清单断言（缺少 request_user_action 期待项）在独立 P1 开始源码快照也失败。另一个旧 Zsh 展示用例有 checkpoint 时序波动，独立基线与当前源码的单项复验分别通过 10.23s / 10.30s；完整 Zsh 用例也曾在并行检查时失败，低负载串行基线及 P1 入口复验通过 97.04s / 96.77s。所有失败和复验日志保留，没有延长期限或削弱 checkpoint。上述记录不构成整个工作区、发布、其他平台或真实应用模型链路的通过结论。

P1 的新生命周期已成为旧执行器与新协议的同一权威；native 协调器仍无生产接入。
P2 才迁移应用本地/SSH 初始化、传输队列和 registry 显示；P3 实现 ZLE/PSReadLine；
P4 退役旧投影。Windows/ConPTY、Linux/SSH 新显示扩展、其他架构、用户插件及原生新分发尚未验收。
既有 legacy 支持保留，不把本机 P1 证据外推到这些路径。
