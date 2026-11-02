# Native Input Protocol

协议标识 `shellspan.native-input`，简称 NIP。
它是已登记私有双向控制通道上的独立协议，不扩展 TSP/1 或 Agent event-v5，
stdout、OSC、前端 ready 和显示完成都不是控制报文。
[schema](native-input.schema.json) 与 Rust `terminal_command/protocol.rs` 同源审查。

## 模式、身份和能力

一个终端 generation 的模式初始化后固定为 `native-inline` 或 `raw`。
不再接收或输出 `legacy-projection`，也不保留旧客户端及旧作业输入兼容分支。
历史证据只适用于采样时的源码与制品，当前验收边界见[实现说明](../../../docs/design/agent-terminal-input.md)。
不得在已有草稿或历史上热切换，不得因 native 失败改换执行路径或重放。
能力不足的新 Agent 命令在 lease/PTY 写入前返回 `TERMINAL_NATIVE_INPUT_REQUIRED`；
不自动选择替代 Shell。普通用户输入与 TUI 保留；当前后台作业的输入和管理均走已验证的原生通道。
ZLE/PSReadLine 生产编辑器 profile 仍为空；
GNU Bash 保留独立的来源匹配 catalogue、实际 Shell SHA/模块校验准入，未被该空列表关闭。
当前已完成代码、编译和静态检查，统一实机待验项见[实现说明](../../../docs/design/agent-terminal-input.md)。

初始化使用独立 `connection = {terminalSessionId, terminalGeneration, controlId}`。
`probe` 与匹配 requestId 的 `capabilities` 不需要 Agent/task/operation，禁止制造占位身份。
能力携带实际 Shell/编辑器类型和版本、编辑器数字版本、adapterVersion、verifiedProfileId，
以及 nativeInline/sourceEcho/atomicHandoff/completeProof/draftClear/inbandDisplay/editorEmpty。
缺少任一标志、构建不匹配或未知版本均不可用。当前 Bash profile 还要求实际 emacs 编辑模式、
默认 redisplay provider 和无自定义 pre-input hook；匹配版本的 vi 模式也不能得到能力。

native generation 拒绝旧集成通道注册（TERMINAL_NATIVE_MODE_NOT_LEGACY），不能覆盖原生连接身份。

原生profile按实际Shell、Readline与平台组合生成，使用`native`后缀，不提供旧profile别名。
Shell与Readline必须按构建配方的对应关系配对，实际运行范围另行验收。
受信本地加载器必须先对固定 manifest 的 Shell/module 实际文件计算 SHA-256，
产生 `VerifiedNativeProfile`；对端自报 Bash 版本不构成支持证明。
实际 `$BASH_VERSION`、Readline 公共版本/数字值与编译时 profile 仍须匹配。
当前 GNU 资源还要求 `readlineDisplayAbi: 1`，加载器与打包器拒绝缺失或未知 ABI。
该受控扩展由 Readline 自身提供只读 `rl_native_prompt_columns()`，返回其原生提示符
显示列数；原生初始化前必须实际发现该符号，Bash4.1不能仅依赖其不调用的加载钩子。
只读 ABI 查询由构建入口和启动组件共同检查；未知 ABI 不会安装原生输入接入。
不能将 `rl_expand_prompt()` 的可见字节数
当作列数，也不手工解析 ANSI 提示符。Tab 仅在同一 Shell 的回显提供器中合法展开，
真实编辑源码和执行计划保持不变。清稿必须在回执前恢复本次原生回显函数，事件钩子仍
在安全的原生服务键边界退出。新 ABI 的 GNU 构建具有独立实际摘要；不会替换已绑定的
用户可执行文件，历史 P1/P2 证据也不能自动算作该依赖修订已验收。
P3 实现了按完整源文件及实际制品摘要绑定的 ZLE/PSReadLine provider；独立平台验收仍在进行，
不能将组件回执或 P2 Bash 结果视为 P3 完成。当前证据及未完成项见
[实现说明](../../../docs/design/agent-terminal-input.md)。
SSH 制品经真实 SFTP 上传、远端读取校验与独立 relay 通道加载。其他架构、libc、
自定义输入/redisplay/信号 provider 和未校验的普通发行版构建均不能仅凭版本得到 native 能力。

