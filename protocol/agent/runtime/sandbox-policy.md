# 沙箱策略、资源授权与恢复契约

当前契约（2026-10-07）：用户批准常规原生进程沙箱。macOS 本地 Direct 在真实 Seatbelt 预检成功后可以执行，能力是 `partial / files=true / network=true / processLifecycle=false`；文件字段表示路径限制，不代表完整对象隔离。已验证的 macOS SSH Direct 也报告 partial，但不支持远端资源扩展、网络授权及非 Shell 工具，详见 remote-sandbox-backend.md。硬链接别名、同账户恶意并发修改、进程组逃离继续列为限制。Windows 实机和普通可视终端的受限执行尚未开放。

`agent_runtime_probe_native_sandbox` 为无参数 async IPC，在 blocking worker 中用专用临时工作区运行固定只读预检；不读取用户项目、不联网、不安装或授予资源。预检失败返回 unavailable。NativeAdapter 在 prepare 与 dispatch 校验最新 Header/target/bindingRevision，然后将同一冻结契约传给 NativeExecutionContext；原生内核再核对目标，受限 exec 分支固定调用 Seatbelt，不能落入 Host shell 或 reviewed Host collector。只有 Direct shell 及其 process control 开放；其他原生宿主工具在 pipeline、adapter 与 native kernel 明确拒绝。

冻结 deny 包含用户私钥、系统/应用钥匙串与 ShellSpan 存储等已知敏感路径；launcher 拒绝 .env 名称族写入，并拒绝其中除冻结项目根目录 .env.local 或明确审批的项目文件外的读取。2026-10-06 用户明确要求支持该项目配置读取；.env.local 属于基础项目策略，不签发临时 grant，不覆盖私钥/钥匙串等独立拒绝规则。系统/工具链基线只读。每个命令的 temp/cache 独立，环境仅保留 PATH/HOME/LANG 与指定临时/缓存变量，不 source login shell。进程的 stdin 持有不可替换的原始契约绑定，调用时间可以更新，身份、策略、target、bindingRevision 与路径集合不能变化；wait/kill 仍可用于自身资源清理。默认网络为 network* deny，明确 TCP 目标仅通过受控 Unix 代理访问；没有无限制 fallback。

结果 data 返回实际 sandboxBackend、sandboxContract 与 sandboxCapability。仅控制器自己的创建前验证可报告 policyRejected/notStarted；命令 stderr 的 EPERM 或普通非零退出仍不提供可信越界遥测，不自动扩权或重放。权限模式、审批和取消独立保持。

受限 Git 环境不读取系统/个人 Git 配置、不弹出凭据提示，项目内配置保留；工具 PATH 优先使用选定且位于既有只读范围内的 Xcode/CommandLineTools 工具目录。本地 NetworkTarget 使用签名资源集合中的明确公网 TCP 目标和 DNS 选择；LocalService 仅支持已接入的 Node 回环服务 relay。取消、到期及会话撤销会关闭相应代理；不授予 Shell 直接 TCP/UDP 出口。远端不支持这些资源扩展。

2026-10-06 真实模型闭环补充：受限会话的自动技能发现发布 unavailable 观察，不调用宿主 reader，不使可用的 Direct 初始化失败。任务级取消仅移除 terminationConfirmed 的进程；未确认结果返回失败并保留句柄，暂停新派发，临时数据不自动删除。控制器在本地 spawn 成功后标记 started；SSH exec 发送前为 notStarted、发送过程中为 unknown、确认后为 started。尚未发出 exec 的失败/取消不存在远端命令残留；unknown 不转成成功清理。

用户选定的默认 MiniMax-M3 已完成真实模型→审批→NativeAdapter→Seatbelt→模型结果回合，以及真实后台任务会话取消。debug-only 验收入口不新增生产 IPC，不保存或扩展凭据，只读取所选默认模型引用。

阶段 3 的 run_terminal_command.readPaths 是读取请求，不是 grant；最多 8 个现有普通文件，路径通过 canonicalize 冻结。可审批冻结项目内文件及项目外非敏感普通文件；目录、末级软链接、外部敏感／系统文件、独立凭据路径和运行时存储拒绝。该扩展仅适用于本地受限前台执行。初次资源授权要求显式审批，包括 Operator；用户可选择 once（默认）或 session。会话授权仅存内存、最长一小时，绑定冻结身份；相同文件可以复用资源授权，操作审批独立保持。每次派发仍生成 native-approved-call 的 ReadPath grants，绑定 Session/call/target 与有限有效期，不授予写入。