## P2 生产传输与 Shell 语义

Broker 只读快照的可选 `nativePeerProfile` 保存本 generation 私有 capabilities 已实际报告、
且通过固定构建与完整能力校验的 Shell/编辑器版本、数字 ABI、adapterVersion 和
verifiedProfileId；不包含源码、执行计划、凭据或额外授权。未协商的 raw 不提供该字段。
验收应直接记录 inputMode、该实际 profile、binding 及完整证明/持久意图状态，不能仅按客户端
默认请求或测试选择的可执行文件推断 native 路径已经执行。

客户端通过 `nativeInputProtocol: "shellspan.native-input"` 请求协商；后端先验证实际绑定
Shell 的文件摘要及可信资源目录的 module/relay/source 摘要。使用独立、完整构建的 GNU
`--shellspan-native-init PATH -il` 启动：GNU 自身先按真实 HOME、login 状态和 argv0
读取系统及用户配置，随后执行固定集成文件。不得替换 HOME 或手工再次 source profile/rc。
不会把资源中附带的 GNU 可执行文件自动替换为用户绑定 Shell。scalar/array PROMPT_COMMAND
按 GNU 各版本语义保留；readonly 或不支持的 provider 配置拒绝能力。

私有控制帧进入现有每会话有界队列（8 个 credit），由所属本地 PTY/SSH worker 写入。
每条连接只有一个 NIP Decoder 和 generation；EOF、半包、超时及重连关闭旧身份与当前操作，
不会切换执行路径或重放。不提供旧客户端输入兼容；重绑到未接受的 Shell 时成为 raw，
保留普通用户终端而不取得 Agent 执行能力。

ZLE 在私有通道 EOF 后仅清理仍由本集成拥有的 hook/widget/快捷键；用户重定义的函数或绑定
予以保留。局部前缀清理必须在同一编辑线程重新读取真实 BUFFER/CURSOR，并与尚未交回父
解析器、尚未开始执行的草稿完整已应用前缀和末尾游标逐字一致。清理后须重读实际空缓冲和
零游标，才能退役本地 Enter 保护；保留曾接受及传输失败事实。此局部清理不产生 DraftCleared
回执，不能解除后端的不明状态或持久提交围栏；未观察到实际丢弃的失败交接继续禁止 Enter。

`prepareInput.job` 区分 native launch 和私有 control。control 的 handle/stop/nonce
与计划摘要绑定，`controlInputConfirmed` 证明当前真实编辑缓冲区为空。受保护的单次键只调用
固定 bind-x 组件读取规范化 TSV 元数据；不接受任何控制命令为 Readline 历史行。
GNU `SEVAL_NOHIST` 与原生 parser 状态保存保留先前退出状态及已有 history 项，
不修改 HISTSIZE/HISTFILE/HISTCONTROL/HISTIGNORE，不采用事后删除历史项。

组件执行期间仅 Readline 的空行清理/重绘写入无文件描述符的 libc cookie stream；
Bash/程序 stdout/stderr 和后台输出仍写真实 PTY。普通返回、fork 子进程、卸载和新输入边界
恢复公开输出流。默认 INT 的组件执行阶段使用初始化时捕获的 Bash disposition，并在离开时
还原 Readline disposition/mask；中断先恢复流，再交还 Bash，禁止跨 Rust 帧作非局部跳转。
这不授予自定义 signal provider 的支持。

`directory`/`jobObservation` 只更新已有目录/后台任务观察。结果捕获采用独立的、由私有
requestId 派生的同流边界；这些 stdout 标记只切分结果，不能授权提交或证明生命周期。
私有 Settled 先到时仍等待真实 PTY 捕获结束，不使用固定 drain grace 推定空输出。
有界 parser 保留程序实际打印的包装文本、提示符及 OSC；EOF 缺少结束边界时保留已观察尾字节，
标记不完整/不确定，禁止伪造空成功。既有敏感信息脱敏边界继续生效。

操作建立后使用完整 `identity`：terminalSessionId、terminalGeneration、leaseId、
leaseGeneration、agentSessionId、taskId、operationId、commandId、sourceRevision。
沿用 Broker 标识契约：ASCII 字母/数字起始，后续可用 `._:-`，总长 1–128；
三个代次/版本为 1–9007199254740991 的整数。新 requestId 沿用同一字符契约。
每个回执校验全身份、请求槽和摘要；旧身份不能修改后继，也不能让后继隔离。

`editorReady` 是连接消息，携带 editorEmpty、ownedDraftAbsent 和可空 afterCommand。
afterCommand 非空时须为完整合法身份且与连接终端代次相同；它须匹配最后实际准备的操作。
已运行操作要在可信结束后等真实编辑器重新就绪；提示符文本不够。
此消息永远不能清除 sticky recovery。

## 编码、限制和期限

每帧为一个 UTF-8 JSON 对象加 LF，总长最多 131072 字节；未知字段拒绝。
使用成熟 `LinesCodec` 和 serde_json，连接只持有一个 decoder，不能在操作交接时丢弃半帧。
一个 OS read 可含多个合法帧，其合计长度不受单帧上限限制；缓冲分块处理。
超长、非法 JSON/UTF-8 和 EOF 半帧均使控制路径失败关闭。错误不回显源码。

源码最多 8192 UTF-8 字节，非空；只允许 Tab/CR/LF 三种控制字符。
计划最多 32768 UTF-8 字节。sourceDigest 为源码 SHA-256，planDigest 为
serde_json 编码 `[sourceDigest, plan]` 的 SHA-256。两者只在后端和私有通道使用。
字节计数使用 UTF-8 字节，完整证明必须 point=end=实际原生缓冲字节数=源码字节数，
并严格解码实际缓冲，不能使用 replacement character 代替无效字节。

prepare 的 budgetMs 为 1–5000 毫秒。目标端第一次准备时建立单调期限，
resize/query/重复请求不能重置；后端还保留现有总期限、帧期限及权限/目标检查。
控制读写、停止及现有前端 ready 各保留调用方的有界等待。
Query 不占永久去重槽；prepare/commit/cancel/interrupt 各有固定一次性槽。
目标端退休操作上限 4096，达到后拒绝新准备，不驱逐旧提交墓碑，也不阻止 query/stop。

稳定 wire 错误码为 VERSION、IDENTITY、DUPLICATE_REQUEST、LIMIT、EXPIRED、BINDING、
STATE、RECOVERY_REQUIRED。后端错误以 `TERMINAL_NATIVE_*`、`TERMINAL_INPUT_PROOF_*`、
`TERMINAL_SUBMISSION_*` 区分本地身份、证明和存储失败；不包含私有报文或凭据。

## 操作顺序

| 请求 / 回执 | 行为与证据 |
| --- | --- |
| prepareInput → prepared/inputProgress/inputConfirmed | 先验证不可变源码和计划，再由编辑器线程推进原生草稿；输入不执行 |
| commit → commitArmed | 完整证明及 durable intent 之后，仅武装受保护的单次接受；私有请求本身不执行 |
| Broker Executable admission → 原生接受键 | 同一最终准入原子检查 owner/代次/取消/证明/意图/武装，并先登记 mayHaveSubmitted，再调用一次传输入队 |
| submissionAccepted → started → settled | 原生接受、固定计划首 builtin、父 Shell 真实结束各自发出；入队成功不冒充这些回执 |
| cancelDraft → draftCleared | 撤销先使旧 Agent lease 无效，只清本次拥有的未提交草稿；回执实际读取编辑器为空 |
| scoped PTY Ctrl-C | 已提交程序可阻塞 Shell 私有 reader，因此沿用既有绑定操作的 System interrupt 准入，不依赖私有 Interrupt 被及时读取 |
| query → snapshot | 只读观察，不能变成 inputConfirmed/started/settled，不重放输入 |