writePaths 仅允许本地 workspace 下最多 8 个现有账户缓存／临时具体子目录，初次批准、once/session、签名、到期和撤销规则与其他资源一致。ReadOnly、整个 HOME、公共缓存根、项目／祖先、系统、敏感及运行时存储目录拒绝。获批目录同时允许读写，不能从模型自报路径取得权限。

agent_runtime_set_sandbox_policy 与 start、NativeAdapter execute 共享会话转换锁，并复用应用共享 shutdown admission。切换要求活动根会话空闲、无待审批／队列／未完成子会话、无受影响后台／未确认进程及终端租约；提交与子会话创建在同一 store 锁下再次检查。成功更新 session/sandbox_policy_changed 及 bindingRevision，撤销旧授权和已签发能力。远端新策略必须重新通过真实后端预检；没有 Host fallback。

agent_sandbox_defaults 偏好仅保存按项目／连接绑定的 policy 和 cacheDirectories。session/cache_directory_candidates 将目录候选冻结为启动前配置数据，模型仍需申请精确 writePaths；Header、偏好与恢复不保存 live grant、有效期或 bearer。sandbox/resource_audit 记录批准／复用／撤销的 once/session、资源集合、实际期限、绑定版本和清理结果；这些元数据不能恢复权限。审计写入失败先暂停派发，再撤销能力并清理任务，清理错误保留在结果中。

远端新会话设置使用 agent_runtime_verify_remote_sandbox_target 显式验证当前 target、根和策略。界面只接受与当前请求及终端代次／连接配置匹配的最新结果，目录／策略／连接变化或 30 秒后失效；启动仍执行生产重验证。缺少根目录时复用现有目录弹框，选择目录本身不创建会话、不批准资源、不自动重放发送。

现有原生 HMAC 能力记录绑定完整契约 SHA-256 摘要，dispatch 验证原生令牌与该摘要，不能从模型自报字段取得权限。资源 authorizationId 使用独立随机引用，不暴露原生 bearer token。NativeAdapter 转交批准后的 NativeExecutionContext；Seatbelt 精确文件读取例外、前台 deadline 和单次令牌消费共同生效。恢复不复用内存能力记录，取消/绑定变化仍使旧请求失效。审批 IPC 增加可选 resourceScope；agent_runtime_revoke_sandbox_reads 停止派发、取消任务、等待中断并清除会话读取授权，清理未确认时保持停止状态。

以下阶段 1/早期阶段 2 说明保留其历史基础层含义；其中尚未开放容器派发的描述仍有效，不代表当前 macOS Direct 也不可用。

早期阶段 2 增加以下执行基础行为，当时没有开放受限派发或资源授权；当前单次文件授权见上文：

- `agent_runtime_probe_local_sandbox_backend` 是无输入的 async 只读 IPC，通过本地 Engine socket/named pipe 查询执行 OS、架构和版本。不启动容器、拉取镜像、读取项目或采用 `DOCKER_HOST`/SSH context。`infrastructureAvailable` 只表示本地 Linux Engine 可访问；`workspaceVerified` 与 `admissionEnabled` 当前均为 false，不能推导 sandboxCapability 为 full。
- Direct/process 结果的 `data` 增加 `lifecycle`、`terminationConfirmed` 和可选 `failure`；保留既有 state/exitCode/streams/handle 字段。`failure` 使用控制器事实 `{ kind, code, admission }`，kind 为 policyRejected/backendUnavailable/infrastructureFailure/commandFailed/cancelled/timedOut/terminationUnconfirmed，admission 为 notStarted/started/unknown。命令自身 stderr、EPERM 文本或退出数字不作为策略拒绝证据。普通非零退出保留原 tool completed 语义并提供 commandFailed，未知启动/清理结果不能自动重试。
- 受限工具的 notStarted 审计包含类型化 failure；原始契约、资源授权、latest Header/target/bindingRevision 校验和原生审批/取消仍然保留。资源策略拒绝不触发 Host fallback。
- 原生本地 stdin 使用独立有界输入队列，写满管道不会阻塞 deadline/stop worker；输入确认超时请求停止并明确禁止重放。Host 进程组仍不被宣称为完整沙箱后代控制。kill 未确认结束时 tool status 为 uncertain。
- Bollard 容器生命周期基础实现只接受预置不可变镜像、固定隔离配置、清理环境和专用 tmpfs；正常 stdin、输出、等待、停止、timeout 与 daemon 确认清理已实测。它尚未接入 Session 的启动派发，不能从 UI/Agent 工具启动该候选。没有新的 launch/enable IPC，当前探测不授权执行环境变化。