schema 的 `interrupt` 是通用控制请求槽；当前 Bash provider 不把它当作运行程序的停止保证，
实际协调器使用上表的 scoped PTY interrupt。
合法迟到的 prepared/progress/confirmed 在取消/终态后只验证并丢弃，不能重新输入，
也不能毒化随后合法的 draftCleared。冲突的当前绑定进入恢复；旧 generation 拒绝且不污染后继。

提交由原生编辑器在同一父 Shell 顶层返回固定计划：
`builtin ss_native_input_begin "$?"; builtin eval -- <shlex quote 的源码>`。
计划在真实源码回显后隐藏交接，不通过前端过滤。正式 builtin 只用于显式 NIP 模式。

## P3 原生编辑器与父解析器

Zsh 使用公开 module/builtin API、ZLE widget、`BUFFER`/`CURSOR`、`zle -F -w` 和
`.accept-line`。原生模块只持有目标编辑器实际缓冲观察；编辑与计时全部留在 ZLE 所在线程，
通过公开 `zselect` 对私有 FD 作有界等待。控制帧立即唤醒取消，超时推进单调期限内的输入
动画；确认完成后返回普通 ZLE 事件循环。不得在用户 Zsh 内创建时钟线程、把回调期间的
临时 mask 判为不支持或全局解开用户信号。私有连接不被 exec/fork 子进程继承。

加载器恢复原有 `ZDOTDIR` 导出状态，并由同一个绑定 Zsh 正常读取系统/用户启动文件。
首个 precmd 只安装一次集成。前台源码由 ZLE 直接交给父 Shell 顶层解析，不在 widget
函数中 eval。后台启动继续使用现有原生异步组、作业表及停止逻辑；真实源码完成显示后，
line-finish 将经过绑定的固定作业计划交给父解析器，隐藏计划期间只临时保留 WINCH 屏蔽位，
在真实 preexec、precmd 或关闭时恢复。普通用户命令及后台输出仍走同一个真实 PTY。
目标解析器先验证原始源码和完整计划；语法失败不得开始输入或执行任何前缀。

Windows 两个主机独立验证：Windows PowerShell `5.1.26100.9711` 与 PowerShell `7.6.9`，
均绑定 PSReadLine `2.4.5` 的实际程序集摘要。5.1 只在当前进程的 PSModulePath 中前置
应用私有模块目录，使用户 profile 在正确模块版本下正常运行；不修改全局安装。
7 使用原安装模块及用户配置。前端不绘制、补齐或反推源码/光标。

PSReadLine 在实际编辑器线程调用公开 `GetBufferState`、`Replace`、`AcceptLine`；严格把
真实 UTF-16 游标位置转换成 UTF-8 字节位置，拒绝不合法边界。私有双向命名管道具有当前
用户 SID 的受保护 DACL、不可继承的句柄，并双向核对真实服务端/客户端 PID。
成熟 .NET ACL API 的实际读回校验失败时关闭 native 控制。

PowerShell 前台计划是规范 JSON 元组 `['native-powershell-host', SHA256(source)]`；
后台计划绑定 `native-powershell-job`、既有不透明 handle 和源码摘要。以上表示元组语义，
实际线格式由 serde_json 编码。目标端只在准备期间通过真实 PowerShell AST/token extent
生成并固定唯一 host 行：保留 using、attribute、param 和命名 block，在第一个实际执行
block 中插入固定 begin 调用。`PSConsoleHostReadLine` 只把该行返回给真实 ConsoleHost
顶层解析器；禁止在模块或 reader 函数中执行用户源码，禁止在接受后再生成另一份计划。