阶段 2 后续加入内部清理拥有记录：SQLite WAL/FULL 原子保存准备、可能已发送、确切容器 ID 回执及签名审计；HMAC-SHA256 密钥通过现有 CredentialManager 走系统钥匙串，不存入 SQLite、容器环境、日志或快照。绑定使用当前 Session header 的 sessionId、创建时间、bindingRevision 和 target/surface/policy 指纹，另绑定 daemon 身份、唯一 job/name、镜像及命令摘要。它是 cleanup custody，不是资源授权；不存原命令或 live grants，不提供签发/启动 IPC，也不由前端提交拥有证据。因此没有新增 Rust/TS/IPC 公共绑定字段，已有 failure wire 类型保持不变。

启动 caller future 的取消/截止不会丢掉协调任务。协调器有界等待 Engine 请求结果，保存回执后确认清理；已标记可能发送但无 ID 回执时，单次或有限次数 404 都保持 uncertain 与清理债务，不能遗忘或重新派发。恢复只处理签名有效、daemon/Session/名称/镜像/命令摘要与回执一致的自身资源，不按名称前缀扫描或认领其他容器。daemon 不可达、归属证据缺失、结果不确定时保留记录，不报告 terminationConfirmed、不释放仍在使用的资源。

应用配置后在后台执行恢复；退出通过幂等 ExitRequested 协调，原有 prepare_for_shutdown 在 blocking worker 中执行，Docker 请求在 async worker 中执行。主线程只通知内存停止和 prevent_exit；结束或 10 秒截止后请求退出，Exit 不重复阻塞清理。截止表示退出协调结束，不表示资源清理已确认。Tauri 的强制 restart 不能 prevent_exit，仍依赖上述原子记录在重启后清理；不恢复旧授权或执行命令。容器受限派发与 Linux 产品模式仍未开放。

容器候选的项目来源/对象边界、导入回写与 Session 派发没有开放，不是首版原生路线前提；macOS 常规 Direct 的当前实现见文首，Windows 与完整模型回合仍待验收。以上结果字段沿用 v5 的 tool/result.data，不修改 event envelope，不从恢复日志复用临时授权。

## 会话与 IPC

`CreateAgentSessionRequest`、`AgentSessionHeader` 和 `session/created.data` 增加可选的 `sandboxPolicy`：

| 值 | 意图 |
| --- | --- |
| `readOnly` | 保护项目与主机文件不被修改；后续后端允许独立最小临时写入 |
| `workspace` | 项目可读写，网络默认拒绝；专用临时与明确缓存由阶段 2 实现 |
| `host` | 使用目标账户权限；没有文件与网络隔离，不授予 sudo，不扩大结构化工具原有路径能力 |
| 缺省（历史日志） | 保留原账户权限行为；冻结调用时解释为 `host`，来源为 `legacy` |

审批仍由独立 `permissionMode` 决定。选择资源意图不修改审批模式、角色、工具集合、预算、取消或原生校验。

Rust 的 `AgentRuntime::create_session` 负责默认值。新建本地目标带有 `cwd`、`localRoot` 或 `rootPath` 项目目录时默认为 `workspace`；根目录在本机规范化，并冻结到 `cwd` 与 `localRoot`。显式受限本地意图缺少有效目录时拒绝创建。远程新会话默认 `host`。未绑定项目的普通本地终端保留主机意图；后续绑定不会静默改变既有策略。已有 ID 的幂等创建及历史续接沿用原策略缺省语义。

类型化 IPC 的 `invokeCreateAgentRuntimeSession` 原样传递资源意图，由 Rust 判断默认值与门禁。`agent_runtime_create_session` 的命令名与注册不变，改为 async command，在 blocking worker 中完成配置、目录规范化和日志创建。其他命令没有新增注册或删除注册。

`AgentSessionSnapshot.sandboxCapability` 是后端当前事实，包括 `status`、`files`、`network`、`processLifecycle` 与 `gaps`。阶段 1 报告 unavailable；当前符合目标与执行方式的 macOS 会话报告上述 partial，其他情况仍不可用。缓存快照返回时刷新后端能力事实。生命周期字段指完整后代控制能力，不取消既有进程组、Job Object 或取消能力；前端缺省不视为 full。

## 按调用冻结

`NativeToolRequest.sandbox_contract` 随调用冻结，生产 NativeAdapter 的 prepared token 保存同一契约。契约包含格式版本、`bindingRevision`、`sessionCreatedAtUnixMs`、资源意图、完整 Session target、执行方式、规范化本地项目根、读写允许列表、拒绝列表、网络意图、策略来源、冻结时间及资源授权集合。目标中的 terminal ID、target ID、远端 profile/host/port/username、目录均作为身份事实保存。Host 保留原生工具自己的路径与网络校验。