实际源码回显及接受与完整证明仍绑定原始 sourceDigest/planDigest。程序集、适配器与 AST
生成器源文件均由受信 manifest 固定。返回的真实 ReadLine 源码必须逐字匹配该草稿；
不匹配时关闭控制并拒绝交接，不能把已经接受过的被修改源码退回普通执行路径。
捕获开始标记在交给 ConsoleHost 之前写入，因而 param 默认表达式、校验及其他正文前输出
仍被捕获。Started 只在实际首个 begin 调用发生后发出；正文前失败可以只有真实 prompt
结束观察，不能制造 Started。Settled 仍等待真实 PTY 捕获结束，不以私有回执推断尾输出为空。

`editorOptions` 仅从已登记连接更新实际 interactiveComments/nativeJobs 观察。它不建立
原生能力、不授予执行权限，也不替代完整证明、持久意图、实际结束及 editorReady。
私有 poll/stop 在真实空编辑器内直接调用已有固定作业 helper，不作为可见输入或历史行。
保留原 prompt 的失败状态、LASTEXITCODE、Error 集合及用户颜色/预测配置；内部恢复失败
状态只使用函数局部机制，不全局吞错或清除 Error。

## 持久化与恢复

目录名不表达数据库版本：当前使用 `terminal-submissions/intentions.sqlite`，版本仍由
SQLite格式字段和意图记录格式校验。若检测到其他`terminal-submissions-`命名空间，首次后台初始化必须返回
`TERMINAL_SUBMISSION_JOURNAL_MIGRATION_REQUIRED` 并拒绝新提交；不能通过创建空的新账本
忽略可能已提交的记录或重复调用围栏。该检查也拒绝同名前缀的文件或符号链接。
这一路径不创建旧目录，不自动移动、合并或改写旧记录；恢复须明确处理旧存储。

`terminal-submissions/intentions.sqlite` 使用 SQLite WAL、synchronous=FULL，
schema user_version=1；Unix 目录 0700、数据库 0600，拒绝 symlink/未知格式，运行打开不 CREATE。
Runtime configure 只登记固定绝对路径，不执行文件/SQLite I/O；首次 native 工具后台任务或
恢复查询的 spawn_blocking 才串行完成初始化与恢复记录读取，之后不重新创建丢失的数据库。
源码、摘要、包装、审批凭据和控制端点不写入数据库。
记录只有 version、完整 identity、noAutoReplay=true 及内部 settled 标志。
唯一 call key 为 SHA-256(JSON([agentSessionId, taskId, operationId]))，即使重连、换 lease、
换 commandId 或已结算，同一已记录调用也不能再次进入输入。已取消且尚未记录的草稿不冒充提交记录。

顺序为：完整证明 → 原权限/目标/期限检查 → FULL 事务提交 → 再次检查相同权限、冻结目标、
代次、取消、总/帧期限和能力 → 武装/确认 → 最终 Broker 准入 → mayHaveSubmitted → 单次入队。
文件 I/O 不持有 Broker/operation 锁；共享 submission_gate 串行化执行器、协议协调器与停止。
即使存储成功后期限已过，也保留记录且拒绝提交，等待明确恢复。

只有可信结束、受信源码拒绝或本操作未提交草稿的真实清理证明可以结算意图；
释放 lease、删活动对象、输出文字、前端排空、普通 prompt 或仅取消请求都不能结算。
原生停止在约定期限内没有可信确认时，同一Broker锁内保留恢复门禁并将CancelRequested
转为Uncertain（已可能提交）或RecoveryRequired（未提交）。此转换不标记ended，不生成
清除或结束证明。已可能提交的Uncertain操作可记录迟到真实Started且保持Uncertain；只有
匹配的可信Settled才能随后更新真实结束事实，不能因收到Started恢复输入或自动重放。
结果不明可结束调用方的这次等待，但不能据此结束仍未确认的原生操作。执行器须保留原始
coordinator、捕获围栏和正在撤销的lease，让同一操作的迟到私有回执继续接受完整身份校验；
不能因Unknown提前退登记、删活动操作或归还用户编辑权。显式关闭终端仍清理该登记及进程。
未结算记录经 `get_terminal_submission_recovery(agentSessionId)` 的 spawn_blocking 只读查询；
新引擎对首次后台初始化时恢复出的该 Agent 未结算记录保留恢复门禁，其他 Agent 不因该查询被无差别阻塞。
同进程仍由原有 Broker/交互准入和结果不明规则控制，不能把正在运行的 live intent 误作重启恢复，
阻断已确认开始的程序退出输入。查询仍完整返回 live/恢复两类未结算记录。
不自动恢复旧 command 对象、不自动重新输入或 Enter，也不声称跨进程 exactly-once。