Header 的 `sandboxBindingRevision` 由项目绑定、执行方式变化、会话结束/续接事件的 sequence 更新，初值 0 可省略。冻结调用绑定创建时间与该版本；即使执行方式改变后再切回原值，旧调用仍因版本不同失效。版本从真实事件回放恢复，前端投影沿用后端事件 seq，不刷新或重建旧授权。

阶段 1 的允许列表原本仅表达意图；当前 macOS launcher 使用冻结根/拒绝集合和明确系统、工具链基线，并建立命令专用 temp/cache。该路径策略不提供完整对象保护。远端没有规范化后端，不声称本机已隔离远端目录。

冻结时间不是授权到期时间。Host 与历史调用没有新增沙箱 60 秒期限；原有操作审批 TTL 继续按原契约执行。资源授权类型单独定义 `authorizationId`、`sessionId`、可选 `callId`（本次执行或当前会话）、完整 target、`issuedAtUnixMs`、`expiresAtUnixMs`、来源及资源。校验包含开始时间、到期边界、调用与会话身份、目标变化；到期后不修改原期限、不通过审批重新冻结扩大资源。

资源授权签发、合并审批、会话撤权与进程清理属于阶段 3。阶段 1 不提供授权签发 IPC，不把授权放入会话 Header 或日志；生产冻结的 `resourceGrants` 始终为空，持久化 `sandbox/call_frozen` 明确拒绝非空 live grants。恢复只能重建策略事实，不能恢复临时授权。关闭后不接受 prepared dispatch；目标/策略/执行方式变化后已冻结调用失效。未来授权协调器须使用这些校验，不得把审计数据作为授权来源。

子 Agent 创建会继承父 Header 的策略。普通创建与 descriptor 事务两条路径均校验父会话存在、策略相同；父会话受限时主目标、全部 descriptor 目标和执行方式必须一致，审批自动化程度、工具/effect 与目标 ID 集合不能超过父能力。子角色可进一步缩小工具/effect 能力，不能借更换资源策略或目标扩大权限；不继承临时资源扩展。

## 拒绝派发与恢复

当前 `start` 在模型、技能读取、终端和工具启动前拒绝受限会话，并写入 `sandbox/start_rejected`。意图保持原值；不会静默转换到 Host。未来存在可启动后端时，工具链仍在技能、问题、会话工具、子 Agent/fleet 等内部分支之前做契约门禁；Native prepare、recovery prepare 与 production adapter execute 也执行校验。

Direct、普通可视终端、terminal input、process stdin/wait/kill、文件读写、HTTP、SFTP、部署/运维、MCP 和委派均不能从受限 Agent 派发到当前无限制工具。文件引用及技能发现的独立入口同样拒绝受限策略。用户直接操作普通终端、SFTP 或部署页面属于既有用户功能，不宣称受 Shell 沙箱保护。

NativeAdapter execute 读取最新 `AgentRuntime.session`，对比实际最新 Header target、策略、执行方式和关闭状态，然后继续原生 terminal/profile/account 校验与审批/取消机制。不会将 stored target 与自身比较当作重绑验证。

已持久化但未派发的受限审批在可运行的恢复处理路径中取消，原因 `sandboxAuthorizationInvalidAfterRestart`，剩余调用记录 `notStarted`；已经派发且结果不确定时仍保留原 reconciliation 门禁，不重放。当前受限 start 门禁优先拒绝启动，因此不会为了处理恢复而执行模型或工具。

## 模型与审计

Runtime context 包含原始策略意图、`effectiveSandboxPolicy`、来源和与 Session snapshot 相同的 `sandboxCapability`。受限后端不可用时模型工具集合清空，Operator 文案不会在该上下文宣称 Shell 可访问工作区外文件。历史来源明确报告账户访问未隔离。

`sandbox/call_frozen` 记录 call ID 与冻结契约；同一 Turn/Step/call 只记录一次。拒绝结果包含 `schedulerAdmission: notStarted`、原因、同一契约与能力事实，表示工具尚未执行，不应自动重试或推测副作用。既有 audit 脱敏继续生效。两个新增事件使用现有 v5 envelope；规范见 `event-v5.schema.json`，旧 `session/created` 无策略字段仍可解析。

前端恢复投影保留新意图与后端能力；错误通过已有 AI 错误展示路径提供中英文解释。阶段 1 不增加策略选择 UI、资源授权弹框、布局变更或后端自动安装，不开放任何受限执行平台。