## 快照和前端

`get_terminal_broker_snapshot` 返回固定 inputMode、显式 nativeDisplayBinding、
inputObservation。现有 `terminal-integration-state` 事件也可附带同一只读 inputObservation，
使实际 Prepared/输入确认/S/E 到达后阶段及时更新，不额外拉取每帧快照或授予输入。
后者包括全投影 snapshotSequence、pending/recovery/clear/unavailable，
以及可选 activeCommand：phase、legacyState/revision、mayHaveSubmitted、fullInputConfirmed、
submissionIntentDurable、draftCleared、Agent/task/operation/command 与 lease/source 版本、
sourceMayBeEnqueued、executionEvidence、safeActions、脱敏 displaySource、noAutoReplay。
Job 私有控制没有 displaySource。私有计划/摘要/原生缓冲和凭据不进入 DTO。

原生ZLE Core使用[append API](native-zle-append.md)，由严格绑定的实际Core
声明owned光标行重排；参数只控制显示模式，不能产生提交、清稿或结束证明。

P3 受控候选的 `nativeDisplayBinding` 可选只读 `unicodeVersion: "11"`，仅由本地已校验
ZLE Core/profile 提供，并经相同后端生成函数传入快照与 Session PTY DTO。它不是 NIP peer
自报字段、客户端请求选项或执行许可；缺省时保持原有显示配置。完整显示作用域与恢复规则见
[原生显示接入](../../native-input-display.md)，各平台启用门禁见[实现说明](../../../docs/design/agent-terminal-input.md)。

snapshotSequence 覆盖整个公开 session 投影，变化才递增，相同读取保持相等。
legacyRevision/integrationStateRevision 只对应各自状态，不用于合并整个命令观察。终端 ID/代次、当前 Agent/task/operation 及游标
共同防止前端旧观察回退。快照只能派生现有状态条文字；不能改变输入锁、所有权、ready、
审批、接管确认或后端恢复门禁。safeActions 是提示，执行操作仍重新授权。

正式显示 binding 为 OSC 1337：`SetUserVar=ShellSpanNativeInput=MQ==` 开，
`SetUserVar=ShellSpanNativeInput=MA==` 关，BEL/ST 由 xterm 公共 parser 处理。
只在已协商 native 模式显式安装，沿用真实 PTY 顺序。
完整输出排空后调用 closeAfterPendingOutput/dispose，再允许该 Terminal 重新绑定；
它只恢复公开显示选项，不重置半个 OSC/UTF-8 parser 状态，不产生执行/所有权证据。
当前 native 重绑依赖真实 startup off 的 ESC；转 raw/不支持 Shell 及旧代次尾字节顺序须在 P2
真实 registry 中验证，不能 reset/清屏/重放历史。详见 [显示协议](../../native-input-display.md)。

## 验收入口

`pnpm test:terminal-input:p1` 从固定源码重建模块，运行 reducer/Broker/执行器/lease、
真实 PTY/私有 socket、原生 SIGKILL 恢复、实际捕获的 schema 校验、浏览器排空/重绑，
以及能力缺失、未验证编辑模式拒绝和前端回归，不再调用已删除测试或旧实验报文用例。
输出在 Git 忽略的 `.artifacts/tests/native-input-p0/p1-validation` 与 `p1-evidence`，无时间戳依赖。
504 格状态矩阵是纯 reducer 证据；journal probe 的单独 `/bin/sh` 不是原生链路证据。
原生崩溃证据必须来自实际 prepare/proof/intent/arm/key/Started 链路及重启后的零输入/零 accept。
