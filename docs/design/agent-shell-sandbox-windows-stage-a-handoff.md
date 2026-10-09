# Windows sandbox 阶段 A 验收交接

日期：2026-10-07（Asia/Shanghai）。结果：**NO-GO，阶段 A 未完成验收；不得启动 B**。
2026-10-08 续作：[新对象权限与两阶段启动记录](agent-shell-sandbox-windows-stage-a-2026-10-08.md)。自有 output 新对象工作流及暂停 primary 身份/Job 已通过；受限子进程 loader 仍以 0xc0000022 退出，阶段 A 仍未通过。以下保留本次原始结果。
设计：[首版设计](agent-shell-sandbox-windows-v1-design.md)。前序会话：`01a116f1-2d8e-7070-8a10-a2d38102f7f3`。

## 2026-10-09 当前状态（后文为历史快照）

### Git锁文件前缀检查定位与相对git-dir否证

核对精确Git-for-Windows v2.55.0.windows.3 path.c safe_create_leading_directories_1：逐个绝对目录前缀stat，失败后mkdir，失败返回SCLD_FAILED；ref backend在锁文件打开之前将该失败报告为unable to create directory。历史固定prefix实测C盘根和ProgramData属性/open均5，而fixture/output属性与身份正常。源码与反例共同支持祖先metadata门禁这一解释，但未观察实际Git syscall，仍为推断。来源：https://raw.githubusercontent.com/git-for-windows/git/v2.55.0.windows.3/path.c 。

固定GitRelativeInit临时 --git-dir=. 对照helper PID21764终止退出0，fixture47aa91a6-3ddf-47ab-b986-b02dbfd7f28e，Git仍将HEAD解析为绝对路径并退出1，同样的目录失败；repository_verified=false。无祖先ACL变更。失败的相对参数已从固定命令移除，回执保留单次实验事实；独立恢复debt空，OS账户/profile/hive/服务缺席。新增实际失败/清理绑定回归。不能继续用参数变体宣称Git兼容；后续需要选择可追踪的最小祖先metadata权限方案并验证读/枚举/写负例，或明确调整工具兼容设计。A/B未完成。

### Git init限定搜索边界仍在HEAD锁文件创建失败

固定GitBundleInit显式环境增加仅本轮冻结fixture的GIT_CEILING_DIRECTORIES，不继承宿主配置、不修改祖先ACL；官方语义只限制repository搜索，不提供文件访问权限：https://git-scm.com/docs/git/2.31.0 。新增单次GitCeilingInit实测helper PID5724终止退出0，fixture42f83b20-a807-47b2-9d81-06afebd5571f。实际Git退出1，stderr为 cannot lock ref HEAD / unable to create directory for owned output/HEAD；repository_verified=false。不能将helper0认定Git成功，也不能称搜索边界修复兼容性。独立恢复profile/account/filter全退役、debt空，OS账户/profile/hive/服务缺席。新增实际失败与清理绑定回归；下一步需核查Git锁文件目录检查与实际文件权限路径，A/B未完成。

### 三项恢复结果补齐明确账户/profile缺席证据

固定InspectOnly增加account_absent/profile_absent，不再仅依赖综合retirement_consistent_with_os。再次实际提权只读查询三个精确fixture，账户/profile/hive/原服务全部缺席、记录与OS一致，保存post-reboot-explicit-os-audit.json；新增实际三项唯一身份/明确缺席回归。三项历史债务已解除，不需要再次重启。另核查本机为Windows11家庭版/26200；微软官方Windows Sandbox文档明确Home不支持，故该替代不能直接用于本机验收，未变更隔离架构或安装功能：https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/ 。DNS与完整A/B仍未完成。

### 重启后第三方确认三项崩溃槽位已精确回收

实际启动时间2026-10-09T21:21:59.5+08:00，三项profile均不再Loaded。首个恢复38152c76-2f12-44c2-b993-c26493c3f667服务已终止/退役，但在独立文件撤销后误要求原子进程清理确认，未释放账户/规则。修复仅允许 recovery_executed、固定controller workload、冻结fixture/root且独立files_retired全部成立时进入profile生命周期清理；最终缺席之前不设置LPAC清理完成。保留namespace/station、进程停止、trace及hive/profile身份门禁；不伪造child确认。

fixed recovery helper PID15668稳定句柄终止退出0，恢复服务289487b2-13a6-41f1-a646-e3c73f31ecdd、b1406ae7-b36b-4622-8288-bb2fcbc1580e、5427251b-f6a9-409b-990a-5f2dab0839c6依次完成。独立InspectOnly核验三个fixture recorded_retirement/retirement_consistent_with_os/hive_absent/profile_not_loaded/original_service_absent均true，见[OS核验](evidence/windows-stage-a-2026-10-09-post-reboot-final-os-audit.json)与[恢复结果](evidence/windows-stage-a-2026-10-09-post-reboot-fixed-recovery.txt)。三项历史hive债务解除；上文旧债务状态仅为历史记录。241项默认测试通过/15忽略，Clippy通过；A/B其他范围仍未完成，生产unavailable，未提交/推送。

### 阶段验收记录与诊断能力分支同步

核对 A1-A8/B1-B8：仍缺真实项目/工具完整范围、完整网络与服务代办/跨槽/恢复矩阵，B设置/broker认证、typed IPC、账户池、事务和完整恢复未实施，不能由固定诊断通过替代验收。核对表补齐两轮 instrumentation DNS证据及第三项 hive债务。默认无网络与临时 internetClient 对照通过独立固定枚举及共享能力选择函数区分；新增冻结分派/不接受追加能力文字/无网络变体不得取得 internetClient 回归。微软 DnsQueryEx 文档将87列为请求/结果初始化或版本错误，不能据此归类明确权限拒绝：https://learn.microsoft.com/en-us/windows/win32/api/windns/nf-windns-dnsqueryex 。现有DNS门禁保持失败，A/B保持未完成，未提交/推送。

### 无 internetClient 的 instrumentation 对照仍不能认定 DNS 隔离

新增独立固定 DnsRpcInstrumentationDefaultProbe/CLI 与单次脚本 case；只使用 registryRead + lpacInstrumentation，不加入 internetClient，保持包/账户/RPC 规则、暂停进程身份与 Job 校验、保护 trace 意图及恢复门禁。没有修改默认策略或原有 internet 对照。

实际 helper PID28576 同一持有句柄终止退出0，fixture54fc0ad2-7b2e-46aa-9266-ad818b4a8d06/SID1136。[实际回执](evidence/windows-stage-a-2026-10-09-dns-rpc-instrumentation-default-system-profile.json)root PID3252，provider 注册/注销0、实际能力及 Low/LPAC/Job 验证通过。客户端 trace 0事件/lost0、实际 buffers2/max4；root/leaf DNS cache-only及 UDP/TCP返回87，numeric local正对照0，接收器无流量。注册成功消除了此前注册5这一差异，但零事件不证明没有RPC调用，87仍不是授权拒绝，DNS门禁继续失败；与internet对照的8对LRPC事件不同，不能推断已定位失败所在层。

[恢复回执](evidence/windows-stage-a-2026-10-09-dns-rpc-instrumentation-default-system-recovered-profile.json)trace/RPC/package/account规则、profile/account全退役，debt空；[OS核验](evidence/windows-stage-a-2026-10-09-dns-rpc-instrumentation-default-system-os-audit.json)账户/profile/hive/服务全缺席。新增实际观测回归，禁止将87或空trace当作隔离通过。既有1063/1065/1134三项hive债务仍待手动重启后恢复；A/B未完成，生产unavailable，未commit/push。

### 限定 instrumentation 对照捕获 LPAC 的实际 LRPC 调用

新增固定DnsRpcInstrumentationInternetProbe入口与Cli，无任意能力/命令参数；独立诊断增加既有允许的lpacInstrumentation，保留registryRead+固定internetClient对照、账户/RPC/包阻断规则及精确Token/Job/Low/LPAC验证。默认启动策略及原DNS诊断能力集合未改变；新variant仍走完整固定矩阵，不归类为单工具成功。

固定DnsRpcInstrumentationInternet helper PID31404终止退出0，fixturec3030043-0f04-425d-b443-1460011e4352/SID1135。[实际回执](evidence/windows-stage-a-2026-10-09-dns-rpc-instrumentation-internet-system-profile.json)rootPID27604的RPC provider注册0/有效handle/注销0，trace交付8对同activity关联事件，全部interface45776b01-5956-4485-9f80-f428f7d60129、operation4、RPC_PROTSEQ_LRPC、RPC完成status0。异步完成可能换thread，关联按activity/PID，不能要求同thread。NumberOfBuffers2/Max4、lost0、停止后缺席。观测的是整个固定root测试窗口，包含cache-only及正常DNS对照，尚未逐请求绑定哪个RPC pair对应网络查询；不能把全部8对都称为网络发送。

RPC账户block在Resume前已查询验证，但DNS UDP/TCP仍完成0/固定答案，receivers各2条、TCP sender2244，网络矩阵失败。这只证明本机新增能力诊断中的此路径未被当前规则阻断，不推断全部本机RPC过滤行为或无instrumentation请求的完整路径。新规则/trace/account/profile/hive/服务全部退役、debt空；既有三项hive债务未处理。新增实际8对关联/注册成功/精确身份与网络失败保持、完整恢复绑定回归，新variant覆盖固定dispatch测试；locked默认测试238项通过/15项忽略，Clippy与格式检查通过。下一步需要服务入口授权条件与固定请求粒度证据，DNS隔离及A/B仍未完成。

### 重启后脚本完成判定覆盖新增 trace/RPC/包资源

Get-FixedRecoveryEligibility不再只依赖profile/account/账户filters与credential标志：存在package_network_intent/rpc_network_intent/rpc_trace_intent时，对应removed必须为布尔值，false只能进入待恢复而非完成；无intent却removed=true、非对象intent及非布尔完成字段拒绝。trace recovery STOP标志还须有trace intent、明确缺席和recovery_executed上下文。旧回执缺失这些可选字段仍兼容；细粒度身份/OS验证继续由原生保护回执流程完成，脚本不能自行授权任意资源。

recorded_retirement也要求整体结构有效，避免恶意或损坏的额外资源字段在eligible=false时仍被显示为“记录已完成”。新增三类资源部分完成/完成/无意图伪造及orphan STOP回归，PowerShell7与5.1均通过；未创建新OS资源。三项hive仍待操作者手动重启后恢复，DNS隔离及A/B未完成。

### PowerShell 恢复查询明确拒绝访问失败与非规范标识

Get-FixedHivePresence在函数局部强制ErrorActionPreference=Stop，避免普通调用者Continue时.NET方法访问拒绝产生非终止错误/空值后继续运行；finally仍关闭实际打开的key。SID使用大小写敏感完整字符串边界、四项规范UInt32和非零RID，拒绝前导零/溢出/换行/路径。服务查询同样局部Stop，并拒绝末尾换行的会话名；枚举失败不能继续返回缺席。

现有就近脚本回归增加这些非规范输入，在PowerShell7和Windows PowerShell5.1都通过。[实际访问拒绝证据](evidence/windows-stage-a-2026-10-09-hive-query-denied-fail-closed.json)普通调用者Continue查询SID1063，捕获System.Security.SecurityException、无presence返回；不把错误或null转成缺席。没有修改账户/hive/service权限，也没有新诊断资源。三项hive仍待重启后固定恢复、DNS隔离和完整A/B仍未完成。

### 真实 SYSTEM 自终止后的 RPC 会话退役通过，第三项 hive 债务新增

首轮RpcTraceServiceCrash fixturedaa536ea-b32a-4869-b607-587947a000ee/SID1133/helper11776未到崩溃点：SYSTEM会话自动带EVENT_TRACE_PERSIST_ON_HYBRID_SHUTDOWN，live校验拒绝，随后正常停止执行树/会话并回收全部资源。不能将helper退出0算作故障注入通过。启动改为显式EVENT_TRACE_STOP_ON_HYBRID_SHUTDOWN，保持已有严格内存/buffer门禁。

第二轮RpcTraceServiceCrashStopHybrid fixtureda9f4011-394d-4a24-8d8d-c63acecce63b/SID1134/helper10660终止退出1。[崩溃回执](evidence/windows-stage-a-2026-10-09-rpc-trace-service-crash-stop-hybrid-system-profile.json)SYSTEM、实际LPAC与4个Job成员验证通过，trace意图已保存/启动，service_crash_checkpoint=true；[服务回执](evidence/windows-stage-a-2026-10-09-rpc-trace-service-crash-stop-hybrid-system-service.json)实际进程终止确认、SCM退出1067且服务移除。原RPC trace未标记退役，第一次恢复因账户hive加载而停止。

将独立trace退役提前到已验证固定恢复服务、禁用账户及no_account_processes后、profile API重获前，保留全体原进程停止/精确会话查询/句柄STOP/缺席门禁。新增rpc_trace_recovery_stopped，只在真实STOP成功并确认缺席后标记，必须有recovery_executed/intent/trace_removed；已缺席的幂等恢复不伪造STOP。[固定独立恢复](evidence/windows-stage-a-2026-10-09-rpc-trace-crash-independent-recovery-after.json)helper11132结束0，实际STOP与session缺席均确认；恢复服务仍以1066/2报告profile失败，helper0仅表示独立trace检查完成，不是完整账户恢复。原intent保持一致，account/profile/filters未退役，hive债务保留。

[当前三项债务只读核验](evidence/windows-stage-a-2026-10-09-three-hive-debt-state.json)：1063、1065、1134全部禁用、profile Loaded=true。普通权限HKU查询访问拒绝，记录presence=null及错误，不能当作缺席；1134此前提权独立恢复OS核验已确认HKU存在。重启后固定恢复清单增加精确UUID/SID1134，不自动重启、不强制卸载hive；已请求操作者安排手动重启时机。新增实际崩溃/trace退役成功但hive失败保持隔离的回归、提前伪造STOP完成拒绝；locked默认测试237项通过/15项忽略，Clippy与格式检查通过。完整B6及A/B未通过，DNS隔离仍未解决。

### RPC 崩溃会话精确退役路径已实现，实机故障注入仍未验证

新增recovery_processes只读门禁：意图UUID/固定会话校验后，原owner和target都必须Absent/PidReused/Terminated，任一Alive或查询未知错误拒绝。退役API要求调用者已验证受保护回执、完整执行树停止并保留offline身份保护；查询精确名称与GUID/内存模式/实际buffers后，使用Wnode.HistoricalContext返回的会话句柄STOP，避免以名称再次定位另一个会话；STOP后独立缺席查询成功才返回。依据[WNODE_HEADER官方说明](https://learn.microsoft.com/en-us/windows/win32/etw/wnode-header)，HistoricalContext输出会话句柄。

Profile恢复在no_account_processes门禁后接入：仅recovery_executed且trace未标记退役才允许处理活会话，先复核原进程停止并save计划，再调用精确退役；已退役会话重现拒绝，不隐式删除。成功后沿用缺席checkpoint，随后才能释放profile/account/网络规则。未知或STOP失败继续保留债务。新增仍活controller在QUERY/STOP前拒绝回归，并覆盖owner已不匹配但target仍活的拒绝；locked默认测试236项通过/15项忽略、Clippy与格式检查通过。

尚未运行真实controller异常终止后活ETW会话退役；当前证据仅证明实现及负向门禁，不证明该恢复路径实机成功。下一步固定故障注入/受保护回执/原进程终止/独立恢复与资源核验。DNS隔离与A/B仍未完成，生产unavailable。

### RPC 缓冲池实机预算与原进程存活只读核验

新增 ProcessIdentity::observe_lifetime，以PID打开限定query/synchronize句柄，复核创建时间并零超时等待；区分Absent/PidReused/Terminated/Alive，只有OpenProcess的ERROR_INVALID_PARAMETER表示当前PID缺席，其他错误不视为停止。该接口不终止任何进程，也不构成回执授权；原owner/target停止门禁后续才能用于恢复。实际当前进程Alive、创建时间替换时PidReused与缺失身份拒绝测试通过。

纠正前文仅配置Minimum2/Maximum4就声称最多4 buffers的限制：根据[EVENT_TRACE_PROPERTIES官方说明](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties)，ETW可能按逻辑处理器数提高最小值并提高最大值。新增EVENT_TRACE_NO_PER_PROCESSOR_BUFFERING；live QUERY和STOP返回结构均验证固定GUID、内存模式、16KiB及Minimum/Maximum/NumberOfBuffers均在2..4，启动不再仅凭配置值通过。只允许已知STOP_ON_HYBRID_SHUTDOWN附加位，其他mode仍拒绝。

固定BoundedBuffers helper PID20380终止退出0，fixture206fe99f-4268-49da-8761-1b261402e751：[普通回执](evidence/windows-stage-a-2026-10-09-rpc-trace-bounded-buffers-control.json)原生返回NumberOfBuffers2/MaximumBuffers4，关联RPC两事件、lost0、停止后session_absent=true。新增超预算拒绝及实际buffer值回归；locked默认测试235项通过/15项忽略、Clippy和格式检查通过。未做活controller崩溃注入或授权STOP，LPAC DNS隔离仍失败，A/B未完成。

### LPAC 固定 RPC provider 原生注册返回 Win32 5

新增限定RPC provider的EventRegister/Unregister观测，不写事件、不修改ACL。报告固定GUID、注册码、handle是否非零与注销码；成功必须有效句柄并注销0，失败必须零句柄且无注销。接入既有固定RPC绑定诊断的可选字段，历史回执仍兼容；注册失败只表示观测能力受限，不作为RPC或网络拒绝证据。普通测试实际注册/注销0。

固定DnsRpcProviderRegistration helper PID20196稳定句柄终止退出0，fixturefe5d9d4d-c957-4808-84bd-038a938b954e/SID1132。[LPAC回执](evidence/windows-stage-a-2026-10-09-dns-rpc-provider-registration-system-profile.json)RPC provider6ad52b32-d609-4be9-ae07-ce8dae937e39注册5、handle零、无注销；客户端trace仍零事件/无丢失/停止后缺席，DNS UDP/TCP仍完成0并收到自有请求。该证据确认直接注册能力受限，支持客户端trace存在盲区；没有证明RPC运行时内部的具体注册路径或服务入口，更不能由零事件断言无RPC。

新账户/profile/hive/服务、trace/RPC/包/账户规则及credential均退役、debt空。新增原生正对照、伪造成功/错误注销/替换provider与实际LPAC注册失败保持DNS失败矩阵回归；locked默认测试233项通过/15项忽略、Clippy与格式检查通过。脚本的DnsSenderIdentity分支恢复为精确单case比较，避免与新增case集合混淆。下一步需选择有明确来源绑定的服务入口观测或授权诊断，仍不改全局provider/service ACL；活会话故障恢复及A/B继续未完成。

### 受保护 RPC trace 意图已接入固定 LPAC DNS 实测

ProfileReceipt增加可兼容旧回执的rpc_trace_intent/rpc_trace_removed；既有受保护publish先校验意图。固定DnsRpcBlockInternetProbe在实际user/package/capabilities/Low/LPAC与Job门禁通过后，从暂停root句柄冻结PID/creation，先save意图再StartTrace，最后Resume。最终执行树观测后、释放root句柄前排空/停止trace；独立原生缺席查询成功才save退役状态。profile/account/身份规则释放前必须有trace退役；恢复时重新查询，活会话或未知错误保留offline资源，不凭历史checkpoint放行。尚未实现活会话崩溃后的授权STOP，不能视作完整B6。

固定DnsProtectedRpcTrace helper PID17132稳定句柄终止退出0，fixture604b2961-2eac-474c-b3b9-8675162e3d00/SID1131：[回执](evidence/windows-stage-a-2026-10-09-dns-protected-rpc-trace-system-profile.json)绑定ownerPID26660/creation134359976810932944、targetPID8808/creation134359976829196092，Resume前trace启动通过。客户端trace交付0条事件，lost0、consumer关闭且session_absent=true；仅证明本次观测没有交付事件，不能证明无RPC调用。与此同时root/leaf DNS UDP/TCP完成0并有固定答案，receiver各收到2条、TCP socket发送PID2244，DNS矩阵继续失败。普通正对照已有LRPC事件，LPAC差异需继续核验provider注册/实际服务入口，不能因空trace判网络隔离通过。

[恢复回执](evidence/windows-stage-a-2026-10-09-dns-protected-rpc-trace-system-recovered-profile.json)保留原intent，trace/RPC/包/账户规则、profile/account均退役、debt空；[OS核验](evidence/windows-stage-a-2026-10-09-dns-protected-rpc-trace-system-os-audit.json)账户/profile/hive/服务均缺席。新增禁止profile/rules提前释放、无intent伪造完成、会话名替换及实际空观测/DNS失败/清理绑定回归；locked默认测试231项通过/15项忽略，Clippy与格式检查通过。A/B未完成，生产unavailable。

### RPC 观测意图绑定实际 PID 与进程创建时间

新增 deny_unknown_fields 的 RpcTraceIntent/ProcessIdentity：version1、自有 fixture/session GUID、固定派生会话名称、controller owner及target的PID+GetProcessTimes创建时间。禁止自由 provider/event/endpoint/command 字段。start_bound 从仍持有的target句柄复核PID/创建时间，并复核当前controller owner；外部不能再使用单独PID的start入口。PID复用、owner创建时间替换、target替换、会话名/UUID替换、缺失身份及未知配置均有拒绝测试。此记录的结构校验不是授权来源；仍须写入受保护所有权回执、验证实际Token/Job及实现恢复门禁后才能接入admission。

固定BoundIntent普通自身控制 helper PID31008终止退出0，fixturef41327c0-9d03-4a1f-9ba4-f0f5efabe86d。[实机回执](evidence/windows-stage-a-2026-10-09-rpc-trace-bound-intent-control.json)owner/target PID31284、creation_time134359974494123148一致，start前绑定复核通过；RPC关联两事件、无丢失，停止后原生session_absent=true。此intent在诊断结束后交付，尚非StartTrace前持久化journal，不视作B6。新增真实句柄身份与实机intent绑定回归；locked默认测试229项通过/15项忽略、Clippy与格式检查通过。下一步仍为保护回执发布/故障注入及精确授权退役，再验证LPAC DNS路径；A/B未完成。

### RPC 会话原生精确查询与停止后缺席确认

会话 Wnode.Guid 绑定自有 fixture UUID；新增固定派生名称的 `session_absent`，只将 ControlTrace QUERY 的 ERROR_WMI_INSTANCE_NOT_FOUND 视为缺席，其他错误保留。存在时验证 GUID、仅实时内存模式、无文件名 offset 与16KiB buffer；finish 停止并排空/关闭 consumer 后再查询缺席，不能只凭 STOP 成功置清理完成。依据 [ControlTrace 官方文档](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew)，QUERY返回属性，INSTANCE_NOT_FOUND表示会话不运行。

首轮 live query 校验失败，保留 schema 诊断 stderr：GUID一致/Buffer16KiB/fileoffset0，但 LogFileMode4194560 包含 SDK EVENT_TRACE_STOP_ON_HYBRID_SHUTDOWN。异常路径 Drop 尝试停止，限定 ShellSpan-RpcClient 前缀枚举未见遗留；不视作崩溃恢复通过。校验仅容许该已知附加位，增加文件模式/offset/UUID替换拒绝测试。固定 NativeQueryVerified 对照 helper PID28408终止退出0，fixture9fd527fe-994e-4581-a471-578f4f20c236：[回执](evidence/windows-stage-a-2026-10-09-rpc-trace-native-query-verified-control.json)原生 live查询通过，finish明确session_absent=true、无丢失，并交付普通DNS的同接口operation4/LRPC关联两事件。脚本保留 native stderr，成功/失败文件均阻止重复覆盖。

新增实机缺席证据回归；locked默认测试226项通过/15项忽略，all-targets Clippy通过。尚未实现持久化会话intent及异常终止后的授权退役，也尚未接入LPAC DNS；后续须继续这些门禁，A/B未完成。

### 固定自身 PID RPC 实时观测已交付普通 DNS 正对照

新增 `rpc_trace` 原生诊断模块：随机自有会话名、固定 RPC provider、单个指定 PID + 固定事件 5/7 filter、16KiB buffer/最多4 buffers、64条内存事件预算，不写 ETL。回调再次校验 provider/PID/version/长度，只复制接口 GUID、操作号、协议、状态与关联标识；地址/endpoint/options 不保存。未知 schema、其他 PID、预算溢出、事件丢失或 consumer 终止未确认均失败；停止会话后等待 consumer 排空，再关闭 consumer。此模块尚未接入 LPAC admission；调用者必须以已验证且持有的进程句柄绑定 PID，并先补齐持久化会话所有权与崩溃恢复，不能以 Drop 尝试清理替代 B6。

普通权限实际 StartTrace 返回 Win32 5，未创建会话。固定无参数 binary/script 提权自身 PID 正对照 helper PID11236 稳定句柄终止退出0，fixture bd4ad9c6-864b-4b2a-98d6-66266a3e547d，观测 PID26224。随机自有名称的同步 cache-only DNS 返回9701；[实际回执](evidence/windows-stage-a-2026-10-09-rpc-trace-self-control.json)交付同 activity/thread 的 start/stop：interface45776b01-5956-4485-9f80-f428f7d60129、operation4、protocol3（本机 SDK RPC_PROTSEQ_LRPC）、RPC status0；没有丢失，会话停止/consumer关闭成功。随后 `logman query ShellSpan-RpcClient-bd4ad9c6864b4b2a98d666266a3e547d -ets` 返回 Data Collector Set was not found。只证明本机这个普通对照的 RPC 路径及观测可行，不证明此前 LPAC 请求经过同接口或 RPC_UM，更不能视作 DNS 隔离通过。

新增固定 schema/不导出地址、未绑定身份拒绝、PID异常与预算溢出、实际两事件关联及 SDK协议绑定回归。限定 ignored 自身会话测试在普通权限明确失败（StartTrace5），提权验证使用独立固定 binary，不运行全部 ignored。最终 locked 默认测试224项通过/15项忽略，all-targets Clippy、fmt及diff检查通过。下一步为保护回执与会话精确恢复，再接入固定 LPAC DNS 诊断；A/B未完成、生产 unavailable。

### RPC 入口诊断准备：本机 provider 元数据确认

只读读取本机 Microsoft-Windows-RPC provider，GUID 为 6ad52b32-d609-4be9-ae07-ce8dae937e39。固定事件 5/6 的 version 1 template 包含 InterfaceUuid、ProcNum、Protocol 和认证字段；7/8 包含 Status，2 为 RPC firewall 阻断事件。保存[限定元数据证据](evidence/windows-stage-a-2026-10-09-rpc-provider-catalog.json)，没有创建 trace session，也没有采集调用事件。该证据不能证明 Dnscache 使用 RPC、经过 RPC_UM 或受到该层过滤。

后续诊断应在已验证的候选暂停进程获得 PID 后、Resume 前启动自有有界会话，只启用客户端事件 5/7，并同时使用 PID 与 event ID filter；候选子进程需要独立验证并纳入限定 PID 集合，不能用全机采集补漏。原生 [EnableTraceEx2 文档](https://learn.microsoft.com/zh-cn/windows/win32/api/evntrace/nf-evntrace-enabletraceex2)支持这些过滤类型，但本机 provider 的实际事件交付、丢失计数、会话停用及崩溃恢复尚未验证。零事件不能作为“没有 RPC 调用”的结论。避免采集共享 Dnscache 宿主的其他调用、原始地址与选项；最终只保存固定请求窗口的接口/操作号/协议及明确观测状态。

本轮原型 locked 默认测试 220 项通过、14 项忽略，未运行全部 ignored 测试。DNS 代办隔离仍未解决，A/B 仍未完成，生产 unavailable。

### DNS TCP 发送进程实机归属为 Dnscache 所在进程

固定DnsSenderIdentity实机沿用RPC+包+账户规则诊断，fixture0b999d90-d4c9-468a-9d9a-de3f6e75fed1/SID1130/helper PID21004稳定句柄等待终止退出0。自有TCP53两次测试请求的反向完整四元组查询均归属PID2244；CIM按固定Dnscache服务读取实验前后Running/PID2244/CreationTime2026-10-08T13:26:06.8514440Z一致。该PID不在已验证LPAC Job执行成员中，证明这两条TCP socket出自Dnscache所在宿主进程，不能当原RPCcaller身份或UDP归属证据。

DNS矩阵继续失败，完整恢复RPC/包/原账户规则、profile/account及OS四项缺席、debt为空。证据前缀dns-sender-identity-system，附dns-service-identity回执。新增实际发送PID/服务前后稳定身份/执行树外/失败矩阵/清理绑定回归与Clippy通过。下一步需定位服务入口及授权检查，不能全局阻断该服务进程影响其他应用；A/B未完成。


TCP发送PID观测接入自有DNS receiver：每次accept固定流在应答前查询反向四元组，仅保存PID或明确错误，8项预算+溢出错误。初始正对照后清空，结束前冻结测试窗口观测，再执行最终正对照；最终control不混入窗口结果。fixture TCP接收检查detail附加限定tcp_sender_owners JSON，不增加未知矩阵check、不替换原API结果/接收计数门禁。精确运行既有owned DNS53 receiver忽略测试，验证中间一次真实TCP query有唯一成功归属、两次finish保持一致，quiet窗口不含controls；测试通过。仍未运行LPAC DNS代办归属观察，不能称PID已绑定Dnscache或RPCcaller。下一步固定实机+服务PID/创建时间核对，A/B未完成。


新增dns_sender_identity读观测：仅接受已接收的127.0.0.1:53 TCP stream，查询GetExtendedTcpTable并匹配反向完整四元组/ESTABLISHED，要求唯一非零发送PID；其他行不输出或持久化，1MiB表预算、长度/行数检查、2次增长重试，未知/消失/重复拒绝。固定自有TCP53连接的精确忽略测试单独执行，确认发送PID与当前真实测试进程一致；没有执行全部ignored测试。此PID仅归属socket，不能证明原始RPC调用者身份。IpHelper SDK feature已接入，尚未连接DNS receiver或实测系统代办归属。下一步接收端记录限定归属并与实际Dnscache服务身份比较，A/B未完成。


### 精确账户RPC_UM规则也未封锁本机DNS代办：实机否证

固定DnsRpcBlockInternetProbe接通独立模式：先保存/安装账户+包+RPC保护，Resume前RPC/包查询绑定，临时internetClient仅固定诊断有效、默认策略不变。fixture dde0a800-5db9-4aa0-8993-f51b3ff3665e/SID1129/helper PID7756已终止退出0。规则存在/结构核验true，但根及实际后代DNS UDP/TCP四项均9506 pending/completion0/固定answer true，接收端UDP/TCP各received2且前后positive正常。矩阵失败，说明当前RPC_UM/REMOTE_USER_TOKEN条件不足以覆盖该本机代办路径；不能据此推断所有RPC层失败或证明实际调用经过该层。

独立恢复rpc/package/account filters及account/profile全退役、debt为空、OS四项缺席；证据前缀dns-rpc-block-internet-system。新增实际绕过/收包/意图/退役绑定回归，完整219测试/13忽略及Clippy通过。下一步需要观测本机DNS服务入口与实际调用者身份，再评估可作用的边界，不能通过全局禁用服务或继续盲加过滤层。A/B未完成，未提交推送。


### RPC固定Node安装/核验/恢复首次实机通过

固定NodeRpcBlock接通先保存后安装producer与Resume前重新查询，不开放任意账户/descriptor/layer。fixture9d1db0bc-ea92-4ffa-9667-29710fc833b4/SID1128，helper PID28452同一进程句柄等待并终止退出0（没有超时重派发）。RPC和四包规则Resume前核验true，真实user/package/capabilities/Low/LPAC与Job拓扑通过，Node退出73。首轮namespace缺席暂未确认而保留保护；独立恢复随后rpc_filter_removed/package_filters_removed/filters_removed/account_removed/profile_removed全true、debt为空，OS四项缺席。证据前缀node-rpc-block-system。新增真实意图/Token/退出/全部规则退役/OS绑定回归与Clippy通过；此前完整217测试通过。

本轮只证明RPC规则可安装、Node兼容和精确恢复，不证明DNS代办被拒绝。下一步固定DNS root/实际后代与自有接收端反例实验，A/B未完成。


RPC规则精确退役已接入cleanup：通过现有owned workload/namespace/station、无账户进程、HKU与profile缺席门禁后，先重建固定账户CC匹配描述符并核验/删除本轮RPC规则，查询确证缺席才保存rpc_filter_removed；随后才退役包规则、账户及原SIDblock。重入已标退役规则会重新查询，若规则重现则拒绝，不静默删除。旧未实现入口阻断撤去；回执回归逐项检查账户/原SID/包规则提前释放拒绝及无意图checkpoint拒绝。完整217测试/13忽略、Clippy通过，扩展回执回归再次通过。仍未安装RPC规则或跑OS RPC恢复，下一步接producer和固定诊断。A/B未完成。


新增 RPC change_owned 事务：调用前验证完整单账户CC描述符及保护fixture/SID/独立key，事务内查询并验证精确RPC_UM规则，安装拒绝已有key；退役仅删除已核验规则，确证缺席可重入。固定REMOTE_USER_TOKEN描述符、独立持久BLOCK，不接受外部layer/condition。提交后再次查询存在或缺席，不确认则保持journal与账户防护；RAII仅尝试abort，不把它当清理证明。13项相关既有测试及Clippy通过。事务尚未接入cleanup/producer，也未执行OS实机；下一步接恢复门禁与固定派发，A/B未完成。


RPC意图接入ProfileReceipt可选字段与save前validate：绑定保护账户SID/fixture及原账户+包的8个独立keys；要求既有包保护意图，RPC退役检查点必须先于账户/原SID规则/包规则释放。无意图退役标志拒绝，未知字段仍严格拒绝。RPC退役尚未实现时cleanup入口拒绝并保留全部身份保护。实际历史回执派生回归确认释放门禁、正确意图与非OS拒绝路径、SYSTEM身份替换拒绝；Clippy通过。当前未生成/安装RPC规则，下一步实施事务与精确退役再接固定诊断。A/B未完成。


新增 rpc_network_filter 精确结构检查与 WFP 单key查询封装：固定RPC_UM/universal/persistent(+可选INDEXED)/BLOCK、唯一REMOTE_USER_TOKEN/EQUAL/SECURITY_DESCRIPTOR；复用严格账户描述符验证。查询仅FILTER_NOT_FOUND且无分配算缺席，成功空指针及其他错误拒绝，查询内存RAII释放。真实SDDL描述符与合成规则结构回归覆盖错误连接层、disabled、错误field/type/match及另一账户，测试和Clippy通过。尚未接入回执、RPC安装与恢复，也未运行RPC OS规则实测；A/B未完成。


RPC条件描述符基础复用并收紧现有ALE验证：新增wfp_account_descriptor共享检查器，核对有效完整SD长度、有效单ACE DACL、显式Allow/零flags/准确ACE长度、mask=CC及精确账户SID；原ALE恢复调用此检查器，不能接受继承ACE或扩大权限匹配。真实Windows SDDL转换得到的positive及GA/继承/Deny/额外Everyone/错误SID/空DACL/截断大小negative回归通过，Clippy通过。该检查器消费可信WFP查询内存，不能作为任意不可信字节解析器。尚未安装RPC规则或验证DNS代办路径，A/B未完成。


新增 rpc_network_intent 基础：固定版本、nonnil UUID、完整规范专用账户 SID、唯一独立 filter key。拒绝空/SYSTEM/畸形账户 SID、fixture/source替换、nil/既有key复用，以及不完整4或8条既有规则键集合；未知descriptor/layer等输入字段不接受。回归测试与Clippy通过，未接入回执/WFP安装，也没有新RPC规则实机证据。下一步接精确REMOTE_USER_TOKEN描述符检验与持久恢复门禁，再实际验证DNS路径。A/B未完成。


代办边界候选复核完成：官方 RPC_UM 条件表只有 REMOTE_USER_TOKEN 等 RPC条件，未列 ALE_USER_ID/package，禁止照搬现有连接层条件。REMOTE_USER_TOKEN 是安全描述符类型，RPC_PROTOCOL 是UINT8/LRPC可列值；是否覆盖DNS本机代办及其身份仍未知。v1第6节记录精确账户RPC实验的journal/先查询/对照/恢复要求，清单A5同步新增包规则的明确否证。不安装全局RPC规则、不改DNS服务；本轮无新实机派发。下一步实现精确账户RPC意图与检验，再验证候选。A/B未完成。


### 包 SID block 亦不能封锁 DNS 系统代办：明确实机反例

独立 DnsPackageBlockInternetProbe 固定模式只在拥有包规则意图下增加 well-known internetClient SID，默认 startup_capability/permitted 策略继续拒绝 internetClient。主 Token 及 JobObserver 的精确能力期望同时绑定新增 SID，不放宽一般能力比较。固定 helper PID19152终止退出0，fixturea2933756-fbf0-476d-b8f9-1cee42a9df6c/SID1127。四账户规则+四包规则保留，Resume前包规则查询true，真实Low/LPAC/user/package/capabilities及Job拓扑通过。

根及实际后代的DNS UDP/TCP四项均dispatch9506(PENDING)、completion0、records/fixed_answer=true；自有UDP/TCP接收端各received=2，前后positive controls正常。完整矩阵失败，不可声称新增包规则解决服务代办。独立恢复包/账户规则及profile/account全部移除、debt为空、OS四项缺席。证据前缀dns-package-block-internet-system；新增实际绕过/收包及清理绑定回归与Clippy通过。网络候选仍NO-GO，下一步需调整代办边界设计，不能继续只堆账户或包连接过滤条件。A/B未完成，未提交推送。


### 默认能力包规则 DNS 矩阵实机：未知87仍失败

首轮默认包规则fixture388eecb4/SID1125/PID4256退出0，规则安装与清理通过，但发现报告分支仍用controller_tool.is_none判断full probe，导致新None工具映射的DNS变体跳过矩阵读验。该轮不算DNS验收证据；已改为fixed_tool.is_none，scope亦依实际工具映射选择。

修正后fixture5eb35953-a4cd-4001-92a2-35c6839e2e1c/SID1126/PID1132退出0：Resume前四包规则已核验；完整矩阵载入，workload_checks_passed=false/error明确保留。实际根及后代DNS UDP/TCP均dispatch/completion87；数字地址local positive均0/固定结果，两个自有DNS接收端前后positive正常、计数0。87不能当明确拒绝，网络封闭仍未证明。独立恢复包与原SID规则、账户/profile全部移除、debt为空，OS四项缺席。证据前缀dns-package-block-matrix-system；新增实际矩阵失败/四项87及清理绑定回归与Clippy通过。下一步单独固定临时internetClient反例模式（默认集合不变），才能检验包规则是否覆盖已知DNS代办绕过；A/B未完成。


DNS 包规则固定派发骨架已接通：新增 DnsPackageBlockProbe 固定序列化变体与 prepare-owned-system-dns-package-block 入口，要求普通 fixed workload、无 recovery、Normal lifecycle；复用完整 probe 而非 Node tool command。fixed_tool 映射改为 Option 并用 and_then，DNS 变体返回None，确保完整 fixture/后代网络和固定 DNS receivers 路径被选择；该变体复用先保存后安装的包规则 producer、Resume前核验及精确恢复。现仍使用默认能力集合，不开放 internetClient。相关派发回归及完整211测试通过、13忽略、Clippy通过；尚未派发实机。下一步检查默认能力整矩阵，再增加单独隔离的临时能力反例模式（不能更改默认策略）。A/B未完成。


包网络意图补齐固定 UUID moniker 绑定：使用系统 DeriveAppContainerSidFromAppContainerName 对 ShellSpan-candidate-{uuid.simple} 推导完整 SID，验证意图 SID 与当前保护字段之外，还必须与实际推导 SID 相等；返回 SID 通过 RAII FreeSid 回收。新增另一 UUID 的完整有效 SID 替换反例，原实机包规则证据在新校验下继续通过。完整默认测试210 passed /13 ignored，Clippy通过。尚未扩大到DNS代办实测，A/B未完成。


### 包规则安装与精确恢复首次实机完成

固定 NodePackageBlock 接通 producer：先保存意图，再安装独立四条规则；实际用户/package/能力/Low/LPAC 核验通过后、Resume 前重新查询四条规则。首轮 99d3e9a2 / SID1123 在实际 WFP 返回 flags=0x41 时严格 flags 校验失败并保留账户/SID/package block，未执行 LPAC。固定独立诊断确认 key/layer/sublayer/action/conditions 均匹配，额外位为 INDEXED（官方 FWPM_FILTER0 文档描述索引优化）。校验仅允许这一位，其他未知或 disabled 位仍拒绝，新增对应回归。固定恢复 PID21740 终止退出0，包/原SID filters、账户/profile 退役、debt为空；独立 SAM/CIM/HKU 缺席见 package-block-recovery-retirement-os-audit.json。两个更早 hive 债务未变。

修正后新 fixture01877557-32e5-4f1e-929b-5cd4c7847170 / SID1124，固定 helper PID29164 终止退出0；Resume前四规则实际验证true，Node退出73、实际Token/Job拓扑通过，独立恢复包规则/原SID规则/账户/profile/debt全清，OS四项缺席。证据前缀 node-package-block-indexed-system。新增实际报告/冻结意图/退役/OS绑定回归通过，构建及Clippy通过；此前完整209测试通过，新增实际回归单独通过。

这仅验证包规则安装/检查/退役与固定Node兼容，不证明DNS服务代办封锁。下一步仍需固定自有DNS接收端根与实际后代UDP/TCP反例实验，A/B未完成。


包规则退役接入 ProfileReceipt cleanup：现有 workload/namespace/station、无账户进程、HKU 与配置文件缺席门禁通过后，账户删除前调用精确包规则事务退役并发布缺席 checkpoint；原账户 SID block 保留到后续清理末尾。重入已标退役的包规则时重新查询全部 key，仅缺席接受；规则重新出现拒绝而不静默删除。撤去旧的未实现入口阻断。完整默认测试 209 passed / 13 ignored、Clippy 通过。当前尚无包规则安装 producer，OS 包事务/恢复路径仍未实测；下一步接入固定诊断安装 producer 与持久意图，再进行实机。A/B 未完成。


新增包规则 change_owned 事务实现：验证 intent/实际 SID/fixture/account keys，事务内先检查四项完整身份，安装拒绝已有 key，不覆盖；删除只处理已核验存在的自有 key，允许确证缺席。四项固定 ALE_PACKAGE_ID 条件独立 BLOCK，commit 后逐项检查实际存在/缺席。失败保持受保护意图，RAII 尝试 abort；未将 abort 成功当作清理完成。既有相关测试及 Clippy 通过。函数尚未接入固定派发/恢复入口，新增 OS 事务尚未实测；下一步接通 checkpoint 和固定实验，不算 A/B 完成。


包规则检查器新增 FwpmFilterGetByKey0 实际查询封装及 RAII 查询内存回收：只接受 FILTER_NOT_FOUND 且无返回分配为缺席，其他错误/成功空指针拒绝；查询成功调用完整 key/layer/action/package-SID 校验。未接入安装/恢复调用处，也未在真实包规则上运行，此封装尚无 OS 成功证据。相关既有三项测试和 Clippy 通过；下一步接通固定拥有规则的安装与退役，A/B 未完成。


新增 package_network_filter 精确检查器：固定四层顺序，核对 filter key、准确层、universal sublayer、persistent flags、BLOCK 动作、唯一 ALE_PACKAGE_ID/EQUAL/FWP_SID 条件及实际有效 SID 精确相等。检查器仅消费活的 WFP 查询内存，无安装/删除副作用。内存结构回归覆盖 key/layer/flags/action/条件数量/field/match/SID 替换及非法层索引，测试与 Clippy 通过。尚未接入 OS 查询、安装与退役，不能称 WFP 实机通过；下一步完成调用链。A/B 未完成。


包网络意图已接入 ProfileReceipt 的可选持久字段与 save 前 validate，兼容没有新增意图的历史回执。要求固定 package/SID、账户与固定 workload 生命周期绑定，拒绝无创建意图的退役标志、身份缺项及未确认包规则退役就释放账户/原 SID block。尚未实施新增规则退役时，cleanup 遇到此意图立即拒绝，保留原账户保护；当前没有代码生成或安装这些意图。实际历史回执派生的回归验证上述门禁、未触碰 OS 的拒绝路径，cargo check 与 Clippy 通过。下一步接入精确 WFP 安装/查询/退役，再实测；当前仍未完成 A/B。


新增 package_network_intent 类型基础：固定版本、fixture UUID、规范完整 package SID 与四项独立 filter keys；验证拒绝 nil/重复 keys、与原账户 filter keys 冲突、fixture/package 身份替换及未知字段。针对这些安全边界的回归与 Clippy 已通过。模块尚未接入 ProfileReceipt 持久发布、WFP 安装/查询/退役，不能称已拥有 journal 或 DNS 封闭；下一步必须完成这些调用链后才派发固定网络实验。A/B 未完成，生产 unavailable。


网络缺口复核：当前 install_network 的四项过滤器仅按 ALE_USER_ID 匹配，历史 DNS 代办实机反例依然有效。官方层/类型文档确认 ALE_PACKAGE_ID / FWP_SID 是可用候选条件，已在 v1 第 6 节记录独立包过滤器实验及 journal/恢复约束；是否覆盖 DNS 代办尚未证实。下一步需先实现拥有记录与精确过滤器校验，再运行同一自有接收端根/后代正负对照，不能直接放宽网络能力或改变全局 DNS 服务。本轮未安装新过滤器或派发诊断，A/B 保持未完成。


跨槽位报告门禁进一步收紧：源账户 SID 必须是四个规范 u32 子权限的 S-1-5-21 账户 SID，拒绝缺段、额外段、前导零、符号、溢出和 RID 0；避免仅检查字符串前缀将畸形身份当作有效证据。新增源 SID、目标顺序替换、报告/peer 缺字段及未知字段回归，四项跨槽位测试（含两轮真实实机证据回放）与 Clippy 均通过。未重新派发已完成的单次 SYSTEM 诊断；A/B 未完成。

### 跨槽位注册表危险访问权限正负对照已实测

固定探针现同时申请 KEY_READ、KEY_SET_VALUE、KEY_CREATE_SUB_KEY、DELETE，仍只 Open/Close 句柄，不调用任何注册表修改 API。每类报告均要求实际主身份、两项固定目标和完整状态字段；交付门禁逐项绑定新源 SID，仅八项 Win32 5 接受为拒绝。受保护旧槽拥有/禁用/配置文件对象预检保留，SYSTEM 八项正对照必须全部成功才派发。无任意 SID、路径、权限或命令参数。

固定辅助进程 PID 25224 终止退出 0，新 fixture c17cffd9-5224-4454-8746-837ff48a0165 / SID 1122。八项 SYSTEM 状态均 0、八项 Low LPAC 状态均 5，工具退出 73，真实身份、能力、包和 Job 拓扑通过。独立恢复清空新账户/profile/filters/debt，OS 四项缺席通过。见 [实际报告](evidence/windows-stage-a-2026-10-09-cross-slot-registry-access-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-cross-slot-registry-access-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-cross-slot-registry-access-system-os-audit.json)。实际证据回归覆盖全部访问类型、八项状态的成功/未知错误伪装、缺项、错误源身份、未知字段和清理绑定。完整默认测试 205 passed / 13 ignored；忽略项未运行。

这证明两个已拥有旧 HKU 根键的固定访问权限隔离；不能替代所有注册表子对象、跨槽文件/句柄/凭据、账户池或并发隔离。两个旧 hive 债务保持不变，A/B 尚未完成，生产 unavailable。
### 固定跨槽位 HKU 正负对照已实测

固定 SYSTEM 派发新增 CrossSlotRegistry，只绑定既有 ba16502e/1063 与 4bb6655d/1065 两个项目拥有的旧槽位。先通过受保护、nofollow、single-link 回执核验 UUID/SID、禁用 SAM 账户、无账户进程、ProfileList 与冻结配置文件对象身份，再进行 SYSTEM KEY_READ 正对照；不读取值、不枚举子键。新低完整性 LPAC 主进程自行查询相同固定键，报告与实际新账户 SID 绑定，仅 Win32 5 算明确拒绝。

实际辅助进程 PID 31536 已终止、退出 0；新 fixture e1644c26-421b-4f43-a821-a33dd3eebc07 / SID 1121。SYSTEM 两项状态均为 0，LPAC 两项均为 5，工具退出 73，实际用户、包、能力、Low/LPAC 与 Job 拓扑均验证。独立恢复回执确认账户、配置文件、WFP filters 已移除、cleanup_debt 为空；OS 审计确认账户、ProfileList、HKU、服务均缺席。证据见 [profile](evidence/windows-stage-a-2026-10-09-cross-slot-registry-system-profile.json)、[恢复回执](evidence/windows-stage-a-2026-10-09-cross-slot-registry-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-cross-slot-registry-system-os-audit.json)。新增实际证据回归测试，既有完整默认测试通过，新增回归单独通过，构建与 Clippy 通过。

本次仅补齐两个固定旧槽位的 HKU KEY_READ 隔离对照，不代表全部跨槽位文件、对象、凭据或并发隔离通过。两个旧 hive 债务未被修改或清除。A/B 仍未完成，生产 unavailable；未提交或推送。
新增 cross_slot_registry_probe 原型模块（尚未接入 SYSTEM 入口、未实机）：仅两个固定自有旧 interrupted SID 1063/1065 的 HKU KEY_READ 打开/关闭，不读取值或枚举。正对照要求 primary SYSTEM/no thread impersonation 且两 key 实际成功；负探针要求不同 source account、Low/AppContainer/实际 LPAC 行为验证、无 thread impersonation，交付需 frozen source SID 和两个固定 target 按序匹配且均 Win32 5。成功缺 handle/关闭失败拒绝，报告 4 KiB/deny_unknown_fields，字段缺失/重复 target/0/2/87/1702 不视为负例通过。库接口注明 parent 必须先核验 protected peer ownership；下一步将其接入限定 SYSTEM fixed-tool 派发并添加实际 source/negative/cleanup 绑定，不开放任意 target 或注册表内容。相关协议回归与 Clippy 通过；不能据此标跨槽 A1 complete，完整 A/B 未完成，未提交推送。

可信 profile 回执生产边界加固：ProfileReceipt::save 在构造路径/序列化/publish 前调用同源生命周期 validate；新增实际 save 反例确认无 recovery execution 的空 bootstrap checkpoint 在 journal I/O 前失败，未产生 evidence root。完整默认测试 201 passed/13 ignored、Clippy 通过。NodeValidatedJournal 单次 SYSTEM 实机 helper PID 17632/exit 0，UUID 705c6b65-f2f9-4b73-9ca1-e520e4b26ad2/SID 1120 的创建/执行/独立恢复期间所有保存均通过新门禁，Node 73、精确身份/Job/topology/停树通过，account/profile/filter/credential 全撤销、债务空，严格 [OS 四项缺席](evidence/windows-stage-a-2026-10-09-node-validated-journal-system-os-audit.json) true。新增实际 [执行](evidence/windows-stage-a-2026-10-09-node-validated-journal-system-profile.json)/[恢复](evidence/windows-stage-a-2026-10-09-node-validated-journal-system-recovered-profile.json) 同源 validate、UUID/SID/OS 绑定回归单独通过；该额外回归加入后未再次扩大测试。新 producer gate 不替代 B 完整 journal/认证 broker/事务/恢复，完整 A/B 未完成，未提交推送。

恢复检查点生命周期一致性门禁补齐：ProfileReceipt::validate 现拒绝 nil transaction UUID；independent_bootstrap_files_retired 仅允许 recovery_executed/account_lpac_started、无 controller workload/tool/report/planned root、无非空 child report、创建前 profile absent 且冻结 profile 存在、planned namespace/package/namespace removed/station removed 完整的空 bootstrap 生命周期。使用 1117 实际 checkpoint 成功回执作正例，逐一删除/改变必要字段及 nil UUID 均拒绝，不以 completion bool 代替实际 OS 检查。完整默认测试 200 passed/13 ignored、Clippy 通过；此前 fixed/held report 与旧实际回执继续通过。完整 A/B 未完成，未提交推送。

Bootstrap 启动计划边界补齐：AccountLpacPlan::validate_for_source 除原 source SID/owned directory/receiver 绑定外，现拒绝 nil UUID、非普通本地 Disk prefix（UNC/设备/verbatim）和 ParentDir/CurDir components，防止无效 call identity 或非本地路径进入固定入口。既有回归加入 nil/UNC/verbatim/device/父路径逃逸反例，相关测试与 Clippy 通过。本轮重新用 exact SID CIM filter 和 SAM 核对 1063/1065：各 profile count 1/Loaded=true、账户存在且 disabled，boot 仍 2026-10-08 21:25:57；不根据枚举/格式化输出无行推断缺席，未触发旧恢复或强制卸载。完整 A/B 未完成，未提交推送。

Dedicated bootstrap 固定报告写入加固：新增 write_fixed_bootstrap_report，仅接受绝对 owned UUID bootstrap root、64 KiB 内 payload，持有 no-follow root，OPEN_EXISTING 打开 account-report.json；先从同一 handle 核验 no-reparse/regular/single-link/旧大小预算再 WriteFile/set_len/flush，不在校验前 truncate，不创建缺失文件，不扩目录权限。真实文件回归覆盖缺失不创建、较短报告截断尾部、超预算不改原字节、hardlink 反例原内容保持、目录/相对根拒绝，相关测试/Clippy 通过。HeldReport 固定 helper PID 6604 实际 exit 0，UUID d8418cc2-51f6-47f2-9c83-956f57f58c45/SID 1119 的 [报告](evidence/windows-stage-a-2026-10-09-bootstrap-held-report-profile.json) 在普通专用账户权限下真实交付，仍显示既有 CreateProcess LPAC Win32 5；停树/LPAC cleanup/account/profile/filter true，债务空，严格 [OS 四项缺席](evidence/windows-stage-a-2026-10-09-bootstrap-held-report-os-audit.json) true。既有 fixed-report 回归扩为 fixed/held 两轮报告/SID/清理/OS 绑定；不将输出门禁修复宣称为 LPAC 启动兼容性解决，完整 A/B 未完成，未提交推送。

Bootstrap 空报告真正原因已定位并修复：额外固定 ExitDiagnostics helper PID 14108/exit 0，UUID e60c360d-ec81-4b71-88a5-7d461d8ed952/SID 1117 的 terminal bootstrap exit 实际为 2（不是假设的 loader 0xc0000022），outer tree stopped true；空报告恢复正常清空债务，新文件撤销 checkpoint 实机保存 true、OS 四项 absence true。代码核对发现 dedicated save 先写 std::env::temp_dir()/profile-name.json，然后才写预创建 account-report.json；显式 TEMP 指向不允许新建文件的 bootstrap root，第一次 write 即失败。现在 dedicated receipt_path 直接指向预创建固定 report，删除额外 TEMP 写入，不扩目录授权。FixedReport helper PID 27556/exit 0，UUID 40ad827e-b7e2-4fc0-bf75-bedfe252730b/SID 1118 的 [真实回执](evidence/windows-stage-a-2026-10-09-bootstrap-fixed-report-profile.json) 已非空、exact source SID/plan true，报告揭示后续原 ordinary-account CreateProcessAsUser LPAC 路径真实拒绝 Win32 5；retirement 三项 true、native account/profile/filter 清理 true、债务空、[OS 四项缺席](evidence/windows-stage-a-2026-10-09-bootstrap-fixed-report-os-audit.json) true。未把旧启动路径判为执行通过；SYSTEM target-account-context 路径的历史固定工具证据是另一入口。新增回归绑定实际报告错误/执行失败与独立清理/OS；相关测试和 Clippy 通过。owned UUID 的 Application 日志无匹配事件，CodeIntegrity 查询不可用，未用其推断加载成功；完整 A/B 未完成，未提交推送。

空报告 bootstrap 恢复的 profile-delete 检查点补齐：仅在三个固定文件授权撤销且从 held DACL 实际确认后，持久保存 independent_bootstrap_files_retired=true（旧回执缺失默认 false）。若随后 DeleteProfile 已完成但 LPAC cleanup 标记未保存，新的 profile checkpoint 允许继续：原冻结 path 必须实际 missing、各存在祖先非 reparse、该 SID ProfileList binding 实际 absent，且先前文件撤销 checkpoint 存在；现存 profile 仍须原 volume/file index 匹配，替换不接受。之后仍重新核验 protected plan、空 report、文件 inventory/leases/ACL、disabled exact account/no processes/HKU/namespace 和实际 profile absence，不以 bool 单独授权。真实 NTFS 回归验证冻结根正常、无记录缺席拒绝、有效记录缺席接受及同路径重建替换拒绝；相关测试与 Clippy 通过。新判断尚未做活账户 profile 删除后的真实崩溃注入，1116 历史成功回执来自添加此检查点前，不扩大为全恢复矩阵通过；完整 A/B 未完成，未提交推送。

1116 空报告 bootstrap 债务已独立安全退役：新增 recovery-only 路径，仅无 controller 工作夹具/报告且 namespace 已实际消失、protected plan UUID/SID/root 与冻结 profile 身份匹配、精确 disabled account 无进程/HKU、report bytes 0 才进入；bootstrap root 必须恰含三个固定文件，未知/缺失/重复名字拒绝。对 evidence parent/root/三文件持 no-write/no-delete lease，验证 no-reparse/single-link，journal intent 后撤销仅该 account 的固定授权并从 held DACL 核验不再存在；保持 profile/账户/SID block，随后沿既有实际 DeleteProfile/绑定/hive/root absence 门禁退役整个冻结账户 profile（包含 package 状态），此后才记录 LPAC cleanup，再撤销账户/filter。固定 helper PID 848 实际 exit 0，精确 UUID 093354fe-26ac-48e5-9cd6-256b30ee7599/SID 1116 的 [恢复回执](evidence/windows-stage-a-2026-10-09-empty-bootstrap-retirement-profile.json) account/profile/filter true、债务空；[OS 核验](evidence/windows-stage-a-2026-10-09-empty-bootstrap-retirement-os-audit.json) account/profile/hive/service 四项 absent true。child report 仍 null、account_lpac_verified=false，不捏造执行成功。新增 inventory 反例及实际恢复/OS UUID/SID 绑定回归，完整默认测试 196 passed/13 ignored、Clippy 通过。本路径限于无其他夹具的空报告 bootstrap，不支持完整工作负载未知债务，也不证明各撤销/删除检查点崩溃或并发宿主 DACL 的事务安全；1063/1065 老 hive 债务仍未恢复，完整 A/B 未完成，未提交推送。

1116 空 bootstrap 报告的独立恢复前置核验已实机：仅精确既有 UUID 的恢复路径，在原 acknowledgement 门禁前以 read-only inspect_recovery 验证 disabled exact account/no_account_processes、HKU absent、冻结 profile identity、受保护 plan 的 UUID/SID/root 绑定及只读持有固定 image/report 的 no-reparse/single-link/byte budget。helper PID 9068 实际 exit 0（证据采集），native recovery 仍 exit 2/原债务保留；[受保护恢复观察](evidence/windows-stage-a-2026-10-09-bootstrap-independent-recovery-observation.json) 显示所有前置项 true/error null、report bytes 0。新 optional 观察字段仅记录前置检查，不改变 cleanup 授权；named candidate ACL 在持有文件期间校验，观察是当前时间点证据而不是持久 lease/事务保证。新增实际回归绑定 receipt/观察 UUID/SID、真实空文件，并断言即使前置通过仍 account/filter 未撤销、cleanup false、债务非空；相关测试/Clippy 通过。下一步补齐独立资源退役而非改写子进程 acknowledgement；完整 A/B 未完成，未提交推送。

Bootstrap 失败原因保留修复：原父进程仅 WaitForSingleObject，未 GetExitCodeProcess；然后先解析 account-report.json，空报告 EOF 覆盖了先前执行/等待失败。现仅在实际 wait 已 terminal 后查询并记录 account_lpac_bootstrap_exit，实际 end_process 结果另存 account_lpac_outer_tree_stopped；decode_bootstrap_report 在 parse 失败时保留 terminal 十六进制 exit 或原执行错误。parseable report 仍先经既有 retirement acknowledgement 再处理执行失败，不以非零 exit 推断残留或放宽 cleanup。新增回归覆盖 0xc0000022/等待错误不被 EOF 覆盖，以及 exit 2/timeout 时可读 report 保留供独立退役核验，相关测试与 Clippy 通过。1116 旧回执没有该信息，不能猜测其实际 exit；未另建账户重跑。其恢复仍受空 acknowledgement 门禁阻挡，应实现基于受保护 plan、冻结自有 profile、实际进程/namespace/hive 缺席的独立恢复，而不是补写成功 report。完整 A/B 未完成，未提交推送。

Bootstrap 显式环境路径实机失败并留下新隔离债务，不能重试新账户掩盖：固定 helper PID 25780 已 terminal/exit 1，UUID 093354fe-26ac-48e5-9cd6-256b30ee7599/SID 尾号 1116，外层 Job total 2，bootstrap 报告为空，receipt.error 为 EOF，account_lpac_cleanup_verified=false；namespace 已消失，但 native 精确恢复仍因 LPAC 退役未确认而拒绝，账户/profile/filter 未撤销。见 [失败回执](evidence/windows-stage-a-2026-10-09-bootstrap-explicit-environment-profile.json) 和 [SAM/CIM 隔离核对](evidence/windows-stage-a-2026-10-09-bootstrap-explicit-environment-quarantine.json)：精确 SID 匹配、account disabled、profile Loaded=false，不推断 HKU/filter/package 不存在。新增实际空报告回归确保该状态不能授权退役，相关测试及 Clippy 通过。下一步优先定位 bootstrap 未交付报告和安全恢复此固定 UUID；不得写假 acknowledgement、清零债务、放开 WFP 或再次运行本单次分支。原 1063/1065 hive 债务仍另行待恢复；完整 A/B 未完成，未提交推送。

环境块校验继续接入 fixed fixture runner 与普通专用账户 bootstrap：runner 原有四个显式目录键经共享 canonicalize，新增回归确认仅 ProgramData/SystemRoot/TEMP/TMP、顺序规范、scratch 与固定 root 绑定；bootstrap 原 CreateProcessWithTokenW 的 null environment 会继承 controller 父环境，现改为仅 SystemRoot/WINDIR/USERPROFILE/LOCALAPPDATA/TEMP/TMP 的显式规范块，profile 根在使用前核对冻结 volume/file identity，Windows 目录由系统 API 获取，临时目录仅本轮 owned bootstrap root，不使用宿主 HOME/PATH/NODE_OPTIONS。修改后完整默认测试 190 passed/13 ignored，随后新增 runner 回归单独通过、Clippy 通过；尚未实机重跑旧 bootstrap 路径，不能用 controller tool 的旧证据代替它。本次未改变其自有目录写权限或放宽 cleanup 判定，完整 A/B 未完成，未提交推送。

显式环境块排序/歧义门禁修复：Microsoft [环境块说明](https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables) 要求名称按大小写不敏感、无 locale 的 Unicode 顺序排列；现有 source/shared LPAC/SYSTEM controller 直接拼接未排序。新增 fixed_environment::canonicalize，由三入口在 CreateProcess 前共用，名称仅允许本诊断 ASCII 字母数字/underscore（首字符非数字、最多 64 字节），因此 ASCII uppercase 排序满足该名称域；拒绝重复 case-insensitive key、无效 UTF-16、空/内部空条目、缺少双 NUL 及超过 32768 UTF-16 单元的本地诊断预算。不读取宿主环境，不改变 Unicode value/空 value/值中等号；错误不输出环境内容。两项回归覆盖排序幂等、Unicode/空值保留、重复/截断/内部终止/伪 drive/Unicode key/损坏 UTF-16/预算拒绝，相关测试和 Clippy 通过。排序后 shared LPAC Node 实机 73、topology/停树/profile/ACL 清理 true，见 [实机](evidence/windows-stage-a-2026-10-09-node-canonical-environment-lpac.json)。本次未重跑专用账户全部矩阵或其他未接入启动路径，完整 A/B 未完成，未提交推送。

Node ambient preload 反例补齐：仅在本轮父 shell 临时设置 NODE_OPTIONS=--require=ShellSpan-owned-ambient-module-must-not-load（固定不存在模块）和固定 NODE_PATH 标记，finally 恢复原值。普通直接 Node 对照实际 exit 1/MODULE_NOT_FOUND；同环境 source control 与 shared LPAC 固定 cwd 脚本实际 exit 73、无错误、topology/停树与 fixture/profile/ACL 清理通过，见 [失败对照](evidence/windows-stage-a-2026-10-09-node-ambient-options-control.json)、[ordinary](evidence/windows-stage-a-2026-10-09-node-ambient-options-source.json)、[LPAC](evidence/windows-stage-a-2026-10-09-node-ambient-options-lpac.json)。新回归核验三轮退出码和清理，相关测试/Clippy 通过；这直接证明该预加载选项未影响子进程，不单独证明 NODE_PATH 缺席或所有宿主环境键隔离，也未执行专用账户的此反例。完整 A/B 未完成，未提交推送。

统一 owned output cwd 与 create_new 固定源创建版本的专用 PowerShell 编译补齐实机：PowerShellOwnedCwd 固定单次 helper PID 4140 同一 handle 最终 exit 0，UUID 77a5ef4c-3333-4d8f-8cda-55f2516140ca/SID 尾号 1115；471 文件运行时、源写反例、Add-Type 文件源编译、DLL 字节重载执行及 SHA256/产物门禁通过，actual exit 73，精确身份/Job/topology/停树 true，见 [执行](evidence/windows-stage-a-2026-10-09-powershell7-owned-cwd-system-profile.json)。与 Node 一样首次 namespace 观察超时保留债务，独立恢复后四项撤销 true、债务空、严格 [OS 缺席](evidence/windows-stage-a-2026-10-09-powershell7-owned-cwd-system-os-audit.json) 全 true。编译回归纳入新回执/恢复 UUID/SID/OS 绑定，相关测试及 Clippy 通过。检查 controller 清理代码确认显式 drop 子进程/source Token/两个 Job，查询 namespace 句柄也按次关闭；尚无证据定位剩余 lifetime 引用，不推测性放宽正常关闭门禁。完整 A/B 未完成，未提交推送。

Node 自有 cwd 断言补齐专用账户实机：固定 NodeOwnedCwd 单次诊断 helper PID 15920 实际 exit 0，UUID c619c41e-90d0-4602-88e8-4098f82def30/SID 尾号 1114；actual Node exit 73，user/package/capabilities/Low/LPAC/Job topology 与停树通过，见 [专用回执](evidence/windows-stage-a-2026-10-09-node-cwd-assertion-system-profile.json)。首次 namespace retirement 2 秒观察未确认消失，正确保留债务，不作为正常清理通过；独立恢复确认 namespace 消失、账户/profile/filter/credential 全部撤销，债务空，严格 [OS 审计](evidence/windows-stage-a-2026-10-09-node-cwd-assertion-system-os-audit.json) 四项 absent true。现有 Node 回归增加专用执行身份、实际退出码、恢复 UUID/SID 和 OS 绑定，相关测试与 Clippy 通过。此结果不代表 namespace 正常关闭时序已修复，也不替代完整项目/工具矩阵；完整 A/B 未完成，未提交推送。

固定工具启动目录统一绑定本轮自有 output，ordinary/shared LPAC/SYSTEM controller 均移除非 Git 工具的 System32 cwd 分支。Node 固定命令直接比较实际 process.cwd() 与 SSPA_FIXTURE/output（Windows 大小写规范化），匹配退出 73，否则 74。ordinary/shared LPAC 实机均 73、topology/停树通过，ordinary fixture 回收、LPAC profile/ACL 清理通过，见 [ordinary](evidence/windows-stage-a-2026-10-09-node-cwd-assertion-source.json) 和 [LPAC](evidence/windows-stage-a-2026-10-09-node-cwd-assertion-lpac.json)；新增回执回归绑定工具成功、隔离身份与清理，完整默认测试 187 passed/13 ignored。候选入口按既有 NO-GO 约定仍退出 2，此值不表示 Node 工具失败，production 仍 unavailable。新增 cwd 约束尚未重新执行专用账户工具矩阵，不解决 Git ancestor 拒绝或 DNS/旧 hive 债务，完整 A/B 未完成，未提交推送。

固定编译源的实际增量撤销回归补齐：自有 UUID 源文件持内容 lease，预设 creator/SYSTEM 和另一个测试 package SID 的 FR ACL，再添加本轮 package FR；调用实际 Fixture::revoke_files 后 held source 字节不变，DACL 与添加本轮授权前的快照完全一致，另一个 SID 的授权保留，源写句柄仍被内容 lease 拒绝。相关真实 NTFS/ACL 回归、完整默认测试 186 passed/13 ignored、Clippy 通过。这验证 owned fixed source 的具体撤销路径，不证明宿主在 ACL read/merge/write 间并发修改的事务安全，也不代替 B journal/delta/账户池；完整 A/B 未完成。

完成核对表 A5/A7 同步实际新增证据：默认专用 root/leaf sync/async DNS 同为 87，固定 file-source 编译/写反例通过，Git init 与 ancestor 拒绝仍失败；不将这些诊断标为完整 A。当前 boot 未变化，1063/1065 两个 profile CIM Loaded=true，不能执行旧债务恢复。源创建改为共享 create_fixed_build_source 的 create_new 写入，再获取并核验固定内容/单链接 lease；遇到预先存在的文件或硬链接不覆盖，普通对照与 Fixture 同步使用。实际 owned 对象回归证明预存字节/别名保持、新建后重复创建拒绝；完整默认测试 185 passed/13 ignored、Clippy 通过。完整 A/B 未完成。

编译 child 自身写源反例实机完成：固定命令编译前 WriteAllText(fixed-build.cs,'tampered')，意外成功 exit 74；仅最内层异常 HRESULT low16 的 Win32 5/32 可继续，其他错误重抛。后续读取原源编译及 held source 固定内容/单链接/精确长度 gate 保持，因此不能用文件不存在/未知错误代替拒绝。shared LPAC [写源反例](evidence/windows-stage-a-2026-10-09-powershell7-source-write-denied-lpac.json) exit 73/源与 DLL/产物 true、停树/profile/ACL true。专用 UUID 5f6825cd-d349-4d04-a0ee-d2186e461818/SID 尾号 1113，helper PID 17264 实际 exit 0，[专用回执](evidence/windows-stage-a-2026-10-09-powershell7-source-write-denied-system-profile.json) actual 73/产物/身份/topology true，[恢复](evidence/windows-stage-a-2026-10-09-powershell7-source-write-denied-system-recovered-profile.json) 四项 true/债务空，[OS 审计](evidence/windows-stage-a-2026-10-09-powershell7-source-write-denied-system-os-audit.json) 四项 absent true。未单独记录本次 5 与 32 哪一个，不能声称仅 ACL 拒绝，内容 lease 的共享冲突是允许的保护原因。真实回归扩展到第三轮，完整默认测试 184 passed/13 ignored、Clippy 通过。完整 A/B 未完成。

编译源 admission 次序再次收紧：共享 open_fixed_build_source 在 held handle 上核验单链接/固定内容后返回 lease，Fixture 在文件创建后立即获取，而非 snapshot/授权完成后才打开；source control 和结束后的 DLL gate 复用相同核验，源 lease 穿过全部后续准备/授权/执行/核验。只读规则分类保持。真实文件就近回归调整为先 admission/持有源，再 snapshot/retain，确认读取与 inventory 核验成功且写入/rename 阻止、释放后恢复可写；完整默认测试 184 passed/13 ignored、相关回归与 Clippy 通过。1112 实机证明持续句柄版本，不将其扩充为本轮提前 admission 次序的独立实机证据；完整 A/B 未完成。

持续源内容 lease 加固后的专用账户编译实机通过：新增 PowerShellPinnedSourceBuild 单次 evidence 分支，UUID 82cae403-40fc-4d26-b29c-1ddee8a8b062/SID 尾号 1112，helper PID 29508 同一进程实际 exit 0。新版本持有 metadata/readonly rule 和独立 source 内容句柄，actual build exit 73/source gate/DLL SHA256/artifact true，准确 Token/Job/topology/停树 true，stderr 空。见 [加固后编译](evidence/windows-stage-a-2026-10-09-powershell7-pinned-source-build-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-powershell7-pinned-source-build-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-powershell7-pinned-source-build-system-os-audit.json)。独立恢复全部四项 true、债务空、严格 OS 四项 absent true；原编译回归现在同时绑定 source-file/pinned-source 两轮真实身份/产物/恢复 UUID/SID 和 OS，相关测试、Clippy 通过。source 内容阻写/替换有就近 actual file 句柄测试，本轮未另外注入运行中宿主攻击；不扩大为完整项目并发矩阵通过。完整 A/B 未完成。

编译源冻结修正：上一轮 fixed-build.cs 虽被 inventory 记录且 package FR，但属于普通对象，retain_protected_leases 会释放其替换保护；新增 explicit readonly rule/Object::Rules 分类核验。实际回归又确认现有 project metadata lease intentionally share WRITE，不能据此宣称内容不可变；Fixture 现另持 ToolImageLease 的只读内容句柄，普通 source control 同样持有直至停树/产物核验后再释放，保留宿主普通项目文件原有编辑语义。真实 owned 文件回归验证读取成功、写句柄/rename 拒绝、snapshot unchanged、释放后可写。完整默认测试 184 passed/13 ignored、Clippy 通过。1111 回执仍是加固前的实际 source/DLL 验证，不证明新增持续内容句柄门禁已实机；后续须对加固后版本重新执行受限编译与恢复。完整 A/B 未完成。

专用账户文件源编译与新增源门禁已实机通过：PowerShellSourceBuild 单次 evidence 分支，UUID 6e414cc6-9911-477e-a9e1-d14de9bcf84d/SID 尾号 1111，helper PID 27532 同一进程实际 exit 0。读取只向 package 授 FR 的 fixed-build.cs，Add-Type -Path/DLL 从字节加载/执行 SHA256 绑定/固定产物/held source 内容和单链接门禁均通过，actual exit 73，准确 user/package/caps/Low/LPAC/Job/topology 与停树 true，stderr 空。见 [专用编译](evidence/windows-stage-a-2026-10-09-powershell7-source-file-build-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-powershell7-source-file-build-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-powershell7-source-file-build-system-os-audit.json)。snapshot/撤销自动包含新源对象，独立恢复全部四项 true/债务空，严格 OS 四项 absent true。实际成功与恢复 UUID/SID/OS 绑定回归通过，完整默认测试 183 passed/13 ignored、Clippy 通过。这证明固定源文件读取→编译→落盘→重载调用的受限工作流，仍不替代用户真实项目、完整构建工具集、DNS/凭据、Git、旧 crash hive 或完整 A/B；未提交推送。

固定 PowerShell build 改为实际读取 owned fixed-build.cs 源文件：fixture 在 snapshot/授权前创建确定字节，package 仅 FR，源文件纳入既有冻结对象和撤销；ordinary source control 创建同内容。Add-Type -Path 使用固定 SSPA_FIXTURE 子路径，移除内联 TypeDefinition；产物 DLL/执行字节 SHA256/输出门禁保持，新增 held source 单链接/确定内容验证与内容变更/硬链接拒绝回归。ordinary/shared LPAC 本轮实际 build 均 exit 73、DLL/artifact true，LPAC 停树/profile/ACL 全部清理 true，见 [ordinary](evidence/windows-stage-a-2026-10-09-powershell7-source-file-build-source.json)、[LPAC](evidence/windows-stage-a-2026-10-09-powershell7-source-file-build-lpac.json)。两轮发生在新增 controller source verifier 前，不能声称当时已执行该新增门禁；其后静态门禁测试通过。完整默认测试 182 passed/13 ignored，源变更/硬链接回归与 Clippy 通过。该固定源文件编译扩大了受限工具的文件读取证据，仍不是 ShellSpan 用户真实项目的完整构建；专用账户新轮与完整 A/B 未完成。

DNS 全部查询入口共享活动预算：新增 RAII QueryBudget，现有 async QueryStorage 持有预算直到最后 caller/callback Arc 释放；新 sync cache-only 与 legacy cache-only 也在 native 调用前获取同一最多 4 个 slot，返回/错误后自动释放，不能绕过 async 的存量限制。独立局部计数器回归验证第 5 项拒绝、释放后复用及最终归零，不修改全局测试状态。完整默认测试 182 passed/13 ignored、Clippy 通过；实际 owned UDP 非响应接收端的超时取消/晚到 callback storage 释放测试显式运行通过。该资源约束不改变 87 或网络边界判定，完整 A/B 未完成。

专用账户同步 DNS cache-only 对照完成，固定 DnsSyncCache 单次脚本证据入口、默认能力及四项 SID 过滤器未改变。UUID 14db3887-438e-41b1-9847-308cc5f42047/SID 尾号 1110，helper PID 19200 实际 exit 0；根/实际后代 sync/async 同为 87，self-context equal/restored true，真实工具身份与 topology/停树 true，完整 workload 仍因 DNS/credential 未知失败。见 [实机回执](evidence/windows-stage-a-2026-10-09-dns-sync-cache-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-dns-sync-cache-system-recovered-profile.json)、[严格 OS 审计](evidence/windows-stage-a-2026-10-09-dns-sync-cache-system-os-audit.json)。独立恢复全部四项 true、债务空，当前 account/profile/hive/两 service absent true；本轮使用显式 hive 句柄与 SCM 枚举查询而非吞错 absence。实际两 context 87 保持 NO-GO、恢复绑定 UUID/SID/OS 四项回归通过，完整默认测试 181 passed/13 ignored、Clippy 通过。下一步需继续定位共同的 DNS 服务 admission，而不是异步回调；旧 crash hive、Git 与完整 A/B 未完成。

固定同步 cache-only DNS 对照已实施并实机：query_cache_only_sync 仅 owned 非 nil UUID .invalid 名称、NO_WIRE/NO_HOSTS/NO_LOCAL/NO_NETBT/NO_MULTICAST/FQDN，无 server/外部名称/回调；原有受控 child Job 期限保留，原 async gate 不变。ordinary 实测缓存未命中 9701，nil 拒绝；self-context 对照新字段默认兼容历史回执。共享源 LPAC 本轮根与真实后代的 sync/async 同为 dispatch/completion=87，context_equal/restored true，因此排除“只有异步模式失败”的解释，不把 87 当显式拒绝。见 [同步对照实机](evidence/windows-stage-a-2026-10-09-dns-sync-cache-shared-lpac.json)：完整 network matrix 仍失败，profile/停树/fixture ACL 均 true，无新增债务。两项新回归及完整默认测试 180 passed/13 ignored、Clippy 通过。专用账户同步对照尚未运行，DNS 网络闭包与完整 A/B 未完成。

当前上游替代线索核对：Microsoft [DNS_QUERY_REQUEST](https://learn.microsoft.com/en-us/windows/desktop/api/windns/ns-windns-dns_query_request) 与 [异步示例](https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/DNSAsyncQuery/cpp/DnsQueryEx.cpp) 的 callback/context 及非 pending 时无 callback 的约定，与现有 owned async storage/inline completion 分支一致，未得到 87 是结构缺陷的证据。Microsoft MXC 当前 [schema](https://raw.githubusercontent.com/microsoft/mxc/main/docs/schema.md) 的 enumeratePaths 明确依赖 BaseContainer/PSEC 1.1 fs_enumerate 且不兼容 leastPrivilege，不能将此查询权限作为当前 LPAC ancestor 修复；不能用旧 playground 搜索摘要（原 URL 当前 404）推断本机 DNS 错误。当前 OS 实查为 10.0.26200/x64，这也不能替代 PSEC 功能或新方案实际验收。未安装替代 SDK/改全局 DNS/放宽能力，DNS/Git 及完整 A/B 仍未完成。后续诊断应继续采用固定 owned 接收端与实际 Token 对照，不从外部方案名称推断边界通过。

DNS typed observation 的 completion_status/cancel_status 改为 required nullable：字段必须报告，显式 null 保持语义；缺失 cancel 不能被解释为未取消并通过 explicit denial。新增全字段逐项缺失、显式 completion null 不通过、未知字段拒绝回归；历史实际网络/DNS 回执仍保留原判定。完整默认测试 178 passed/13 ignored、Clippy 通过。本轮未改变实际 DNS API/Token/能力或 SID 过滤器，没有新实机分辨错误 87 的证据；默认 DNS admission 与 delegate 网络闭包仍未通过，完整 A/B 未完成。

DNS explicit denial 判定补齐立即失败一致性：dispatch 为 5/10013 时 completion 必须相同，不能把 dispatch=5/completion=10013 或反向矛盾回执判为已拒绝；正常成功派发/异步 pending 仍可接受显式完成拒绝。新增两种立即错误匹配/交叉矛盾/fixed-answer 冲突回归，完整默认测试 177 passed/13 ignored、Clippy 通过。未把 87/1702/超时/quiet receiver 降级为成功，internetClient 诊断的真实 DNS delegate 绕过仍保留且 NO-GO；网络安全闭包与完整 A/B 未完成。

恢复脚本共享 absence 查询已扩展到固定项目 matrix、private-network/DNS 单次恢复：hive 均使用抛异常的句柄查询；service 用有界固定名称集合和 ServiceController.GetServices，SCM 枚举异常传播，所有句柄 finally Dispose，拒绝未知名称/重复/超过 8 个。Windows PowerShell 5.1 显式加载 System.ServiceProcess，PS7 与 WinPS 回归均通过，所有脚本语法检查通过。旧 crash 恢复的 SAM 查询也不再 SilentlyContinue 吞掉错误，枚举失败中止，仅精确匹配且无重复才给 absence。对刚退役的 Git prefix UUID 98c04944-736d-4fe5-9cf4-eb6302fa412c 进行了当前 OS 只读重审：[严格重审](evidence/windows-stage-a-2026-10-09-git-prefix-system-strict-os-reaudit.json)，account/profile/hive/两 service 四项 absent true；未重新执行单次恢复或改写历史证据。1063/1065 旧债务与完整 A/B 仍未完成。

旧 crash hive 恢复门禁改为显式 Registry.Users.OpenSubKey 句柄查询，finally 关闭句柄，仅 null 返回 absent；访问拒绝/异常直接传播并停止恢复，不再依赖 Test-Path 的 false。固定 SID 仅接受账户 SID 格式，拒绝子键路径。PowerShell 7/Windows PowerShell 5.1 回归均通过（非法 SID/路径拒绝、实际不存在测试 hive 返回 boolean false、原 receipt 门禁全部保留）。当前 boot 仍为 2026-10-08 21:25:57，1063/1065 两个 profile Loaded=true，普通查询均 unknown/MethodInvocationException，不能宣称 hive absent；见 [本轮只读 OS 观测](evidence/windows-stage-a-2026-10-09-interrupted-hive-handle-query.json)。未派发恢复、未强制卸载/重启。旧债务仍需用户安排重启后由固定 elevated 恢复核验；完整 A/B 未完成。

Git prefix typed delivery 修正可空字段缺失被 Serde 自动解释为 None 的缺口：attributes/attributes_error/open_error/metadata_error/identity 均使用 required nullable deserializer，仍允许显式 null，但字段未报告不能被当成一次完整调用观测；path 同样必须存在。逐字段删除负例及 actual shared/dedicated 两轮回执均通过，4 项相关测试通过，完整默认测试 176 passed/13 ignored、Clippy 通过。设计第 5 节只允许明确范围内的必要 ACE，本轮未授予宿主祖先 ACL；Git 兼容性仍未修复，完整 A/B 未完成。

固定 --git-dir=. init 对照已否定相对参数方案：[ordinary](evidence/windows-stage-a-2026-10-09-git-relative-init-source.json) actual exit 0/repository/positive control/recycle true，[shared LPAC](evidence/windows-stage-a-2026-10-09-git-relative-init-lpac.json) actual exit 1、同样 HEAD absolute ancestor 错误、profile/ACL/停树 true，无新增债务。对应 Git 2.55.0.windows.3 [setup.c](https://raw.githubusercontent.com/git-for-windows/git/v2.55.0.windows.3/setup.c) init_db 调用 set_git_dir(...,1)，该分支执行 strbuf_realpath；不能用相对参数消除绝对 ancestor 检查。失败参数已从固定命令撤回，candidate 二进制重建，真实两轮证据加入现有回归且通过、Clippy 通过。下一步必须验证可保留 Git 常规文件工作流的路径/隔离方案，不能用 --version 或改用其他 ref backend 替代兼容性验收；完整 A/B 未完成。

专用账户 Git prefix 对照已完成：新增 fixed SYSTEM GitPrefixProbe enum/准备 CLI/主程序只读 child 分支，映像使用 owned fixture 冻结副本，保留 normal-only/恢复冲突及实际 Token/Job 门禁，stdio 经同 root/order/状态 typed delivery 验证。固定脚本新增 GitPrefix 单次证据分支，并修正原 PowerShell case 列表重复嵌套表达式。UUID 98c04944-736d-4fe5-9cf4-eb6302fa412c/SID 尾号 1109，helper PID 28976 实际终止 exit 0；受限 child exit 73、prefix_report_bound/topology/停树 true，C:\\ 与 C:\\ProgramData attributes/open 均为 5，owned root/output 的 metadata/identity 成功。见 [专用探针](evidence/windows-stage-a-2026-10-09-git-prefix-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-git-prefix-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-git-prefix-system-os-audit.json)。独立恢复 account/profile/filter/credential 全部 true、债务空、四项 OS 缺席 true。实际回执及恢复 UUID/SID 回归通过，完整默认测试 176 passed/13 ignored、Clippy 通过。这进一步支持逐级 ancestor stat 与 Git init 失败有关，但未直接追踪 Git syscall、未修复 Git 工作流；下一步评估不扩大宿主 ancestor 权限的 Git 路径方案。完整 A/B 未完成，未提交推送。

Git prefix delivery 增加独立协议回归：缺失观测、重复路径、attributes 与错误同时存在、open/metadata 错误与 identity 同时存在、成功路径缺少 identity、attributes 成功/错误均缺失全部拒绝；同时保留 attributes 查询失败而 handle/metadata 成功的合法组合，两个 Win32 调用不强制同结果。3 项相关测试通过；完整默认测试 175 passed/13 ignored、Clippy 通过。本轮未运行新的专用账户探针，ProgramData 祖先对照与完整 A/B 仍未完成，未提交推送。

只读 Git prefix 探针已接入固定受控子进程：GitPrefixProbe CLI 仅使用当前冻结 probe 映像与 controller-owned SSPA_FIXTURE，child 拒绝 elevated primary/已有 thread impersonation/未知线程 Token，返回版本/root/有界观测。controller/source 同句柄 stdio 的 typed delivery 拒绝未知字段、根不匹配、路径顺序/数量变化、矛盾成功/失败字段和零错误码；现有实际工具身份/Job/停树门禁保留。ordinary 与共享源 LPAC 两轮实际 exit 73/report bound true，LPAC profile/ACL/停树清理 true。LPAC owned root/output 的 desired-access 0 open 与文件身份查询成功；C:\Users 等祖先 open=5，C:\/C:\Users/用户目录 GetFileAttributes=5，AppData/Local/Temp 的 attributes 成功但同 Git stat open=5。见 [ordinary](evidence/windows-stage-a-2026-10-09-git-prefix-source.json)、[shared LPAC](evidence/windows-stage-a-2026-10-09-git-prefix-lpac.json)。这与 Git path.c 逐级 stat 失败相符，是 shared 路径的实际祖先 admission 证据，不是所有 Git 内部 syscall 的直接追踪或专用 ProgramData 根因证明；尚未接入专用 SYSTEM enum，不修改宿主 ancestor ACL/不添加环境访问能力。真实回执及协议负例回归通过，完整默认测试 174 passed/13 ignored、Clippy 通过。下一步验证专用 ProgramData 祖先，并评估不扩大宿主访问面的 Git 路径方案；完整 A/B 未完成。

Git 目录失败的只读诊断基础已新增 git_prefix_probe：只接受本地 Disk 前缀、绝对 owned UUID root，最多 32 个祖先/32768 UTF-16 units；固定观察 root/output 的祖先，分别 GetFileAttributesW 和与对应 Git mingw_stat 相同的 desired-access 0/share RWD/backup-semantics CreateFileW，成功句柄取实际卷号/file ID 后关闭，立即捕获各阶段 GetLastError，无 mkdir/目录枚举/数据读取/ACL 变更。ordinary owned output 实际 identity/open 成功且目录仍为空的回归、relative/UNC 拒绝及 Clippy 通过。原版本 [path.c](https://raw.githubusercontent.com/git-for-windows/git/v2.55.0.windows.3/path.c) safe_create_leading_directories_1 明确逐级 stat，失败后才 mkdir 并检查重试；已有 HEAD 错误不能区分哪级祖先失败。该新探针尚未接入 LPAC/专用 root，不把 ordinary positive 推断为根因或兼容性修复；下一步接入既有受控 Job 子进程并与准确 Token/UUID 回执绑定，完整 A/B 未完成。

专用 Git init 对照完成，UUID 24a277fd-6ec9-4d63-9920-a30b6a54c6a7/SID 尾号 1108：新增 fixed GitBundleInit SYSTEM enum/精确准备 CLI，复用固定五文件 bundle，root SDK 两种创建入口 cwd 均固定 owned output，normal-only/recovery 冲突及普通撤销预算保持。ProgramData 夹具同样 exit 1/cannot lock ref HEAD/unable to create directory，准确 user/package/capability/执行树及停树核验通过，repository_verified=false。见 [专用回执](evidence/windows-stage-a-2026-10-09-git-init-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-git-init-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-git-init-system-os-audit.json)。helper PID 13776 首次 30s 观察仍 live，随后同一 PID handle missing；全部七份证据已发布，未重复启动，helper exit code 未采集不能声称 0。独立恢复清空全部本轮债务，账户/profile/WFP/credential true，OS 四项缺席 true。真实失败与恢复同 UUID/SID 回归、new enum normal-only/恢复冲突测试已补齐。原版本源码 [refs/files-backend.c](https://raw.githubusercontent.com/git-for-windows/git/v2.55.0.windows.3/refs/files-backend.c) 表明此文本来自 safe_create_leading_directories 失败分支，位于真正 lock-file 创建调用之前；[mingw_stat](https://raw.githubusercontent.com/git-for-windows/git/v2.55.0.windows.3/compat/mingw.c) 会对目录 CreateFileW desired-access 0，不能仅凭错误文本认定文件写权不足。该源线索还没有 actual Win32 操作证据；下一步应以固定 root/祖先 metadata/admission 对照定位，不修改共享 ProgramData/用户目录 ACL 或放宽能力。完整 A/B 未完成。

Git 工作流初测新增固定 GitBundleInit：仅 git init --bare --template= --initial-branch=main，shared LPAC 复用五文件 frozen Git bundle；无任意路径/参数，继承现有隔离环境/stdio/准确 Job。第一轮沿用工具通用 System32 cwd，ordinary 与 LPAC 均 exit 128，Git 读取该目录 config 被拒绝；两个失败证据保留，不作为仓库初始化成功。该新操作 cwd 已改为 owned output，普通再次 init 返回 0、HEAD=refs/heads/main/config bare=true/objects/refs 结构核验与回收通过。共享源 LPAC 改 cwd 后仍 exit 1、准确 topology true，cannot lock ref HEAD/unable to create directory，profile/fixture ACL/停树均清理 true，无新增债务。见 [普通 owned cwd](evidence/windows-stage-a-2026-10-09-git-init-owned-cwd-source.json)、[LPAC 失败](evidence/windows-stage-a-2026-10-09-git-init-owned-cwd-lpac.json)。初始化验证器要求 owned UUID fixture，未开放任意目录；新增真实回执回归明确普通 positive 不替代 LPAC 仓库 gate，完整默认测试 172 passed/13 ignored、Clippy 通过。原 Git --version 成功不能证明 Git 文件工作流兼容。下一项需专用账户 ProgramData 夹具对照和实际文件/目录操作定位；尚未接入该 SYSTEM 工具 enum，也未验证对象写入或真实项目，完整 A/B 未完成。

完成清单按当前证据重新核对：A7 补入专用账户 C# 编译/落盘及执行字节摘要绑定，保留真实项目、完整工具依赖和版本闭包未验收；A1 补入仅临时 identityServices 时 owned SYSTEM credential Win32 5 与 LSA admission 开放，明确默认 1702/完整跨槽与 broker 仍未验收。当前 OS boot 为 2026-10-08T21:25:57.7053630+08:00，旧 SID 1063/1065 的 Win32_UserProfile.Loaded 仍 true；普通上下文直接 OpenSubKey 对各 hive 均 Access Denied，状态必须记为 unknown，不能将 Test-Path false 误作不存在。已有固定恢复脚本要求提升且 ErrorActionPreference=Stop，不会用本轮普通上下文 unknown 开放恢复；未自动重启、未改旧账户/WFP。两个旧 profile 恢复仍是外部依赖，但可继续推进真实工具工作流；下一项 A7 应验证 Git 自有仓库创建/对象写入与后代依赖，而不是重复 --version 或只增加 compiler 探针检查。完整 A/B 未完成。

固定 DLL 校验补齐执行字节摘要绑定，专用 UUID 47eefd27-62fd-4386-be00-eb88f748c666/SID 尾号 1107：固定 child 从磁盘读完整 DLL byte[]，SHA256.HashData 计算大写 64-byte hex，并 Assembly.Load 同一 byte[] 后调用固定方法，摘要仅写 owned output/powershell-fixed-build.sha256。controller 持有 DLL/摘要的 nofollow 原句柄、各自单链接/有界大小，使用与主仓库相同版本 sha2=0.11.0 计算 DLL 实际字节摘要并严格匹配，未知/小写/非 hex/长度错误拒绝；同长度修改即使 PE 静态导入仍合法也拒绝。此摘要来自本轮固定 child，不是签名或独立任意代码来源证明，不可推广到允许模型执行任意命令的产物。ordinary/shared LPAC/dedicated 实机全部通过（没有 lpacCryptoServices/网络权限），专用 exit 73/产物/DLL true；helper PID 22396 终态 exit 0，独立恢复债务空与四项 OS 缺席 true。见 [ordinary](evidence/windows-stage-a-2026-10-09-powershell7-digest-build-source.json)、[shared LPAC](evidence/windows-stage-a-2026-10-09-powershell7-digest-build-lpac.json)、[专用](evidence/windows-stage-a-2026-10-09-powershell7-digest-build-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-powershell7-digest-build-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-powershell7-digest-build-system-os-audit.json)。新增标准 SHA256 abc 向量、同长度变更、非规范摘要和真实硬链接负例；完整默认测试 171 passed/13 ignored、Clippy 通过。静态 PE synthetic positive 只测试静态/摘要函数，managed 执行由实际 child 证据证明。此前无摘要 build_dll_verified 回执仅证明旧范围，不能单独证明新摘要门禁；真实项目及完整 A/B 仍未验收。

固定编译升级为落盘 DLL 后重新加载执行，专用账户 UUID f3603154-a57c-474f-956f-f073b207ce63/SID 尾号 1106：Add-Type -OutputAssembly 只写本轮 output/powershell-fixed-build.dll，Assembly.LoadFile 从该固定位置加载并通过反射调用 FixedBuild.Render，结果生成既有 25-byte text artifact。控制端经 held nofollow/single-link/512..65536-byte 门禁、完整 PE 静态解析与唯一 mscoree.dll 导入核验 DLL 身份；这是静态 PE 检查，实际 managed 加载/执行由固定 child 正向证明，不能把静态导入等同完整 CLR metadata/authenticity 验证。ordinary/shared LPAC/dedicated 三类实际 exit 73、DLL/文本产物均通过，共享 profile/ACL 退役 true，专用 actual user/package/capabilities/topology/停树 true、error null、DLL 2560 bytes。单次提升 helper PID 6636 终态 exit 0；独立恢复债务空、账户/profile/WFP/credential 全部退役，OS 四项缺席 true。见 [ordinary](evidence/windows-stage-a-2026-10-09-powershell7-persisted-build-source.json)、[shared LPAC](evidence/windows-stage-a-2026-10-09-powershell7-persisted-build-lpac.json)、[专用账户](evidence/windows-stage-a-2026-10-09-powershell7-persisted-build-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-powershell7-persisted-build-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-powershell7-persisted-build-system-os-audit.json)。新增缺失/损坏 PE/大小超限及真实身份/产物/同 UUID/SID 恢复回归；完整默认测试 169 passed/13 ignored、Clippy 通过。此前 controller_tool=build 回执只证明 in-process 编译，不含 build_dll_verified，不能作为新落盘门禁证据。真实项目工具链、DNS/broker/跨槽与旧 hive 恢复、完整 A/B 仍未完成。

ref 复制入口收紧并增加实际对象负例：只有直接位于 owned UUID fixture 下的精确 ref 子目录可用，新增 DLL-only 门禁，EXE/runtime manifest、路径穿越与嵌套路径拒绝；原 root 的固定映像规则保留。真实复制字节与重复 create_new 拒绝、保持副本 lease 时 ref/父 UUID 目录重命名失败均通过。用固定 System32 cmd 创建本轮 owned junction 的实机回归证明 ref junction 拒绝，目标 sentinel 字节不变且未创建引用副本；测试对象走回收站。完整默认测试 167 passed/13 ignored、Clippy 通过。此为编译依赖准备/持有对象边界的补充，不能替代专用账户所有 reparse/跨卷/并发替换矩阵、真实项目或 DNS/broker 隔离；完整 A/B 未完成。

专用账户固定 C# 编译实测完成，UUID 15af052b-25e0-4163-96e3-830d34dc7b5a、SID 尾号 1105：新增精确 PowerShell7RuntimeBuild enum/CLI 准备入口，normal workload 与 recovery/lifecycle 冲突校验保持，runtime/observer/恢复预算沿相同固定声明选择；使用 registryRead/lpacInstrumentation 和 471 frozen files（242,562,201 bytes），没有网络或身份服务能力。actual user/package/capabilities、准确执行树拓扑/停树均 true，编译 exit 73、artifact 25-byte/identity/content/output 通过，controller error null。单次提升 helper PID 9356 终态 exit 0；独立恢复 account/profile/WFP/credential 全部 true、cleanup debt 空，OS 账户/profile/hive/两服务缺席均 true。见 [专用账户编译](evidence/windows-stage-a-2026-10-09-powershell7-build-system-profile.json)、[独立恢复](evidence/windows-stage-a-2026-10-09-powershell7-build-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-powershell7-build-system-os-audit.json)。真实回执回归绑定 controller_tool=power_shell7_runtime_build、身份/产物/同 UUID/SID 恢复与 OS 缺席；内部 tool_admission 仍沿用旧 runtime 标签，须以 controller_tool 与准备回执区分本轮编译，不把旧 startup 回执视为 build。新增 enum 同样覆盖 normal-only/恢复冲突门禁。完整默认测试 165 passed/13 ignored、Clippy 通过。此为固定 in-process C# compiler 行为，不替代用户真实项目、npm/Git 构建链、系统服务/跨槽网络边界、旧 crash hive 或完整 A/B；尚未提交推送。

共享源 LPAC 固定 C# 编译与完整清理已实测通过：build-only prepare_build 在原平面 engine 外冻结固定 ref DLL 清单（本机 167 个，合计 471 文件），源目录只读 lease、各源及副本 lease 保留，固定 root/ref 目的地同时持有父目录，create_new/字节与文件身份核验、intent/completion 先于 package grant；未知类型、嵌套目录、缺少核心引用、192 ref/480 total/320 MiB 超限拒绝。正常工具入口仍使用平面 prepare。新目录先持有 creator/SYSTEM OICI 权限，package FRFX 显式授权，不向可执行环境开放任意路径。首轮源目录错误请求 WRITE_DAC 被拒绝且清理通过，已改只读；下一轮 ref ACL 去除继承使子文件读权丢失，已修正 OICI；按确切 UUID/root identity/471 frozen destination/owner 核验与复原 creator inheritance 后精确撤销并删除本轮 profile。后续编译 exit 73/artifact true，但 524 个实际对象超过旧 512 撤销预算；runtime 专用预算调整为明确 768（普通 fixture 仍 64），该 UUID 精确恢复通过。两份恢复记录保留：[继承债务恢复](evidence/windows-stage-a-2026-10-09-powershell7-build-reference-recovery.json)、[预算债务恢复](evidence/windows-stage-a-2026-10-09-powershell7-build-reference-budget-recovery.json)。最终 [完整编译回执](evidence/windows-stage-a-2026-10-09-powershell7-build-reference-final-lpac.json) actual exit 73、准确 topology/artifact true、error null、process tree/profile/fixture ACL 清理均 true。新增真实回执与引用类型/缺失回归，两个单次 ignored 恢复显式运行通过；完整默认测试最终 164 passed/13 ignored，Clippy 通过。首次完整测试 DNS self-context 曾短暂失败，原因未确定，两次随后完整运行通过，断言已增加 equal/restored/error 诊断；不能将此说成稳定性问题已修复。专用账户编译入口尚未接入，真实项目/工具构建和完整 A/B 仍未验收，生产 unavailable。

编译模块依赖进一步定位：固定 installed manifest 的 NestedModules 指向已在 304-file owned 平面清单内的 Microsoft.PowerShell.Commands.Utility.dll；固定编译命令现显式 Import-Module $PSHOME 下该 DLL，无任意模块名字或搜索路径。普通正向再次编译/产物/exit 73/清理通过；共享源 LPAC 成功越过模块导入，在 Add-Type 报缺失 owned $PSHOME/ref、exit 1，准确 topology true，profile/执行树/fixture ACL 清理 true，不能算编译成功。见 [普通显式模块对照](evidence/windows-stage-a-2026-10-09-powershell7-build-explicit-module-source.json)、[LPAC 引用目录失败](evidence/windows-stage-a-2026-10-09-powershell7-build-explicit-module-lpac.json)。实机 ref 目录共有 167 个文件/6,045,680 bytes；尚未复制或授权。下一步必须冻结此固定依赖目录与每项源/副本身份、禁止 reparse/替换、先发 intent 再复制/授权并纳入撤销预算，而非添加 ambient PSModulePath 或读取宿主个人模块。真实两轮回执回归与 Clippy 通过，完整 A/B 未完成。

固定 PowerShell 7 C# 编译探针接入共享源入口：仅固定 Add-Type 源码，调用编译类生成既有 25-byte owned artifact，原句柄/单链接/内容门禁不变，无任意代码或参数入口。普通 --run-source-powershell7-build-control 编译、artifact、实际 topology/exit 73、停树及回收全部通过；source 显式环境现在绑定 owned SSPA_FIXTURE。第一次 LPAC 未声明 instrumentation，在 ETW 初始化 Win32 5 后超时，证据保留；补齐与现有 PowerShell runtime 相同的 registryRead/lpacInstrumentation 后 LPAC exit 1、准确 topology true，Add-Type 在加载 Microsoft.PowerShell.Utility 时明确失败，未执行编译、artifact 未验收。两轮 profile/ACL/执行树均已退役。见 [普通编译对照](evidence/windows-stage-a-2026-10-09-powershell7-build-source-control.json)、[无 instrumentation 对照](evidence/windows-stage-a-2026-10-09-powershell7-build-shared-source.json)、[模块依赖失败](evidence/windows-stage-a-2026-10-09-powershell7-build-instrumentation-shared-source.json)。新增真实回执回归，完整默认测试 162 passed/11 ignored、Clippy 通过。当前 owned 平面 runtime 仅 304 个文件，不含完整 Modules；下一步需冻结、预算并持有实际编译模块及其依赖，再验证专用账户构建，不能将 exit-only admission 或本轮 ordinary positive 标为完整 A7 通过。

Git 固定版本门禁收紧为精确 2.55.0.windows.3（允许正常 LF/CRLF，stderr 必须为空）；此前仅校验 alphanumeric 版本输出格式，会接受错误版本或任意文字。固定普通 runtime 再次返回该版本，回归新增相邻 Windows patch、无 Windows 后缀及非版本字符串拒绝，并保留历史真实专用账户/共享源回执测试。完整默认测试 161 passed/11 ignored、Clippy 通过。该检查只绑定已有 --version admission 证据，不代表 Git 工作流、构建工具或完整版本闭包已验收。

凭据 self-context 探针不再用 env::var(...).ok() 将无效 Unicode 引用降级为缺失；仅 NotPresent 可省略可选探针，NotUnicode 明确失败且不转储原值，空串仍进入固定 UUID/SID 引用匹配并拒绝。新增未配/空串/孤立 UTF-16 surrogate 回归，不修改全局环境。默认 startup capability 派生入口复核均调用共享白名单，未发现其他派生入口；完整默认测试 161 passed/11 ignored。此输入校验修复不替代跨槽或真实 broker 授权验收。

专用账户身份服务单能力对照完成，UUID bf535a39-9079-46bb-bb51-cbe084950f99、SID 尾号 1104：临时仅加 lpacIdentityServices，无网络能力；159 项回执仍因八项 DNS API 87 严格失败。自有 SYSTEM credential 的正向控制成功，LPAC 根与真实 leaf 在匹配、恢复确认的 self context 中均得到明确 Win32 5（此前默认方案为未知 1702）；LSA admission 同时变为成功，说明能力扩大服务访问面，不能直接加入默认方案。见 [实测](evidence/windows-stage-a-2026-10-09-identity-credential-system-profile.json)、[独立恢复](evidence/windows-stage-a-2026-10-09-identity-credential-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-identity-credential-system-os-audit.json)。本轮账户/profile/WFP/credential/namespace 债务全部清空，实际账户/profile/hive/两服务缺席；单次 helper 终态 exit 0。临时白名单及能力列表已逐字恢复，全部原型 binaries 按默认源码重建；真实回执回归及 Clippy 通过。完整默认测试现在 160 passed/11 ignored，ignored 实机矩阵不能按默认测试成功替代。跨槽凭据、broker 授权及新增服务访问面未验收，默认 credential 1702、DNS 受托绕过、两个旧 crash hive 和完整 A/B 仍未解决。

旧 profile 恢复门禁补齐 credential reference 类型验证：存在且非 null 的引用必须为非空白字符串，false/0/空串/空白/对象不能利用 falsey 值跳过校验，也不能将此类记录认定为已退役。PS7 与 Windows PowerShell 5.1 回归通过；该修复不解除仍加载的旧 hive，也不自动重启系统。

默认 startup capability 白名单已合并到共享 startup_capability_policy，candidate 与 SYSTEM controller 两个 SID 派生入口在任何派生操作前共同验证；只接受精确 registryRead/lpacInstrumentation。新增边界回归覆盖 internet/clientServer/private network、enterpriseAuthentication、identity/crypto/COM/service management、大小写/空白/空串拒绝，保留现有实际 SID 数量/Token 精确集合门禁。此为防止诊断能力回流默认方案的代码修复，不表示 DNS/WFP 闭包已通过。完整测试 159 passed/11 ignored，Clippy all-targets 与全部原型 bins 构建通过；未新增系统权限或派发账户，完整 A/B 未完成。
固定 legacy DnsQuery_W cache-only 对照已加入：无 server list/任意名字/任意 options，只接受非零 UUID，返回 records 若意外存在立即按 SDK Free；unsigned Win32 status 经检查转换到签名观察类型。普通 explicit 实机 completion=9701、无记录；共享源 LPAC root/leaf legacy API 均 87，和 DnsQueryEx 相同，不能将未知仅归因于新版结构或异步形态。见 [legacy 缓存 API 实测](evidence/windows-stage-a-2026-10-09-dns-legacy-cache-shared-source.json)。基础门禁 156 项（专用账户含 credential 共 159），本轮 148/156 通过，profile/ACL 清理 true，无新增债务。同步 legacy 调用仅在独立诊断子进程内、cache-only，仍受 owned Job 的父级超时/停树约束，不进入 Tauri 主线程；系统不响应不算拒绝。真实失败回执已回归，完整测试 158 passed/11 ignored、Clippy 通过。DNS 受托绕过、credential 1702、旧 hive 恢复及完整 A/B 缺口仍未解决。
DNS 代办绕过后的 WFP 修正路线核对：微软 [proxied connections tracking](https://learn.microsoft.com/en-us/windows-hardware/drivers/network/using-proxied-connections-tracking) 将 ALE_ORIGINAL_APP_ID 定义在有连接重定向/追踪记录的代理路径，涉及 callout redirect handle/record；没有保证任意 DNS RPC 调用会在服务网络连接上保留账户或原应用身份。[layer condition 表](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-conditions-available-at-each-filtering-layer) 列出的 NAME_RESOLUTION_CACHE 条件也不能证明发送前阻断 DNS query。不能仅新增 ORIGINAL_APP_ID/PACKAGE_ID/cache layer 静态条件就宣称阻止受托服务外发，更不能全局 block DNS service 或修改共享系统 ACL 来影响宿主。A5 核对表现明确记录真实受托流量反例和 SID 闭包 NO-GO，取代仅“其余未验收”的弱描述。当前默认候选仍无网络能力；87 对照有关联但未放宽为正式拒绝。下一项应验证被限定的调用者上下文/服务入口的实际闭包，或完成有独立网络边界的替代低层方案；未实现的 broker/账户池不能绕过 A gate。
账户 SID WFP + internetClient 的独立专用账户对照发现 DNS 实际绕过，UUID a35eaf57-97cc-493a-bf40-edf5da48fadc、SID 尾号 1103。临时仅在固定 SYSTEM admission primary/准确 Job 期望中加 internetClient，不解除四项持久账户 SID 过滤器；actual user/capabilities 验证 true。真实 leaf UDP/TCP DNS 均 pending→0、固定 records/answer=true，自有 receiver 前后控制有效，UDP/TCP 净计数各 1；账户 SID 层不能作为 DNS 受托服务隔离闭包。root 在原 normal 预算内超时（wait=258/exit=259），回执仅 132 项/不完整，不推断 root 全范围通过。process_tree_stopped/workload_retired=true，独立恢复清空账户/profile/WFP/credential/namespace 全债务，OS 四项缺席 true。见 [专用账户绕过证据](evidence/windows-stage-a-2026-10-09-dns-sid-block-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-dns-sid-block-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-dns-sid-block-system-os-audit.json)。原 source 白名单、startup capabilities/observer 期望已逐字恢复，prototype binary 已按原源码重建；单次 helper 终态 exit 0，未保留网络能力或扩大系统权限。新增真实绕过回归和 Clippy 通过。此为明确 NO-GO 证据，不能给默认离线候选添加 internetClient 或以 SID block 代替 LPAC network denial；完整 A/B 未完成，需要调整低层网络/服务边界方案。
internetClient 单能力固定诊断得到关键对照：共享源 LPAC root/leaf cache-only 与 self cache completion=9701（此前无网络能力为 87）；四项 owned DNS UDP/TCP wire query 均 pending→0、固定 records/answer=true，自有 UDP/TCP receiver 前后 native controls 有效，净计数各 2。多个 TCP listener/connect/private TCP 负例亦被突破，总门禁仍严格失败。见 [网络单能力实测](evidence/windows-stage-a-2026-10-09-dns-internet-capability-shared-source.json)。这提供“原 87 与缺少网络能力相关”的实际对照，不等于可忽略未知错误或 complete；默认离线候选绝不能保留该能力。已逐字恢复原白名单/能力列表并重新构建原 binary，profile/ACL 清理 true，无新增债务；真实 DNS success+receiver traffic 已加入回归，相关测试/Clippy 通过。后续如验证账户 SID WFP 与 DNS 系统代办，必须用专用账户持续 SID block，在保留失败/未知语义下证明能否封锁受托服务的实际流量；共享源不代表专用账户 WFP。完整 A/B 仍未完成。
lpacCryptoServices 单项诊断也已实测：同一固定夹具与准确能力集合，root/leaf LSA self admission 仍 c0000022、六项 wire/cache DNS 均 87；numeric local positive 仍成功。见 [加密服务单能力对照](evidence/windows-stage-a-2026-10-09-dns-crypto-capability-shared-source.json)。该能力未解决问题，源白名单/能力列表已逐字恢复并重新构建原 candidate，profile/ACL 清理 true。回执已加入严格失败回归；默认白名单新增显式拒绝 identity/crypto 两项的断言（不添加能力），相关回归与 Clippy 通过。没有叠加身份/加密/企业认证或开启网络能力，完整 A/B 仍未完成。
有固定 Chromium 源码线索后的单能力诊断已实测：仅临时加入 lpacIdentityServices（无 internet/private/enterpriseAuthentication/crypto capabilities），共享源 LPAC root/leaf actual 能力集合包含该声明，LSA self admission 从 c0000022 变为 0，返回 handle 并成功关闭；但 wire/cache/self DNS 仍全部 87、numeric local 仍成功。因此该能力确实扩大服务访问面，却没有解决 DNS，未保留。见 [单能力对照](evidence/windows-stage-a-2026-10-09-dns-identity-capability-shared-source.json)。profile/ACL 清理 true；源白名单与能力列表已逐字恢复、candidate binary 已按原源码重新构建，避免留下扩大权限的可执行产物。结构化回执回归覆盖 LSA positive 不能替代 DNS denial，原 fixed-capability 拒绝测试、相关回归和 Clippy 通过。完整 A/B 仍未完成，手动重启询问仍等待用户答复；未自动重启或解除旧 SID 隔离。
LPAC DNS/RPC 能力排查获得固定源码线索：Chromium commit c98af87039d818ab3ff734c1262244d5aaa96710 的 [SetupAppContainerProfile](https://chromium.googlesource.com/chromium/src/%2B/c98af87039d818ab3ff734c1262244d5aaa96710/sandbox/policy/win/sandbox_win.cc) 在 kNetwork 路径同时加入 privateNetworkClientServer、internetClient、enterpriseAuthentication、lpacIdentityServices、lpacCryptoServices；[132.0.6832.1 capability 声明](https://chromium.googlesource.com/chromium/src/%2B/refs/tags/132.0.6832.1/sandbox/policy/win/lpac_capability.h)将后两者列为系统能力。这是第三方网络服务的组合配置，既不证明单项 DNS 必需，也不是 ShellSpan 默认离线安全性证据；未复制其能力集、未修改生产权限。当前 child whitelist 仍只有 registryRead/lpacInstrumentation。下一项能力对照若实施，必须固定单一声明/实际 SID 与准确能力集合，专用非管理员账户/WFP 封锁和 owned receiver 保持，先 NO_WIRE cache admission，再完整 owned wire/credential/外部对象负例；任何 DNS 到达自有 receiver 或 credential 对象可读均否决该候选，87/1702 不得算拒绝。还需拒绝未声明能力及跨槽/服务代办，不能用启动兼容性换取更宽授权。A/B 未完成。
专用账户最新 DNS numeric/cache/self 范围实测完成，UUID d6acc8ac-a582-4365-ae24-d14975b51123、SID 尾号 1102。157 项中 150 通过：root/leaf numeric local 正向与同身份上下文/恢复通过；六项 wire/cache-only API 均 87，SYSTEM credential 仍 1702，严格失败。24 KiB 完整报告预算实际可读，真实执行拓扑/停树已确认。固定独立恢复已清空本轮 namespace/账户/profile/WFP/credential 债务，实际 OS 账户/profile/hive/两服务缺席；helper 已终态 exit 0。见 [专用账户实测](evidence/windows-stage-a-2026-10-09-dns-contexts-system-profile.json)、[回收](evidence/windows-stage-a-2026-10-09-dns-contexts-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-dns-contexts-system-os-audit.json)。新真实失败回执与恢复绑定已加入回归，相关测试、Clippy 通过；旧两个 loaded crash hive 与完整 A/B 缺口仍存在，生产 unavailable，未提交/推送。
DNS self-context comparison 已在共享源 LPAC root/真实 leaf 实际运行，复用现有 self token 完整 user/package/capability/integrity/authentication signature 与恢复守卫：两进程 security_context_equal/restored=true，原线程身份恢复；self cache-only 仍 dispatch/completion=87，LSA connection=c0000022/no handle。因此同身份线程模拟未修复 DNS，不能将 comparison positive 当作 denial。见 [实际同身份对照](evidence/windows-stage-a-2026-10-09-dns-self-bound-shared-source.json)。基础集合 154 项、专用账户加 credential 共 157；shared 148/154 通过，profile/ACL 清理 true，无新增债务。结构化新回执已回归覆盖 self 87 保持失败。新增结构化上下文使完整报告靠近原预算，Workload 同句柄字节上限明确改为 24 KiB，leaf/ordinary credential 仍 4 KiB；现有每种报告的超限/reparse/hardlink/同句柄测试随规格验证，不接受无界报告。完整测试 157 passed/10 ignored，Clippy 通过；专用账户最新 numeric/cache/self 范围仍未实测，完整 A/B 未完成。
cache-only 同步调用形态已实际对照：仅该模式 callback/context=NULL，普通 exact UUID cache miss 9701 的显式实机测试通过；共享源 LPAC root/leaf cache admission 仍 dispatch/completion=87、无 records，profile/ACL 清理 true。见 [同步缓存形态实测](evidence/windows-stage-a-2026-10-09-dns-cache-sync-shared-source.json)。因此当前失败不限于 custom-server list，也不限于异步 callback 形态；同步改动未解决问题，已恢复原异步等待/取消/存储所有权实现。该失败仍未知，不能放宽为显式拒绝；需要继续诊断非数字名 DNS 服务调用与 LPAC/RPC admission，完整 A/B 未完成。
cache-only 已新增显式实际接收窗口回归：自有 UDP/TCP:53 resolver 前后 positive 保持有效，在窗口内以另一全新 UUID（对照未查询过）进行 NO_WIRE_QUERY/no-server cache lookup；实际 completion=9701、无记录/取消/超时，结束净计数 `[0,0]` 且重复 finish 不改变终态。未知 UUID 若到达自有 resolver 会触发其失败门禁。该证据只证明自有接收窗口无查询，禁止 wire 的语义来自固定请求选项与 SDK 文档，不能据此外推所有系统/远端流量。相关 ignored 实机测试、原 timeout/cancel/release-storage 显式实测及 Clippy all-targets 通过。LPAC 非数字 DNS 87、credential 1702 与完整 A/B 缺口仍未解决。
DNS cache-only/no-server 对照已实现并实测：仅本 UUID 固定 .invalid question，NO_WIRE_QUERY 加禁 hosts/local/NetBT/multicast/FQDN；不提供 server list，不修改系统 resolver。微软 [query options](https://learn.microsoft.com/en-us/windows/win32/dns/dns-constants) 说明 NO_WIRE_QUERY 只查本地缓存。普通 explicit 实测 pending=9506、completion=9701（RECORD_DOES_NOT_EXIST）、无记录；最初假定 9501 的测试失败已纠正为实际 SDK cache miss 9701。共享源 LPAC root/leaf cache-only 均立即 87，与 wire 四项相同，而 numeric local 两项为 0。因此不能把问题仅归因于 custom-server list，非数字名服务 admission 仍未知；cache miss 不作为访问拒绝。见 [实际缓存对照](evidence/windows-stage-a-2026-10-09-dns-cache-only-shared-source.json)。基础门禁 152 项（专用账户加 credential 共 155），本轮 146/152 通过、profile/ACL 清理 true；最新失败回执已结构化回归，完整测试 156 passed/9 ignored、Clippy 通过。专用账户 numeric/cache 新范围仍未验收，完整 A/B 未完成。
DNS custom-server query options 缩减已实际对照：仅保留 BYPASS_CACHE|WIRE_ONLY（TCP 加 USE_TCP_ONLY），普通 owned UDP/TCP positive 均通过；共享源 LPAC 150 项中仍只有四项 custom-server root/leaf API=87 失败，numeric local positive 保持成功，receiver 前后控制/零计数通过，profile/ACL 清理 true。见 [选项缩减实测](evidence/windows-stage-a-2026-10-09-dns-wire-options-shared-source.json)。该缩减没有解决未知结果，已恢复原显式 cache/hosts/local/NetBT/multicast 选项，不保留无效生产参数变更。下项应以固定 UUID、null server list 的 cache-only（禁止 wire）路径区分 custom-server 结构与非数字 DNS 服务 admission，不能发送到系统配置的远端 resolver 或将 cache miss 当作联网拒绝。A/B 门禁仍失败。
DNS numeric-local calibration 已接入固定 root/leaf：只请求 literal 127.0.0.42、无 server list/自定义 options，按微软 DnsQueryEx 数字 IPv4 同步路径作 API admission 对照，不是网络隔离证据。普通 explicit 实机 positive 通过；共享源 LPAC root/leaf 均 dispatch/completion=0、records=true、固定域名/类型/长度/地址校验通过，而指定自有 server list 的 UDP/TCP 仍均 87。故 API 并非整体不可用，未知集中于 custom-server 请求路径，尚不能认定拒绝。基础门禁扩大为 150 项，专用账户含 3 credential 为 153；本轮共享源 146/150 通过，profile/ACL 退役 true，聚合失败保持。见 [最新 numeric-local 实测](evidence/windows-stage-a-2026-10-09-dns-numeric-local-shared-source.json)。结构化真实回执已回归覆盖数字地址 positive 不替代网络 denial，完整测试 156 passed/8 ignored、Clippy 通过。专用账户新 numeric scope 尚未实测，A/B 未完成。
域名绑定及立即失败状态修正后的共享源 LPAC 已重新构建并实测：[最新回执](evidence/windows-stage-a-2026-10-09-dns-name-bound-shared-source.json)148 项中 144 通过，root/leaf UDP/TCP 四项均精确 dispatch/completion=87，records=false；自有两 DNS receiver 前后 native positive 成功且净计数为零。完整失败导致聚合 receiver_quietness_verified=false（候选只在全部矩阵通过后发布该聚合），不能把单项 receiver 通过外推为整体验证成功。profile_removed/fixture_acls_revoked=true，本轮无新增债务。最新回执已加入结构化失败回归，相关测试、Clippy all-targets 通过；独立 persistent DNS receiver 的实际窗口计数、quiet、未知 question/重复 finish 终态测试也显式通过。原 DNS/credential 与完整 A/B 缺口仍存在。
最近 DNS 修正后的完整原型 cargo test --locked 已通过：156 passed、7 ignored；ignored native UDP/TCP/cancel 已在上一轮单独显式验证成功。当前 OS 再核验两旧崩溃 SID（尾号 1063、1065）：HKEY_USERS 均存在、Win32_UserProfile.Loaded=true，精确 SAM 账户均 Disabled=true，继续保留隔离，未派发新的恢复服务或强制卸载。完整 A/B 清单仍有未实现与未验证范围，不能用完整原型测试通过声称 A/B 完成。
native DNS positive 的 records 核验已绑定完整自有 question：要求单一 A record、wDataLength 精确为 4、固定地址和固定 UUID 域名全部匹配。DnsQueryEx Unicode record 按 DNS_RECORDW 同 ABI 读取，名字逐字符有界比较、ASCII DNS 大小写等价；空/null、短名、其他 UUID、额外后缀均拒绝，不做无界 strlen/copy。新增就近测试覆盖上述负例；相关默认 9 项、显式普通 native UDP/TCP positive 与真实 timeout/cancel 三项、Clippy all-targets 通过。LPAC 原 87、credential 1702、旧恢复债务和完整 A/B 范围仍未完成；这些正向对照不能替代隔离验收。
loopback InterfaceIndex=1 对照已实际执行：本机 Get-NetIPInterface 确认为 1；仅替换 request.InterfaceIndex 后，普通 native UDP/TCP 均立即 dispatch=87，result.QueryStatus 留在初始 0，没有自有 receiver 查询，UDP 等待 10060、TCP accept 等待 10035。该参数尝试已撤回，继续保留 InterfaceIndex=0；不作为 LPAC 拒绝证据。实验暴露立即失败回执缺陷：当 dispatch 非 pending/nonzero 时，QueryStatus 可能未写入，现使用实际 dispatch failure 作为 completion status，防止把未写入的零记录为成功；新增精确 failure 回归覆盖 87/5/10013/1702，并保留成功路径结果。DNS 相关 8 项默认测试、重新显式执行普通 native UDP/TCP positive 两项、Clippy all-targets 均通过。无需新增账户或系统权限，本次自有 socket 均已随终态关闭。LPAC DNS 的原 87 和 credential 1702 仍未解决，A/B 未完成。
DNS 实际失败回执回归已加强：直接解析 DnsApiObservation，精确要求 dispatch/completion=87、records/fixed answer=false、无 timeout/cancel，验证即使 receiver 对照可信且计数为零也不能成为 verified_denial；两 receiver 的完整对照/零计数说明逐项核对。相关回归及 Clippy all-targets 通过。[微软 DnsQueryEx 文档](https://learn.microsoft.com/en-us/windows/win32/api/windns/nf-windns-dnsqueryex) 将 ERROR_INVALID_PARAMETER 关联到请求/结果初始化或版本，并仅标记 desktop apps；[请求结构文档](https://learn.microsoft.com/en-us/windows/win32/api/windns/ns-windns-dns_query_request) 说明 InterfaceIndex=0 考虑全部接口。文档没有证明当前 LPAC 的 87 是访问拒绝，也未解释自有 server list 在 LPAC 中的实际支持情况。下一项诊断应保持固定自有目标，分别验证接口/调用形态，不能开放能力或系统 DNS 出站来让测试变绿。
DNS 已接入共享源及专用账户 normal root/真实 leaf，当前基础门禁为 148 项，专用账户加 3 项凭据共 151 项。普通 native UDP/TCP 前后 positive 均成功，自有两接收端净计数为零；但两种 LPAC 来源各四项 DNS API 均 dispatch/completion=87、无 records，不是明确访问拒绝，门禁保持失败。共享源 144/148 通过并完成 profile/ACL 清理；专用账户 146/151 通过，另有 credential 1702。见 [共享源 DNS](evidence/windows-stage-a-2026-10-09-dns-lpac-shared-source.json)、[专用账户 DNS](evidence/windows-stage-a-2026-10-09-dns-network-system-profile.json)。专用 UUID 21594eee-b9c3-4b6d-b94b-e0ad1c23d7ae 首次独立恢复仍有 profile retirement 债务；确认前序服务终态、exact account 禁用且 hive 不存在后，固定二次恢复已清空本轮账户/profile/WFP/credential 债务，[回收回执](evidence/windows-stage-a-2026-10-09-dns-network-second-recovery-profile.json)与[实际 OS 缺席审计](evidence/windows-stage-a-2026-10-09-dns-network-second-recovery-os-audit.json)均确认。新增真实失败回执回归，历史 142 项成功不能替代 DNS 新范围；默认测试 154 passed、7 ignored，Clippy all-targets 与 fmt 通过。阶段 A/B 仍未完成，旧两项 crash hive 债务仍待恢复；未提交或推送，生产 unavailable。

controller-owned `DnsReceiver` 已实现并显式实机测试通过：须先成功 bind 自有 loopback UDP/TCP:53，已有 listener 忙碌则失败，不停止系统服务或改 DNS 配置；只回答本 UUID 固定 question。开始前和结束后由原生 DnsQueryEx UDP/TCP 各做一次真实 positive，最终仅扣除结束时固定对照，保留执行窗口全部查询计数；有界 drain、worker 错误/未知 question 保留失败，重复 finish 复用终态。实测窗口内各一次查询最终 `[1,1]`，空窗口 `[0,0]`，错 UUID UDP 输入触发失败且重复收尾仍失败；fmt/Clippy 通过。此为接收端基础，尚未接入专用账户 root/leaf DNS；不能据此认定 DNS 网络/系统代办隔离通过。

原生 DNS TCP positive 与 timeout/cancel 两项 ignored 实机测试已显式运行并通过。TCP 首次受 accepted socket 继承 nonblocking 影响，receiver=10035、API=10054；仅将自有 accepted socket 切回 blocking 并保留 1 秒读写预算后，固定 TCP question/answer 与 native records 校验成功。UDP 不响应对照实际 pending，2 秒触发取消、cancel status=0，非成功完成回调到达、无 records，live query 存储计数最终为零。DNS API gate 仅接受明确 5/10013、完成且无对象，并要求已验证接收对照和零计数；87/1702/超时/取消/未知或任何接收流量全部拒绝。六项默认 DNS 测试、fmt、Clippy 通过。普通上下文 UDP/TCP/cancel 基础具备，尚未接入 LPAC DNS/system relay，不能替代 A5 完整网络验收或阶段 B。

DNS API Win32 87 已定位并修正：独立 C# 同步 ABI 对照（request/result 64/32 bytes）在显式 sockaddr port=53 时返回 87、零接收；只将 sockaddr port 设为 0 后返回 0、records 存在，自有 127.0.0.1:53 receiver 收到并回答一个固定 UUID question。Rust 异步调用同样改为 native port=0，入口仅接受固定 loopback:53，随机端口拒绝；显式运行的真实 native UDP positive 回归现通过，严格 owned question 与固定 A 答案匹配。见 [独立正向对照](evidence/windows-stage-a-2026-10-09-dns-native-independent-control.json) 和固定脚本 Test-FixedDnsNative.ps1。缩减 query options 并未解决 87，已恢复原 cache/hosts/local/NetBT/multicast 绕过选项；没有修改系统 DNS、服务或权限。五项默认 DNS 测试与 Clippy 通过。此为普通上下文 positive，TCP native、取消实测及 LPAC/DNS 系统代办仍未验收，A/B 未完成。

原生异步 DNS 初版已新增 `dns_native_probe`（尚未接入 LPAC）：仅固定 owned UUID 域名和 IPv4 127.0.0.1 非零端点；request/name/server/result/cancel/context 存储由 caller 与 native callback 两个 Arc 引用持有，inline completion 走同一释放路径；等待 2 秒、请求取消后再等 1 秒，无完成则保留 callback 所有权并返回未知/失败，最多四个 live query，不能当作拒绝。SDK records 用 DnsFreeRecordList 释放，结果只记录 status/对象存在/固定地址是否匹配。普通上下文实际 UDP 正向对照目前失败：最初随机端口 dispatch=9506、callback=87、无 records、接收端超时；按 [DNS ADD USER](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dnsp/6e041c76-3b55-480a-84fb-feebcb0cc9db) 补 SockaddrLength=16/Family=AF_INET 后仍相同；改为自有成功绑定的 127.0.0.1:53 对照仍相同。没有修改系统 DNS/服务/ACL，接收 socket 均已结束。五项非 ignored DNS 测试与 Clippy 通过，显式原生 positive ignored 测试仍失败，保留该失败状态；不得据此声称 DNS 拒绝或 A complete。需要继续诊断原生请求/系统 resolver admission，建立普通正向后再接入 LPAC。

DNS wire 基础补齐 TCP 两字节长度分帧，声明长度在读取/分配正文之前限制到 12..512，截断拒绝，正文仍只支持固定 owned question/answer。真实本机 TCP 分片 query/response、TCP 长度边界、原 UDP 与报文负例四项测试，以及 fmt/Clippy 通过。原生异步调用尚未实施；官方 [DnsCancelQuery](https://learn.microsoft.com/en-us/windows/win32/api/windns/nf-windns-dnscancelquery) 明确取消不会等待完成，应按 [完成回调](https://learn.microsoft.com/en-us/windows/win32/api/windns/nc-windns-dns_query_completion_routine) 管理存储寿命，不能在取消返回时释放 request/result/cancel/context。后续必须处理 inline completion、pending、取消与未确认完成的保留语义；当前不能认定 DNS 隔离或系统服务代办通过。

DNS owned wire 基础已新增：仅接受非零 UUID 的固定 `sspa-{UUID}.invalid` A/IN question，固定响应 TTL 0 与测试地址 127.0.0.42；不转发、不查业务域名。严格比较完整报文，拒绝未知名字/类型/flags、截断、额外字节和超过 512-byte 输入；正向答案校验绑定 UUID 与 transaction ID。真实自有 UDP round-trip 与报文负例两项测试、fmt、Clippy 通过。尚未调用 DnsQueryEx，也未接入 LPAC，不能标 DNS 边界通过。后续使用官方 [DnsQueryEx](https://learn.microsoft.com/en-us/windows/win32/api/windns/nf-windns-dnsqueryex)、[请求结构](https://learn.microsoft.com/en-us/windows/win32/api/windns/ns-windns-dns_query_request) 和 [查询选项](https://learn.microsoft.com/en-us/windows/win32/dns/dns-constants) 检查指定服务器、缓存绕过、异步生命周期与取消；必须以实际接收端和普通上下文正向对照证明执行到网络路径。

external-loopback 与自有 private receiver 共存路径实测完成：共享源 `--run-lpac-controller-network` 的 142 项检查全部通过，四项 private receiver 与四项 external controller loopback receiver 各唯一且净计数为零，profile removed/fixture ACL revoked/quietness true、error=null。见 [外部回环模式证据](evidence/windows-stage-a-2026-10-09-private-network-external-loopback.json)。新增真实回执回归覆盖 private 计数在 external 分支返回前收集，以及两组 receiver 不遗漏、不重复；测试、fmt、Clippy 通过。中断路径没有启动 private receiver，仍按原精确 17 项验收，完整生命周期及 DNS/系统服务代办范围尚未完成。

共享宿主无工具 normal 候选现已冻结并持有同一 private receiver，私网环境先于子进程创建生成；private monitor 的终态收集放在 external-loopback 分支返回之前，避免外部回环接收模式遗漏自有私网计数。共享源真实 `--run-lpac-registry-file-network` 完成 142 项基础全部通过，profile removed、fixture ACL revoked、receiver quietness 均为 true，error=null。见 [共享来源私网实测](evidence/windows-stage-a-2026-10-09-private-network-shared-source.json)。真实回执同时接受基础门禁并拒绝 credential-required 门禁，相关回归、fmt 和 Clippy 通过。该成功不替代専用账户 credential 1702、两个旧 crash hive 或完整 A/B 验收。

私网范围已接入并实测，UUID `e6e6db33-844b-44b1-9bd9-6391d7c0b688`：SYSTEM controller 在 normal、无工具的固定 workload 启动前冻结 IPv4 RFC1918/同接口 IPv6 link-local receiver；root 和真实 leaf 执行各四项 TCP/UDP 私网尝试，TCP 为 10013，UDP bind/send 为 10013；四项 private receiver 前后正向对照通过且净计数为零。基础精确集合为 142 项，加 3 项可选凭据共 145；仅 credential 1702 失败，基础门禁真实回执回归通过。第一次独立恢复出现 profile retirement absence unconfirmed，账户禁用与 WFP/credential 保留；确认服务终态及当前 hive 不加载后，固定精确二次恢复清空全部本轮债务，OS 账户/profile/hive/服务缺席。见 [实测](evidence/windows-stage-a-2026-10-09-private-network-system-profile.json)、[第一次恢复失败](evidence/windows-stage-a-2026-10-09-private-network-system-recovered-profile.json)、[二次恢复](evidence/windows-stage-a-2026-10-09-private-network-second-recovery-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-private-network-second-recovery-os-audit.json)。默认测试、真实回执新增回归和 Clippy 通过。此为本机私网/link-local接收端，不包含远端私网接收、DNS、系统服务代办或完整入站；两个旧 crash hive 和完整 A/B 仍未完成。共享宿主普通候选路径尚未接入 private receiver，不能用旧回执替代新基础门禁。

私网端点冻结基础已接入 Fixture：controller-only `start_fixed_private_receivers` 持有本机实际 bind 的四个 socket，environment 仅在该拥有状态存在时产生固定 `SSPA_PRIVATE_TCP/UDP0/1`；不读取运行时项目配置或模型地址，不覆盖既有回环端点。接口来自诊断映像嵌入的固定本机快照，选择 RFC1918 IPv4 的接口号再匹配同接口 IPv6 scope，去掉此前测试硬编码接口 11；失配/不存在/地址预算超限或任一 bind 失败均拒绝。实机接收对照回归和 Clippy 通过。SYSTEM controller 尚未调用这一入口，root/leaf 私网 socket 与 private receiver 终态验收仍待接入，不宣称 A5 私网阻断通过。

私网 controller 接收端基础新增 `bind_private_local`：先校验 RFC1918 IPv4 与 ULA/带非零接口 scope 的 IPv6 link-local，再要求四个 socket 实际本机 bind 全部成功，之后才能发送正向对照。现有 sandbox Endpoints.validate/启动计划仍仅允许回环，未扩成任意远端。UDP 对照绑定同一本机地址及 IPv6 scope。使用固定本机网络快照的 ignored 实机回归已显式运行，通过 IPv4 private/IPv6 link-local 四协议的前后对照和真实流量计数；这里只证明测试接收基础可用，尚未接入专用账户 LPAC，不是私网阻断通过。地址/接口验证及原接收端回归、Clippy 均通过。

新增 A5 TCP 监听准备负例：专用账户 LPAC root 和实际 leaf 分别在 IPv4/IPv6 回环地址端口 0 执行 TcpListener::bind，四项均为 Win32 10013；controller 相同地址族已有真实 bind/接收正向对照。第一轮 UUID `90d35657-7e5e-4fe8-a2db-b3bb3d8b2f5a` 因 workload 报告超过旧 16 KiB 门禁被拒绝，证据保留且独立恢复完成。报告固定上限扩大到 20 KiB（leaf/普通凭据仍 4 KiB），保持原句柄、非 reparse、单链接和超限拒绝；基础精确集合现在为 130 项，加可选凭据 3 项。新实测 UUID `781b3fa7-5bf0-47ff-bb33-e1d0aa9e5ae6` 共 133 项仅 credential 1702 失败，四项监听拒绝通过；执行树/ACL 退役和独立恢复完成，OS 账户/profile/hive/服务缺席。见 [新实测](evidence/windows-stage-a-2026-10-09-tcp-listener-bounded-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-tcp-listener-bounded-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-tcp-listener-bounded-system-os-audit.json)。完整默认测试及新真实回执门禁回归通过；历史 ADS 回执因缺少监听项拒绝。此范围仅证明监听绑定准备拒绝，不能替代完整入站收包、DNS、私网或系统代办；A/B 仍未完成。

凭据 primary 探针新增有效线程身份门禁：在查询进程 Token 之前要求 OpenThreadToken 精确返回 ERROR_NO_TOKEN；已有线程模拟或其他查询错误均拒绝调用 CredRead，防止以 primary 身份核验但实际通过线程身份访问凭据。真实 ImpersonateSelf 回归同时覆盖 LPAC/ordinary primary 入口拒绝，专门 self-context 诊断仍按线程 Token 核验。七项 credential_reference 测试与 Clippy 通过。该修复不说明 1702 根因已解决；两个旧 crash profile 当前 Win32_UserProfile.Loaded 仍为 true，恢复门禁仍阻挡。

网络证据新增结束时四协议正向对照：同一 controller 接收线程在执行树停止后必须再次接收到固定 TCP/UDP 控制流量，再进入有界 drain；最终仅扣除每项一次控制，不丢弃执行期间计数。停止的 worker 即便计数为零也拒绝验收，失败终态保留。五项 receiver_control 回归和 Clippy 通过。专用账户实测 UUID `c40234cd-8102-42f8-86c2-162ac45ca20b` 的四项最终净计数为零，129 项仅 credential 1702 失败，执行树/ACL 退役成功；独立恢复债务为空，实际账户/profile/hive/服务缺席。见 [profile](evidence/windows-stage-a-2026-10-09-receiver-final-controls-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-receiver-final-controls-system-recovered-profile.json)、[OS 审计](evidence/windows-stage-a-2026-10-09-receiver-final-controls-system-os-audit.json)。历史回执 detail 尚只写启动正向对照，不能据文案推断其实现；本轮执行已包含结束对照。完整 A5 与 A/B 未完成。

接收端收尾修复后的专用账户 SYSTEM 实测已完成，UUID `230d23af-c1e7-4a92-8f03-294a46d81917`。四项真实 TCP/UDP receiver 计数均为零，执行树停止且 workload ACL 退役；完整 workload 仍因唯一 credential Win32 1702 失败，不能解释为凭据拒绝。独立固定恢复后 credential/profile/account/WFP 全部 removed、cleanup_debt 为空，实际 OS 审计确认账户/profile/hive/两服务缺席。证据为 [profile](evidence/windows-stage-a-2026-10-09-receiver-drain-system-profile.json)、[恢复](evidence/windows-stage-a-2026-10-09-receiver-drain-system-recovered-profile.json) 和 [OS 审计](evidence/windows-stage-a-2026-10-09-receiver-drain-system-os-audit.json)。该回环范围不补足 A5 完整网络矩阵；A/B 仍未完成。

网络接收证据收尾已修正：controller 确认执行树停止后，克隆 TCP/UDP socket worker 继续读取已排队流量，直到 WouldBlock；收尾最长 1 秒，超时或 worker 错误拒绝验收。首次终态（包括失败）保留，重复 finish 不重新解释计数或丢弃失败。真实回环发送后立即 finish 的四协议回归、重复收尾失败保留回归及全部四项 receiver_control 测试、fmt 和 Clippy 已通过。此前 dedicated 回执尚未在该实现下重跑，该修复不补足 DNS、私网、入站等 A5 矩阵，也不标 A/B 完成。

固定 concurrent-cancel 真实专用账户实测通过（UUID 1c6f1cfe-d445-474e-922a-ab9e2c51d2e4）：Barrier 同步两个受限 root worker 的固定 leaf 创建，各自 suspended 身份核验后 resume、独立 ready marker；控制器双 marker 确认后发送单次取消，实际六成员 total/active=6，每成员 user/package/capability/Low/LPAC/Job/映像核验与固定 3 probe+3 conhost 拓扑通过，进程树停止、workload 权限/profile 退役成功，diagnostic error=null，见 [回执](evidence/windows-stage-a-2026-10-09-concurrent-cancel-system-profile.json)。中断报告仍按精确 prefix 门禁通过，不算正常 126 项矩阵成功。本轮 namespace 债务经固定独立恢复清空，[OS 缺席审计](evidence/windows-stage-a-2026-10-09-concurrent-cancel-system-os-audit.json) 账户/profile/hive/服务全部不存在；未产生新增债务。新增六成员/双 ready 取消触发与实际回执回归。该 bounded 两 leaf 场景不能替代所有并发创建竞态、宿主断连/重启、broker replay/cancel 及完整 A/B 验收。

并发生命周期验收组件新增固定六成员拓扑门禁：一个 root 与两个 leaf（同一冻结 probe 映像）及三个冻结 conhost，必须每成员唯一 PID、实际 Job/用户/package/capability/Low/LPAC 与映像核验成功，total/observations 精确一致；四成员正常门禁保持原范围，六成员不能冒充原正常场景。新增缺失、总数错误、重复 PID、未知映像及任意成员 capability/用户失败回归，Job 相关三项测试及 Clippy 通过。本轮只实现该验收组件，尚未派发新的并发创建/cancel 实机工作负载，A6 仍未完成；下一步固定两 leaf 同步创建、双 ready marker 及取消/停止/恢复验证。完整 A/B 未完成，尚不提交推送。

NTFS case-sensitive 目录实测新增：仅在空 owned UUID 目录设置 FileCaseSensitiveInfo，native 回读确认 flag，create_new 创建 secret.txt/SECRET.TXT 两个不同原生对象并验证枚举两项，冻结扫描因 Windows ordinal 大小写等价路径拒绝整个清单。显式 `actual_case_sensitive_inventory... --ignored` 已实机通过，随后回收 owned 目录；不修改全局大小写策略。该测试默认 ignored 是因为依赖 NTFS 目录级功能，不能计入普通默认运行的通过数。规则新增 65,536 UTF-16 code units 总输入预算，进入原生比较前拒绝超额，避免仅限条数造成超大比较输入。完整路径别名与阶段 A/B 仍未完成。背景依据 [Microsoft NTFS 大小写说明](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity)。

冻结规则与清单唯一性改用原生 CompareStringOrdinal(ignoreCase=true)，替代仅 ASCII 折叠；规则去重、目标存在性、后代组件前缀匹配、清单歧义拒绝全部使用同源比较，API 失败/字符串超预算立即拒绝准备，不退回普通对象。新增 Ä/ä、Σ/σ 原生大小写、规则后代边界/重复、真实 Unicode owned 文件扫描与同规则复核回归。136 项默认原型测试与 Clippy 通过；跨卷测试需要两卷而默认 ignored（上一轮已显式通过）。重新 [LPAC 实测](evidence/windows-stage-a-2026-10-09-unicode-rule-controller-network.json) 126 项通过、树停止/ACL 撤销/profile_removed=true、error=null。本次采用 Win32 ordinal 语义，并未证明所有 NTFS case-sensitive 目录或每类名称别名；完整 A/B 仍未完成，不提交推送。

新增真实跨卷 junction 准备回归：TEMP 自有源与工作区自有目标分别通过本地 NTFS 门禁，并断言原生 volume IDs 不同；目标 project/marker 内容通过 junction 的普通 source 正向可达，但同路径冻结在祖先 reparse 门禁拒绝，目标 project DACL 不变。清理重新核验自有 junction 的 volume/file ID 后仅移除其 reparse 数据，再通过回收站回收两处普通 owned 目录。测试 `actual_cross_volume_junction_project_is_refused_without_target_acl_changes` 显式 `--ignored` 已实机通过，Clippy 通过；默认忽略仅因为需要 TEMP 与工作区位于不同本地 NTFS 卷，不能把同卷测试算跨卷通过。此证据覆盖普通 source 的跨卷准备拒绝，未代替专用账户跨卷执行、所有 reparse tag 与完整 A/B 验收。

专用账户 UUID b699ed5d-49a2-416e-9981-88e68b9ba1e3 新 ADS 实测完成：当前 126 项基础矩阵全部通过（包括新流 create/write/reopen/read/delete 和只读/敏感 create 拒绝），三项可选凭据/RPC 中仅 CredRead 1702 失败，整体 129 项仍不验收，见 [账户回执](evidence/windows-stage-a-2026-10-09-new-ads-system-profile.json)。源对照新增精确 workspace-project/ordinary.txt 新流创建/内容/删除，原型脚本仅增加固定枚举 NewAds 场景，仍无任意命令/路径/身份参数且已有证据拒绝覆盖。独立恢复 [回执](evidence/windows-stage-a-2026-10-09-new-ads-system-recovered-profile.json) 无债务、账户/profile/credential/WFP 均移除，[OS 缺席审计](evidence/windows-stage-a-2026-10-09-new-ads-system-os-audit.json) 全部通过。当前完整基础门禁回放通过，凭据失败语义保留；完整 A/B 未完成，尚不提交推送。

新 ADS 创建矩阵新增五项：只读/敏感文件新流 create_new 返回 Win32 5；完整显式工作区普通文件新流 create/write、close/reopen/read 内容核验、delete 成功。初次使用旧混合夹具的仅 FRFW workspace.txt，delete 返回 5，保留 [失败回执](evidence/windows-stage-a-2026-10-09-new-ads-controller-network.json)，未扩大该对象 ACL；绑定完整 workspace-project/ordinary.txt 后 [126 项实测](evidence/windows-stage-a-2026-10-09-new-ads-workspace-controller-network.json) 全部通过，报告完整，树停止/ACL 撤销/profile_removed=true、error=null。普通 source 已预先核验新流创建/重开/删除 API 正向。门禁更新至 126 项，历史专用账户 121 项不能满足新增 ADS 门禁；新增证据回归。专用账户新 ADS、完整 A/B 仍未完成。

CredRead/LPAC 一手资料复核：Microsoft [1700–3999 错误码](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1700-3999-) 将 1702 明确为 RPC_S_INVALID_BINDING；[CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) 说明按当前 Token 登录会话凭据集读取，常见失败包括无目标/无登录会话，文档未给出本次 LPAC 1702 根因。Chromium [系统 capability 定义](https://raw.githubusercontent.com/chromium/chromium/main/sandbox/policy/win/lpac_capability.h) 包含 lpacIdentityServices/lpacCryptoServices，但仅名称不足以证明应加入，本轮保持候选能力集合不变。排查中补齐固定 self-context capability 签名的 native header/数组字节范围、计数预算与重复 SID 门禁，创建 slice 前验证，新增边界回归；RPC 相关真实普通上下文测试与 Clippy 通过。凭据验收、完整 A/B 仍未完成。

加固 CredRead 捕获后重新运行专用账户 UUID 9ed209d1-41a1-4b09-8c0c-3b364406bfe2：124 项中基础 121 项及两个固定 RPC 客户端配置检查通过，唯独凭据负例仍 1702，见 [实测回执](evidence/windows-stage-a-2026-10-09-credential-reset-profile.json)。因此清空 LastError 并未改变观察值，不能以此认定凭据拒绝；根因仍未解决。固定一次性 [诊断脚本](../../tests/windows-sandbox-account/scripts/Run-FixedProjectMatrix.ps1) 不接受命令/路径/身份参数，记录准备后派发、服务退役确认后精确恢复，已有证据时在创建资源前拒绝重跑。独立恢复与 [实际 OS 缺席审计](evidence/windows-stage-a-2026-10-09-credential-reset-os-audit.json) 全部成功，无新增债务。新增证据回归保持 1702 失败语义；完整 A/B 仍未完成，不提交推送。

凭据负例错误捕获加固：在目标参数准备完成后 SetLastError(0)，CredRead 返回后立即保存 BOOL/LastError，再释放所有非空返回 credential（包括异常失败返回对象），不读取或记录 secret。纯结果门禁只接受显式失败、无对象且已知 1168/5/1312；成功无对象、失败返回对象、0/1702/87/2 均拒绝。新增普通账户实际调用回归：预设 1702 后仍得到 ERROR_NOT_FOUND 1168；新增结果边界回归，Clippy 通过。此对照不能证明 LPAC 1702 的根因，也未重新运行 LPAC/SYSTEM 账户实验，凭据验收继续未通过。完整 A/B 未完成，完成后提交推送的前提尚未达成。

新专用账户 UUID 96d07e51-0b02-4dc6-9ceb-7bbccc8ced57 下完整 121 项基础矩阵全部通过，actual user/package/capabilities/Low/LPAC/精确 Job 与四成员拓扑、exit 73、执行树停止、workload ACL/profile 退役成功；见 [专用账户回执](evidence/windows-stage-a-2026-10-09-project-matrix-system-profile.json)。三项可选凭据检查中 owned SYSTEM credential 仍 Win32 1702，故 124 项整体门禁仍失败，未降级接受。正常退役 namespace 有债务，精确独立恢复 ef8ed292-661b-467e-aa27-883b805b19e6 已清空账户/profile/credential/WFP/namespace 债务且恢复服务退出 0/0、已移除，见 [恢复回执](evidence/windows-stage-a-2026-10-09-project-matrix-recovered-profile.json) 与 [当前 OS 缺席审计](evidence/windows-stage-a-2026-10-09-project-matrix-post-recovery-audit.json)。新增回归保持基础成功与凭据失败不同结论。用户已更新目标为完整 A/B 达成后 commit/push，当前未达到该前提，仍不提交或推送。

冻结项目根新增逐级祖先门禁：从 drive root 向项目父目录依序 native no-follow 打开，非目录/reparse/不可查立即拒绝；64 层预算与扫描共用两秒期限。只共享读的祖先 DATA 租约保留至快照/Fixture 退役，拒绝祖先目录写入句柄及 rename 替换。真实 owned junction 回归确认直接目标项目可冻结、经 junction 祖先项目拒绝，owned/target DACL 不变；128 项原型测试与 Clippy 通过。重新 [LPAC 实测](evidence/windows-stage-a-2026-10-09-ancestor-leases-controller-network.json) 121 项全部通过，普通 workspace 操作仍成功，树停止/ACL 撤销/profile_removed=true、error=null。尚未覆盖所有 reparse tag、跨卷与完整 broker caller 绑定；阶段 A/B 未完成。

HOME 排除新增原生目录身份检查：打开可信当前 USERPROFILE 目录并以 `(volume, file_index)` 比较已持有项目根身份，相同对象直接拒绝；HOME 绑定缺失、目录不存在或身份不可查均拒绝准备。避免只靠字符串排除同一目录的不同路径表示。真实 owned 目录回归覆盖同对象拒绝、不同目录允许及未知绑定拒绝；128 项原型测试与 Clippy 通过，重新 [LPAC 实测](evidence/windows-stage-a-2026-10-09-home-object-controller-network.json) 121 项通过、树停止/ACL 撤销/profile_removed=true、error=null。仍只绑定诊断执行上下文 HOME，未来 broker 必须使用已认证 caller 的 HOME 身份；祖先 reparse 链及全部别名实测仍未完成，阶段 A/B 未完成。

项目准备新增根路径与原生卷门禁：先拒绝 UNC/device/network 路径、相对路径、驱动器根和整个当前 USERPROFILE；磁盘类型必须可验证为本地，持有根对象句柄调用 GetVolumeInformationByHandleW 确认为 NTFS 才继续。路径输入回归覆盖网络、drive root、HOME、parent traversal；现有真实扫描测试通过。127 项原型测试与 Clippy 通过，重新 [LPAC 实测](evidence/windows-stage-a-2026-10-09-local-ntfs-root-controller-network.json) 121 项通过且资源清理成功。尚未实测非 NTFS/映射网络盘负例，当前 HOME 校验只绑定当前执行环境路径，完整 caller HOME 的原生对象身份、祖先 reparse 链和所有路径别名仍需补齐；阶段 A/B 未完成。完成核对表 A8 已同步当前 121 项门禁，保留专用账户新矩阵待实测的区别。

默认项目普通对象新增六项 LPAC 原生检查：ordinary.txt 读取成功，write/rename/delete 均 Win32 5，空普通目录 rename/delete 均 Win32 5。普通对象租约已释放，因此不以保护租约的共享锁替代 ACL 拒绝。完整矩阵 121 项全部成功、报告完整，exit 73/树停止/ACL 撤销/profile_removed=true、error=null，见 [实测回执](evidence/windows-stage-a-2026-10-09-readonly-ordinary-controller-network.json)。验收门禁同步要求六项并新增唯一检查及错误码回归。固定 owned 夹具不能替代真实项目、多卷、全路径别名、跨槽及完整恢复/阶段 B 实现；完整阶段 A/B 仍未完成。

项目冻结清单新增唯一性门禁：拒绝 ASCII 大小写等价的不同路径，拒绝重复 `(volume, file_index)` 原生对象身份，避免一个冻结规则匹配多个对象或对象别名进入授权清单。回归覆盖重复大小写路径、重复身份、名称前缀不是后代的边界。125 项原型测试及 Clippy 通过，重新 [LPAC 实测](evidence/windows-stage-a-2026-10-09-unique-project-inventory-controller-network.json) 115 项全部通过，树停止/ACL 撤销/profile_removed=true、error=null。尚未实测 NTFS case-sensitive 目录及全部 Unicode 大小写等价关系，不能以此声明完整路径别名矩阵完成；完整阶段 A/B 仍未完成。

LPAC 夹具现在持有各项目及外层冻结快照的保护租约直到 Fixture 退役，释放普通对象租约以保留 workspace rename/delete；拒绝重复 populate。新增并发宿主线程回归：敏感文件/祖先不能移动，普通文件仍能移动删除，释放快照后敏感祖先可移动。初次实测 source DELETE 对照遭 Win32 32 共享锁拒绝，保留 [失败回执](evidence/windows-stage-a-2026-10-09-held-project-snapshots-controller-network.json)；已把 DELETE 正向对照移至冻结前，并保留运行期读写 source 对照。修正后 [实测回执](evidence/windows-stage-a-2026-10-09-held-project-snapshots-bound-controller-network.json) 115 项全部通过，LPAC 拒绝仍为权限拒绝而非共享锁替代，树停止/ACL 撤销/profile_removed=true、error=null。124 项原型测试与 Clippy 通过；完整并发、跨账户与恢复矩阵仍未完成。

独立敏感规则优先级新增七项 LPAC 实测：显式工作区的根 `.env.local` 与 rules/config.json 同时被明确选为敏感，均读写 Win32 5 拒绝，覆盖根 env 只读例外及只读规则重叠；同项目普通文件读写正向成功，项目根 DELETE 访问拒绝。完整矩阵 115 项全部成功、报告完整，exit 73/树停止/ACL 撤销/profile_removed=true、error=null，见 [实测回执](evidence/windows-stage-a-2026-10-09-independent-sensitive-controller-network.json)。当前门禁同步新增七项，新增证据回归。仍未覆盖真实用户项目完整路径别名、并发、跨账户与跨卷矩阵，完整阶段 A/B 未完成。

新增运行中新对象权限实测：显式工作区文件 create_new/write、close 后 reopen/read 内容一致、rename/delete，目录 create、其内部文件 create/write/delete、目录 rename/delete 九项成功；默认只读项目文件 create_new 与目录 create 两项 Win32 5 拒绝。完整固定矩阵 108 项全部通过，报告在既有限额下完整交付，exit 73/树停止/ACL 撤销/profile_removed 均成功、error=null，见 [实测回执](evidence/windows-stage-a-2026-10-09-new-workspace-objects-controller-network.json)。当前门禁新增十一项，证据回归要求唯一检查与准确错误码。本次验证当前 LPAC Token 默认 DACL 下新对象行为，未证明跨账户继承与并发安全，也未扩展成完整 A/B 完成声明。

显式工作区原生权限夹具与默认项目共用冻结分类授权，新增 13 项 LPAC 操作：普通文件 write/rename/delete、普通目录 rename/delete 成功；根 `.env.local` 仍只读，嵌套同名文件读写拒绝，规则文件只读、规则目录与敏感祖先 DELETE 拒绝。完整固定矩阵 97 项全部通过，报告完整交付在原有 16 KiB 限额内，exit 73、树停止、ACL 撤销、profile_removed=true、error=null，见 [实测回执](evidence/windows-stage-a-2026-10-09-workspace-project-controller-network.json)。当前专用账户门禁同步要求新增检查；旧历史回执不补造新证据。并发、跨卷、创建新对象继承、显式敏感规则覆盖等完整矩阵尚未完成，仍不宣布阶段 A/B 完成。

新增默认只读项目原生权限夹具，依据独立项目根冻结分类逐对象生成非继承 package ACE：根 `.env.local` 可读不可写，嵌套同名文件读写拒绝，规则文件可读不可写，规则目录及敏感文件祖先 DELETE 访问拒绝。八项新增 LPAC 检查全部成功，拒绝明确为 Win32 5；完整矩阵 84 项全部通过，树停止/ACL 撤销/profile_removed 均 true，error=null，见 [实测回执](evidence/windows-stage-a-2026-10-09-default-project-controller-network.json)。每个文件已有普通 source 读写正向对照，快照授权前冻结、授权后同规则复核。新增证据回归；完整默认/显式工作区、多卷与并发矩阵仍未完成，阶段 A/B 仍未完成。

新增 LPAC 父目录边界实测与强制门禁：普通子目录创建/rename/delete 三项正向成功，受保护 output 父目录 DELETE 访问与 rename 两项返回 Win32 5；普通 source 预先确认父目录 DELETE 访问成功。完整固定矩阵增至 76 项，全部通过，exit 73、树停止、ACL 撤销与 profile_removed=true、error=null，见 [实测回执](evidence/windows-stage-a-2026-10-09-parent-directory-controller-network.json)。当前专用账户门禁要求新增五项；旧 71 项历史回执不能满足新门禁，历史事实保留。新增回执回归验证唯一检查项及明确拒绝码。仍未完成全部 A/B。

冻结策略移至原型共享库并接入 LPAC 固定夹具：独立敏感目标在 package ACE 授权前扫描，授权后按相同规则与稳定对象身份复核。输出目录因包含受保护子文件而保持 pinned；删除权限改为仅向普通后代继承，不再授予输出父目录自身 DELETE。新 [LPAC 实测回执](evidence/windows-stage-a-2026-10-09-frozen-policy-controller-network.json) 的既有 71 项矩阵全部通过，actual LPAC/Low/精确 capabilities/Job 验证、exit 73、进程树停止、ACL 撤销均成功，error=null。118 项原型测试与 Clippy 通过。此实测尚未新增父目录 rename/delete 独立负向项，也未覆盖完整用户项目默认/显式权限矩阵；不视为阶段 A/B 完成。

规则目录分类新增 `RulesDirectory`，授予只读遍历而不授予写入、DELETE、DELETE_CHILD 或 ACL 修改；规则文件仍只读，敏感目录优先拒绝。旧固定诊断夹具的项目 ACE 现在从冻结分类读取，缺失目标直接拒绝，避免静态枚举绕过独立规则。真实目录快照回归覆盖规则目录及后代分类；118 项原型测试通过。尚无新增 LPAC 默认项目矩阵实测，不扩大兼容性或阶段完成结论。

项目冻结快照新增独立敏感对象与受保护规则输入：规则路径先校验、限制数量并拒绝重复目标，扫描后确认每个目标存在；目录目标覆盖其后代，敏感规则优先于根 `.env.local` 只读例外。复核使用快照保存的同一份规则。固定旧诊断夹具已接入规则输入；新增真实文件系统回归覆盖规则优先级、后代、目标缺失与复核。此处仅采用 ASCII 大小写折叠，尚未完成全部 Windows 名称等价关系与 LPAC 默认项目权限矩阵，不视为 A2/A3 或阶段 B 完成。

项目快照新增完整二次准备复核：持有原对象句柄期间按同一256节点/2秒预算重新枚举，分类集合与根/全部对象volume/fileID/bytes/type须完全一致；旧夹具ACL授予后、释放ordinary leases和启动前强制复核，失败进入原增量撤销路径。真实回归覆盖新.env加入、现有对象长度变化拒绝、新完整准备识别新增敏感文件；116项测试/Clippy通过。根须目录。该比较不是内容hash或最终时点并发事务锁，也未实现独立规则输入、最新bindingRevision和完整真实默认模式；A2/A3及完整A/B未完成。


项目快照句柄生命周期修正：扫描/授权准备阶段固定全部现有对象，执行前释放ordinary文件/目录句柄，只保留根、敏感/根env例外/规则对象与其祖先。分类自动将敏感对象的普通祖先标PinnedDirectory；避免全量快照句柄在执行期阻止workspace普通文件rename/delete。真实回归证明普通文件与output目录rename成功、敏感文件与祖先rename仍拒绝，115项测试/Clippy通过。旧账户夹具启动前调用同一保留策略；还未完整实机默认readOnly/workspace验收，也未完成前后枚举/独立规则/授权journal，完整A/B未完成。


owned项目扫描增加原句柄稳定身份：每个根/文件/目录记录volume/fileID/bytes/type，非目录linkCount必须1，跨根卷拒绝，身份清单须恰好覆盖根+全部分类对象后才继续夹具授权。真实回归证明重开同对象identity一致、敏感文件hardlink到普通路径会拒绝整轮准备，114项测试/Clippy通过。尚缺完整前后枚举复核、独立敏感规则输入、祖先pinned权限生成与生产journal原SD/delta；保持A2/A3未完成，不把身份扫描等同完整A/B。


默认策略新增有界owned项目扫描并在旧账户夹具授权前接入：256节点/2秒预算，read_dir/open/metadata错误拒绝完整准备，不返回截断结果；nofollow逐对象拒绝reparse/非文件目录，持有不共享DELETE的文件/目录句柄固定枚举名称，仍共享READ/WRITE以不阻塞workspace正常内容写入。新增真实目录rename被pin拒绝、大小写.env与嵌套敏感分类、超节点预算拒绝回归，113项测试/Clippy通过。当前仅扫描拥有夹具；不是完整可信项目快照，尚缺前后清单复核、稳定fileID/卷/链接数、独立敏感规则输入和所有祖先pinned权限生成，不计A2/A3完成。完整A/B未完成。


默认分类优先级修正：.env名称族拒绝现在先于规则目录只读，避免.git/.env或protectedRules=true时敏感对象被降为可读；独立敏感标记仍最高优先。Windows名称校验增加控制字符/通配符/保留字符以及CON/PRN/AUX/NUL、COM1–9/LPT1–9和上标¹²³设备名（含扩展名），UTF-16长度预算替代UTF-8字节长度。规则依据[Microsoft文件命名说明](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)。新增重叠规则/设备名/正常中文名称正负例，112项测试和Clippy通过；完整扫描/对象身份/实机默认模式仍未完成，完整A/B继续未完成。


A默认路径分类开始接入固定夹具：新增Windows相对路径分类，根普通文件.env.local（大小写不敏感）只读、嵌套.env.local和.env名称族敏感拒绝；独立敏感标记优先于根例外，.git/冻结规则归只读。拒绝绝对/UNC/驱动器/ADS、点段、空段、尾随点/空格等模糊路径。原固定夹具两类.env现在调用同一分类函数，新增大小写/嵌套/目录/独立敏感优先与路径负例，111项测试/Clippy通过。该函数不做完整节点扫描、reparse/fileID绑定或实际默认模式派发，A2/A3仍未验收，完整A/B未完成。


namespace恢复名称绑定补齐package SID格式门禁：必须规范S-1-15-2及恰好7个u32 hash子授权，不接受外部SID、capability SID、前导零、溢出、截断或路径注入；session仍要求规范u32且完整名称精确相等。新增外部/不规范SID负例，未改变任何namespace ACL或清理放行条件。令牌RAII检查未证明引用泄漏，服务存活期间namespace持续存在仍待定位；完整A/B未完成。


服务保护记录加载新增一致性门禁：created/removed须有先行install intent，observed exit须created且processExitConfirmed，serviceSpecific只用于1066且必须非零。矛盾0/2、1066/0、未确认进程、缺创建意图均拒绝；崩溃窗口planned=true/created=false/removed=true且exit未知仍允许精确恢复，不把缺字段认作成功。新增实际保护回执变异负例；不改变namespace权限、不解除未知债务，完整A/B未完成。


SCM结果记录已实机验证：固定Node诊断UUID75b49292-c8e1-4fd3-aa29-3cb694c3a455仍因namespace退役未确认失败，[外部保护状态](evidence/windows-stage-a-2026-10-09-scm-status-service.json)正确保存Win32=1066/serviceSpecific=2/processExitConfirmed=true并完成服务退役。独立恢复18c2598f-6daf-489f-8fc0-5f0cae4a6611[状态](evidence/windows-stage-a-2026-10-09-scm-status-recovery-service.json)为0/0且进程退出确认，[账户恢复](evidence/windows-stage-a-2026-10-09-scm-status-recovered-profile.json)账户/profile/WFP/凭据删除、cleanup_debt=[]。失败与恢复成功分别保留，不用service_removed覆盖诊断失败。新增实际失败/成功区别回归，完整A/B未完成，namespace生命周期待修复。


外部controller现在持久保存实际SCM STOPPED的Win32/service-specific退出码及稳定process句柄退出确认，在删除服务前写入保护Preparation，再独立核验配置/删除/不存在。旧回执observed_service_exit默认None，明确是未知状态，不能按service_removed推导诊断成功；失败码保持失败。新增历史缺失状态/失败码保真/未知字段拒绝回归，更新后尚未实机验证。完整A/B未完成，namespace生命周期仍未修复。


固定SYSTEM服务失败状态修正：此前run账户诊断失败会写入diagnostic_error，但外层closure只返回journal publish成功，SCM因此标成功退出。现先保留并同步失败回执，再传播原诊断错误，SCM STOPPED携带ERROR_SERVICE_SPECIFIC_ERROR/2；回执保存失败同样错误，不将保存成功等同诊断成功。外部仍独立确认停止/进程退出/删除，不依赖service退出码认定资源清理。新增成功、诊断失败、保存失败、双失败回归；尚未更新后实机验证，完整A/B未完成。


namespace有界观察实机得到反证：UUID565f39c8-e6b1-47f3-88c1-d29d76b619bd，[原回执](evidence/windows-stage-a-2026-10-09-namespace-wait-profile.json)固定PowerShell产物仍通过，但namespace在2001ms/41次查询持续存在、error=null，故保留债务。独立恢复4695c958-8de2-49b6-bdb7-6647c133774b在原服务结束后[恢复回执](evidence/windows-stage-a-2026-10-09-namespace-wait-recovered-profile.json)一次查询0ms确认缺失，账户/profile/WFP/凭据清空、cleanup_debt=[]。这排除了当前2秒内异步消失，尚不能证明具体持有句柄或内核引用来源；不要扩大等待时间替代生命周期修复。新增原存在与独立恢复缺失的回归，完整A/B未完成。


namespace退役查询新增受保护回执 observation：精确拥有名称的读取结果、attempts、elapsed_ms、固定2000ms预算和查询错误，在资源继续退休前durably保存；仅absent=true且error=null放行，未知/持续存在保留债务。执行root/baseline/observer句柄生命周期已检查，未发现可证明的泄漏，不能据此宣称namespace问题解决。历史回执新增字段serde default保持可读，不回填旧证据；104项测试/Clippy通过，下一次固定实机用于判明延迟与持续存在。完整A/B未完成。


namespace正常清理新增2秒有界实际缺失观察：原单次NtOpenDirectoryObject若对象仍存在则以50ms间隔重查，OBJECT_NAME_NOT_FOUND仍是唯一缺失证明；未知状态立即错误、不强制删除、不将超时当成功，超时保留精确账户/SIDblock债务。新增延迟消失/持续存在/查询错误立即退出回归。仅解决可能的异步对象退役窗口，尚无更新后专用账户实机证据，不能声称已修复反复namespace债务。完整A/B未完成。


修正冻结环境后的专用账户产物实机通过：UUID2248ee5d-36d6-49bb-ab2f-03cdb7132652，[原回执](evidence/windows-stage-a-2026-10-09-powershell7-artifact-bound-system-profile.json)固定脚本exit73、output/artifact verified、25字节产物原句柄独立校验，actual能力/LPAC/精确拓扑/停树/runtime撤销通过。namespace初始仍保留债务，独立恢复服务31be5ad2-54ed-4e20-bd52-3936d9c77b4f已结束并退役，[恢复回执](evidence/windows-stage-a-2026-10-09-powershell7-artifact-bound-recovered-profile.json)账户/profile/WFP/凭据/namespace removed=true、cleanup_debt=[]。本次仅固定.NET文件行为，不包含Modules/npm/实际build完整工具闭包，也不替代默认readOnly/workspace完整冻结规则；完整A/B未完成。


专用账户产物首轮实机失败已定位并恢复：UUID faae9c3e-5517-498f-a3e1-5180767d4e97，[失败回执](evidence/windows-stage-a-2026-10-09-powershell7-artifact-system-profile.json)实际exit1、artifact/output verified=false，stderr明确尝试System32/output：专用工具环境未包含冻结SSPA_FIXTURE。进程/runtime撤销已通过，namespace保留债务后由固定恢复服务c229c4ff-c21c-4d81-bb0b-2f5fab6e1637清空，[恢复回执](evidence/windows-stage-a-2026-10-09-powershell7-artifact-recovered-profile.json)账户/profile/WFP/凭据删除和cleanup_debt=[]。已修正工具环境只传入本轮冻结fixture root，不传普通workload凭据环境；修正后尚未重跑，不计专用产物通过。完整A/B未完成。


专用账户固定产物路径已实现，尚未实机运行：保护枚举 power_shell7_runtime_artifact 和准备 CLI --prepare-owned-system-powershell7-artifact 映射同一固定脚本；只在冻结 normal workload/no recovery 派发。两种 PowerShell7 runtime 才增加 instrumentation 并使用512预算，Git/Node/PowerShell5保持原预算；独立恢复按保护枚举同源判断，产物停树后用严格无别名25字节校验，失败保留error。新增枚举/能力预算选择负例回归；下一步运行确切UUID的专用账户产物与恢复对照，完整A/B未完成。


固定 PowerShell 产物校验进一步加固：绝对 UUID 夹具根与 output 都用原生 nofollow 目录句柄固定，文件 nofollow 同句柄检查链接数=1、精确25字节后才读取固定内容，避免使用映像128MiB预算分配和硬链接别名通过。新增真实硬链接、缺失、同长度内容变化、超长度、相对根负例，101项测试/Clippy通过。[更新校验实机](evidence/windows-stage-a-2026-10-09-powershell7-artifact-strict.json)exit73、artifact verified与停树/权限撤销/profile删除全部通过。仍是共享源固定脚本，不等于专用账户构建或完整A/B；尚不保证对已知合法单链文件进行恶意同内容替换的身份来源证明，完整journal需原对象身份绑定。


PowerShell 7 新增固定产物行为：共享源固定 CLI --run-lpac-powershell7-runtime-artifact，使用冻结 SSPA_FIXTURE/output 路径，.NET WriteAllText 关闭文件后 ReadAllText 重开校验，实际 exit73；控制端在停树后独立 ToolImageLease 同句柄读取并验证25字节固定内容，[通过回执](evidence/windows-stage-a-2026-10-09-powershell7-artifact-bound.json)。首轮 TEMP 被 AppContainer 重定向至 package 子目录导致控制端预期路径不存在，[首次失败](evidence/windows-stage-a-2026-10-09-powershell7-artifact.json)保留，未计成功。两轮 ACL/profile/进程清理均确认。新增 variant 仅固定脚本，无任意命令/路径入口；尚未包含 npm/build/Modules 完整行为或专用账户产物对照，完整 A/B 未完成。


“完整副本记录先于执行授权”顺序已在共享源 PowerShell 7 实机验证：[启动回执](evidence/windows-stage-a-2026-10-09-powershell7-runtime-record-before-grant.json)实际 exit73、topology/能力门禁/停树/权限撤销/profile删除全部通过。[清单核对](evidence/windows-stage-a-2026-10-09-powershell7-runtime-record-manifest-audit.json)意图与 completion 均 304 项、每项 source 身份一一对应、destination basename/root/bytes 匹配且 304 路径唯一，合计236516521 bytes、根身份记录一致。该核对仅证明实际保留的 manifest 映射，不替代 OS 对象身份复核或可信 B journal；授予执行前先完成 sync_all 的顺序由实现和故障回归验证。新增实机回归，99 项测试和 Clippy 通过。专用账户新顺序尚未重跑；完整 A/B 保持未完成。


运行时授权顺序已加固：先完成所有副本复制与冻结 source/destination 身份，复核源清单，再 create_new 写入并 sync_all 完整 completion manifest，最后才逐个授予 package FRFX。此前副本授权早于 completion manifest 的顺序已修正；保存冲突/超预算/写入错误不派发任何 grant，授权失败保留已落盘身份记录供精确恢复。新增实际文件冲突、256 KiB 预算、授权故障保留记录的回归，98 项测试与 Clippy 通过。本次改动尚未重新执行完整专用账户对照；历史启动证据不被改写。此清单仍为 A 固定运行时记录，不具备 B 原 SD/delta/认证 broker 完整事务语义，完整 A/B 未完成。


专用账户 PowerShell 7 恢复后已独立查询当前 OS：[状态审计](evidence/windows-stage-a-2026-10-09-powershell7-system-post-recovery-audit.json)确切 SID 的 SAM 用户、Win32_UserProfile、HKU hive 均不存在，原 admission/recovery 两个确切服务均不存在。回归同时检查真实 pwsh/conhost 两成员的 user/package/能力/Low4096/LPAC/精确 Job 与 topology、最终 active=0 和普通基线停树，避免只看 exit73或恢复 flags。A7 清单同步专用账户固定启动证据，完整脚本/构建/声明工具闭包与 A/B 其他项继续未完成，两个旧 hive 不包含在本轮审计内。


专用账户 PowerShell 7 固定启动实机通过，UUID cfc15886-16b6-41c8-97d6-7054e51db0ac：[原账户回执](evidence/windows-stage-a-2026-10-09-powershell7-system-profile.json) controller 固定 exit 73/output verified，actual 能力门禁/停树/runtime ACL 撤销通过。外层服务诊断失败仅因 owned namespace absence unconfirmed，原失败证据保留，不能将 service removed 等同完整清理。随后以独立固定恢复服务 d21f3aac-72b6-4df9-9bc8-5a944e5435a9 完成精确恢复，[恢复回执](evidence/windows-stage-a-2026-10-09-powershell7-system-recovered-profile.json)账户/profile/凭据/WFP/private namespace/station 均 removed=true、cleanup_debt=[]。所有提升 helper 进程已实际结束，两次服务记录 stopped/removed。仅证明固定启动与本轮恢复；不是脚本/构建、完整工具闭包、网络/凭据负例或完整 A/B。两个旧 hive 债务仍未解决，production unavailable。


专用账户 controller 能力门禁已补齐真实 SID 负例，与共享源门禁一致：actual/expected 各自唯一、数量与全部 attributes 精确一致，顺序可变；拒绝重复 expected/actual、缺项/额外项/null SID/属性变化。TokenCapabilities 切片前校验固定 16 项和实际 buffer 容量；能力名称只允许 registryRead/lpacInstrumentation。新增 native 回归通过，96 项测试及 Clippy 通过。本轮未执行提升准备/服务、未创建账户/WFP/profile；专用账户 PowerShell 7 实机启动与恢复仍未证实，完整 A/B 保持未完成。


专用账户 PowerShell 7 固定准备/派发路径已实现但尚未实机运行：新增保护记录枚举 power_shell7_runtime_instrumentation 与固定准备 CLI，沿用 normal workload/no recovery 的严格派发约束。controller 复制并持有原有 304 文件运行时，根/观察器均要求 registryRead + lpacInstrumentation，完整固定命令不接受任意脚本参数；正常撤销及独立账户恢复都按精确受保护 root identity 使用固定 runtime 512 预算，其他工具仍默认 64。未创建本轮账户/service/WFP，不能计专用账户兼容通过。现有派发负例测试覆盖新增枚举；95 项测试/Clippy 通过，下一步审核恢复与实际能力约束后开展固定实机对照。完整 A/B 尚未完成。


能力门禁新增真实 SID 回归：actual/expected 两侧必须各自唯一、数量完全一致、SID 和全部 attributes 匹配，允许顺序变化；拒绝缺项/额外项/重复 SID/属性变化/null SID，限定最多 16 项并在构造 slice 前检查 Token buffer 容量。修正此前重复 expected SID 可通过的问题。[更新门禁实机矩阵](evidence/windows-stage-a-2026-10-09-instrumentation-exact-capability-gate.json)现有 71 项全部通过，actual capability 精确、complete、停树/撤销/profile 删除均确认。95 项测试与 Clippy 通过；仍不能替代完整 A/B、专用账户工具和恢复验收。


PowerShell 7.6.6 自有运行时加 instrumentation 的完整固定启动首次通过：[实际回执](evidence/windows-stage-a-2026-10-09-powershell7-runtime-instrumentation-lpac-controller.json)。固定 `--run-lpac-powershell7-runtime-instrumentation` 仍使用原 304 文件/236516521 bytes 的平面引擎清单，源/副本 lease 与 intent/completion manifest，实际 `NoProfile/NonInteractive exit 73` 返回 73，stdout/stderr 为空。registryRead + lpacInstrumentation 两项实际 Token、LPAC/Low/user/Job 与工具/conhost 拓扑通过，停树、512 对象预算 ACL 撤销及 profile 删除全部确认，没有新恢复债务。未修改源安装 ACL、系统 ETW ACL 或审计行为。仅证明共享源固定启动；未包含 Modules/资源/用户配置完整闭包、专用账户、实际工具脚本/构建行为，也没有解决 PowerShell 5 instrumentation 超时。完整 A/B 仍未完成，production unavailable。


新增 registryRead + lpacInstrumentation 的共享源固定文件/网络矩阵已完成：[原始回执](evidence/windows-stage-a-2026-10-09-instrumentation-controller-network.json)。固定 CLI `--run-lpac-instrumentation-controller-network` 不接受任意 capability/路径/命令。现有 71 项全部成功且 complete=true，包括敏感/外部/AAP 文件拒绝、ADS/短路径、private registry、后代实际能力与 LPAC、breakaway、控制端进程危险权限、受保护文件、主/后代 Winsock 及四个控制端正向验证 TCP/UDP 接收器零流量。实际 root/后代 Job 观察与清理通过。本结果仅覆盖现有共享源矩阵；没有验证 DNS、私网、入站、系统 relay/RPC、凭据或专用账户，不能据此判完整 A/B 通过，完整 PowerShell 仍为前一轮超时。


完整 PowerShell 5 固定 `NoProfile/NonInteractive exit 73` 加 instrumentation 对照已执行，[原始回执](evidence/windows-stage-a-2026-10-09-powershell-instrumentation-lpac-controller.json)：实际能力恰好 registryRead/lpacInstrumentation，实际 LPAC/Low/Job 门禁通过，但固定等待期超时、stdout/stderr 为空，未获得正常退出证据。end_process 停树、fixture ACE 撤销和 profile 删除全部确认，不能将前一轮 ETW 初始化正向结果当作完整 shell 兼容成功。本 CLI 只允许固定 PowerShell 命令，其他实验不自动增加能力；未增加系统 ACL 或禁用审计。后续需定位完整启动阻塞，并验证新增能力的负向边界、专用账户和完整 A/B。


本轮固定 `--run-lpac-powershell-etw-instrumentation` 探针已得到正向结果：[实际回执](evidence/windows-stage-a-2026-10-09-powershell-etw-instrumentation-lpac-controller.json)。仅增加系统命名 capability `lpacInstrumentation`，与原 `registryRead` 共两项；实际 root/子进程能力、LPAC、Low、Job 和工具拓扑检查通过。两个固定 provider EventRegister=0、非零 handle、EventUnregister=0，原 PowerShell 5 GAC assembly 同 MVID 的 PSEtwLog 初始化成功；没有修改系统/provider ACL 或禁用日志。所有进程停止、fixture ACE 撤销、profile 删除已确认。名称依据 [Chromium 系统 capability 定义](https://github.com/chromium/chromium/blob/main/sandbox/policy/win/lpac_capability.h)。新增 capability 仅允许这一个固定诊断 CLI，现有其他实验不自动扩权；根 Token 校验改为全部 SID/attributes 恰好一一匹配，不能仅检查第一项。这只是共享源 ETW 初始化结果，尚非完整 PowerShell 命令/专用账户兼容成功，新增能力的文件、网络、凭据、RPC 负向矩阵仍需验证。两个旧 hive、凭据 1702、完整 A/B 和生产 unavailable 状态保持未完成。


PowerShell 7 自有平面运行时已进入真实 LPAC 初始化，但仍未通过兼容性。[首轮回执](evidence/windows-stage-a-2026-10-09-powershell7-runtime-lpac-controller.json)：从固定安装目录锁定并复制 304 个 engine DLL/exe/两个 runtime JSON，236516521 bytes；运行时源文件上限 384/320 MiB，源目录 READ_DATA share-read/no-follow lease、源/副本映像 lease 持有到停树，intent create_new+sync 先于授予，新副本逐个核对 identity/bytes 并仅添加自有 package FRFX。没有复制个人配置、脚本或 Modules/语言资源，此处不声称完整工具资产闭包。stderr 已出现 .NET 10 下 PSEtwLog→PSEtwLogProvider→Win32Exception(5)/EventProvider.EtwRegister 异常链，说明平面引擎加载走过此前 pwsh.dll 缺失阶段。异常引发实际 Job 内 WerFault；原固定两成员工具门禁和正常退出未确认，不能计作成功，所有实际观察到的 root/conhost/WerFault 均为预期 user/package/能力/Low/LPAC/Job，end_process 验证停树。撤销首次因内层清单仍固定 64 对象失败，保留原失败回执；修正为默认 64、仅运行时固定 512 的一致完整清单检查后，使用普通原创建者、原 pwsh.exe volume/file ID/bytes、根 owner 校验的无参数固定恢复 helper 清理本轮 package ACE/自有 registry key/AppContainer profile，见[独立恢复回执](evidence/windows-stage-a-2026-10-09-powershell7-runtime-fixed-recovery.json)，文件保留作证据，没有直接删除。随后补齐后续 runtime intent 的 root identity 与单独 256 KiB source/destination completion manifest；本轮原 intent 没有这些新增字段，不回填历史证明。新增 64/512 边界失败前 DACL 不变、超预算/核心资产缺失/选中目录别名拒绝回归，89 项测试及 Clippy 通过。固定恢复只针对这一个历史夹具，不是 B 通用恢复协议。两个旧 hive、凭据 1702、PowerShell ETW 权限与完整 A/B 仍未完成，生产 unavailable。

PowerShell 7.6.6 的固定普通与 LPAC 启动对照已完成，未替代 5.1 的失败记录。固定 `D:\Programs\PowerShell\7\pwsh.exe` 普通源执行 NoProfile/NonInteractive `exit 73` 成功，[正向回执](evidence/windows-stage-a-2026-10-09-powershell7-source-control.json)。[安装路径 LPAC](evidence/windows-stage-a-2026-10-09-powershell7-lpac-controller.json)实际退出 0x80008085，stderr 为 apphost 无法解析当前 executable 完整路径。随后仅从持有源句柄复制 pwsh.exe 到本轮自有 fixture，核对字节/身份并为副本授予 package FRFX，[自有入口 LPAC](evidence/windows-stage-a-2026-10-09-powershell7-owned-entry-lpac-controller.json)实际退出变为 0x8000809a，stderr 明确为相邻 pwsh.dll 不存在，说明该副本走过之前入口路径步骤，尚未得到完整运行时及 ETW 行为证据。两份实际工具/conhost Token/Job/Low/LPAC 拓扑、停树、fixture ACE 撤销及 profile 删除全部通过，源安装 ACL 未修改。固定 CLI 不接受任意路径或参数；原源 volume/file ID/bytes 与副本身份一同记录，新增实际源/副本失败原因区分和清理回归，86 项测试及 Clippy 通过。所需 runtime 的初步固定文件清单见[本机 inventory](evidence/windows-stage-a-2026-10-09-powershell7-runtime-inventory.json)；下一步需要完整、有界且可撤销的自有运行时资产方案，而非只复制 exe 或扩大原安装目录权限。PowerShell 7 尚未在专用账户通过，PowerShell 固定版本声明及完整 A/B 继续未完成。

ETW 已完成固定原生 API 对照。读取本机 provider catalog 确认 Microsoft-Windows-PowerShell GUID a0c1853b-5c40-4b15-8766-3cf1c58f985a；诊断 helper 分别对该 GUID 与固定独立诊断 GUID 3229ad87-338e-4e53-85b4-f77f5f2c2a07 调用 EventRegister，非零 handle 必须 EventUnregister 并记录返回码。没有创建 trace session、写事件、安装 manifest 或修改 provider ACL。[普通源](evidence/windows-stage-a-2026-10-09-powershell-etw-source-control.json)两项 register=0、handle 非零、unregister=0；[共享源 LPAC](evidence/windows-stage-a-2026-10-09-powershell-etw-lpac-controller.json)两项 register=5、handle=0，PSEtwLog 同 MVID 的初始化异常继续为 NativeErrorCode=5。结果排除了“只有 PowerShell provider 特定 GUID 失败”的解释，但只证明两个固定 provider 的本机行为，不能推断全部 ETW。parent 强制恰好两项固定顺序与 GUID、register/handle 一致、成功注销及失败无 handle；ordinary positive control 还要求两项注册成功。新增遗漏/重复/替换 provider、错误 handle、注销失败的回归，85 项测试和 Clippy 通过；诊断进程/fixture ACE/profile 均清理。依据 [EventRegister 官方文档](https://learn.microsoft.com/en-us/windows/win32/api/evntprov/nf-evntprov-eventregister)，注册是进程范围操作，不等于系统 manifest 安装；未采用改写全局 provider ACL 或禁用审计作为兼容性修复。PowerShell 5.1 仍失败，专用账户 native 对照与可行 shell 运行方案、完整工具行为和 A/B 验收继续未完成。

PowerShell 初始化失败已定位到 ETW 注册拒绝，而非程序集加载错误。新增普通桌面身份编译的固定 .NET Framework 4 x64 诊断 helper，只加载本机固定 GAC Windows PowerShell 5.1 System.Management.Automation 程序集，并运行 PSEtwLog 初始化器；没有脚本执行、任意程序集路径、日志绕过或系统 ACL 修改。helper 的固定源码/编译脚本位于 `tests/windows-sandbox-account/diagnostics/`；LPAC 使用本轮新副本与 package FRFX，源和副本 lease 均保留到停树。[普通源对照](evidence/windows-stage-a-2026-10-09-powershell-etw-source-control.json) initializer 成功、positive control=true、自有目录回收；[共享源 LPAC 对照](evidence/windows-stage-a-2026-10-09-powershell-etw-lpac-controller.json)加载相同 assembly_version/MVID a002aaca-c1f1-4bf9-8710-85b273cd7dce 后，异常链为 PSEtwLog → PSEtwLogProvider → System.ComponentModel.Win32Exception，NativeErrorCode=5，stack 指向 System.Diagnostics.Eventing.EventProvider.EtwRegister。诊断实际 exit=73 仅表示交付，initializer_succeeded=false；parent 独立验证固定程序集/类型、阶段、完整异常链、原生错误类型、MVID 与 16 KiB 预算，缺失/截断/未知字段/伪造成功均拒绝。实际工具/conhost 拓扑、停树、fixture 权限撤销、AppContainer profile 删除全部通过；没有新增 SAM/WFP/credential 资源。84 项测试及 Clippy 通过。该 helper 尚未在专用账户中复测，不能替代原 PowerShell 兼容性失败或完整 A/B；下一步须验证固定 ETW API 的隔离边界并确定是否存在保持审计与隔离语义的运行方案。公开 [PowerShell PSEtwLog 源码](https://github.com/PowerShell/PowerShell/blob/master/src/System.Management.Automation/utils/tracing/PSEtwLog.cs)仅用于定位线索，不作为本机 5.1 行为证明。

专用账户工具覆盖扩大到 Node 和 PowerShell。固定 protected 枚举新增 Node/PowerShell，没有任意路径或命令输入；执行映像从只读 lease 读取身份与 PE imports，持有到完整 Job 停止，沿用准确账户 target context、暂停身份检查、LPAC、Low、registryRead 能力、显式三 stdio 句柄和自有 HOME/TEMP 环境。Node UUID 78c1bb9d-4c84-4c90-b28b-833b30917342、SID 尾号 1085，[实际固定脚本 exit 73](evidence/windows-stage-a-2026-10-09-node-system-profile.json)，stdout/stderr 空、真实 Node/conhost 拓扑核验及最终 active=0。PowerShell UUID e192e22d-eb61-41ab-bcf7-223f77ef00bc、SID 尾号 1086，[实际 exit 0xffff0000](evidence/windows-stage-a-2026-10-09-powershell-system-profile.json)，stderr 原样保留 PSEtwLog 类型初始化异常；实际进程身份/Job 拓扑、停树和 fixture ACE/profile 清理通过，但工具兼容性失败。两次首轮 namespace absence 未确认，故外层诊断均非完整成功；固定恢复服务 4ab261ec-d3ac-4118-99d7-449219731e5f 与 296ab8db-e9f2-41f8-ba66-90c0a6e29441 后，[Node](evidence/windows-stage-a-2026-10-09-node-recovered-profile.json)及[PowerShell](evidence/windows-stage-a-2026-10-09-powershell-recovered-profile.json)新增账户/profile/凭据/WFP/namespace/windowstation 债务均清空，两个恢复 service-result diagnostic_error=null，四个服务均 retired。PowerShell 原执行 error 保留，恢复成功不改变兼容性结果。新增三种工具对 lifecycle/recovery 混用的门禁回归及两份实际回执的成功/失败/恢复范围回归，82 项测试及 Clippy 通过。专用账户普通工具正向对照、完整工具行为、PowerShell 原因/修复、凭据 1702、两条旧 hive 债务与完整 A/B 未完成。

专用非管理员账户的 Git bundle 固定启动已实测通过：[账户执行回执](evidence/windows-stage-a-2026-10-09-git-bundle-system-profile.json)，UUID 10f7b738-a61a-496c-89b5-2b1dd5cd22fc、SID 尾号 1084。受保护 SYSTEM preparation 只冻结 `git_bundle` 枚举，拒绝与 recovery/lifecycle 混用；沿用确切目标账户 thread context 的 CreateProcessAsUser、暂停身份/Job 核验、显式三 stdio 继承句柄和自有环境。Git actual_exit=0、版本输出完整、Git+conhost 两成员均通过实际账户/package/能力/Low/LPAC/Job/映像门禁，最终 active=0、fixture 权限撤销、AppContainer profile 删除。首轮外层 namespace absence 未确认，故[原服务结果](evidence/windows-stage-a-2026-10-09-git-bundle-system-result.json)仍为 diagnostic_error，不计完整清理通过；固定独立恢复 8666f6ac-c198-4fd1-8608-ede977e45278 后，[账户/profile/凭据/WFP/namespace/windowstation 清空](evidence/windows-stage-a-2026-10-09-git-bundle-recovered-profile.json)，债务为空，[恢复服务 diagnostic_error=null](evidence/windows-stage-a-2026-10-09-git-bundle-recovery-result.json)，两个自有服务均 retired。新增版本输出不完整/额外内容/错误诊断拒绝、protected tool/lifecycle/recovery 组合拒绝，以及实机回执不能替代完整 workload 和首轮清理的回归；81 项测试与 Clippy 通过。本轮只覆盖 Git --version，不替代专用账户普通工具正向对照、Git/npm/build helper/config 行为、PowerShell、凭据 1702、两个旧 hive 或完整 A/B；production unavailable 保持。

自有 Git bundle 已完成共享源账户的真实 LPAC 启动。[实际回执](evidence/windows-stage-a-2026-10-09-git-bundle-lpac-controller.json)：复制固定 Git runtime 与 libiconv-2/libintl-8/libpcre2-8-0/zlib1 五个映像，静态递归收集上限 16 files/64 MiB/128 个唯一依赖名；冻结清单 create_new+flush 先于复制与授予。只对 self-created copy、持有且身份匹配的 leaf handle 设置 package FRFX，源安装目录及系统 ACL 未放宽。Git actual_exit=0、stdout=`git version 2.55.0.windows.3`、stderr 空；Git+conhost 共两成员实际 Token/Low/LPAC/能力/Job/映像拓扑核验通过，tree stopped、fixture ACE revoked、profile removed 均 true，error=null。原型仍退出 2，产品准入仍关闭。新增本机固定源回归在准备之前记录五个源文件 DACL，验证准备、拒绝重复清单/非法 SID/向源映像授予和副本撤销后源 DACL 均不变，随后回收测试目录；78 项测试及 Clippy 通过。这里的静态本地闭包不覆盖 delay/dynamic/helper/config 行为，UUID 目录仍须由固定 fixture 调用者建立所有权；不作为完整路径并发安全或 privileged broker 方案。专用账户工具执行、PowerShell 初始化异常、完整构建/npm/git 行为、凭据 1702、两个旧 hive 与 A/B 完整验收仍未完成。

自有 Git bundle 的复制基础已补齐，尚未接入实际 LPAC 启动。`ToolImageLease::copy_new_owned` 从已持有的源文件句柄读取有界内容，目标只接受 UUID fixture 下的 `git.exe` 或合法 DLL basename，使用 create_new、flush、写入句柄的 volume/file ID 与重新取得的只读 lease 身份及字节比对。副本持有根目录数据读取 lease 到调用者释放，防止本轮根改名；失败保留对象供后续诊断清理，不自行删除。新增实际 Windows 文件共享回归覆盖源及副本拒绝写入、根拒绝改名、拒绝覆盖、拒绝穿越/设备名及释放后恢复写入；77 项测试及 all-targets Clippy 通过。本方法属于普通权限诊断基础，UUID 名称不构成所有权授权；尚未实现 bundle 冻结清单、依赖递归闭包、package ACE 授予/撤销与实际运行，不能作为 Git 兼容性或完整祖先路径防替换证明。两个旧 hive、凭据 1702、完整默认策略和 A/B 验收仍未完成。

Git 加载失败已获得具体依赖权限证据。新增从原映像 lease 读取的有界 PE32/PE32+ 静态导入表解析：128 MiB 映像、96 sections、128 imports、255-byte DLL basename；RVA/raw/header extent、目录终止、重叠、截断、溢出、设备名与路径穿越失败均拒绝。冻结 Git runtime 的 10 项静态导入包含 libiconv-2/libintl-8/libpcre2-8-0/zlib1，[冻结导入与 runtime 回执](evidence/windows-stage-a-2026-10-09-git-imports-lpac-controller.json)仍 0xc0000135。固定 dependency probe 只在未提升的普通/LPAC 子进程中，针对 Git 目录与 System32 逐项进行文件 lease、绝对路径 LoadLibraryEx（仅 DLL 所在目录和 System32 搜索）、记录实际 loaded module path、FreeLibrary；不在控制器内加载工具 DLL。最初 LPAC 自行读取 Git 映像即 Win32 5，因此改由 parent 持有 Git 映像并派发 8 KiB 内冻结身份/导入计划，子进程不接受任意目录。parent 将 16 KiB 内 delivery 与实际 held subject identity/导入集合/完整唯一两位置检查/固定路径及成功 module 释放绑定。普通源四个 Git DLL 的读取、加载、释放均成功，[源对照](evidence/windows-stage-a-2026-10-09-git-dependency-source-control.json)；LPAC 四者读取和 LoadLibraryEx 均 Win32 5，[LPAC 对照](evidence/windows-stage-a-2026-10-09-git-dependency-lpac-controller.json)。两个报告主体身份相同，binding verified=true，实际工具探针/conhost 拓扑完整，全部树/夹具权限/profile 已回收。76 项测试、锁定构建、all-targets Clippy、fmt check 通过。dependency probe 的退出 73/error=null 只表示诊断已完整交付，不能把 DLL 拒绝计为 Git 兼容性通过；当前不是完整 transitive/delay/dynamic 依赖闭包。下一步验证自有工具 bundle 的冻结复制与必要 DLL 授权，原安装目录/系统 ACL 不应放宽。完整 A/B、PSEtwLog、凭据 1702、两个旧 hive 债务仍未完成。

实际普通源同环境工具正向对照已补齐：新的 `--run-source-*-control` 固定入口拒绝 elevated primary、AppContainer primary 与已有线程模拟，固定参数、显式自有 HOME/TEMP、三 stdio 句柄、暂停创建和自有 Job。观察器独立普通上下文门禁要求所有成员实际同用户/同完整性、非 AppContainer、空包及能力、精确 Job/冻结映像/唯一 PID，不能混用 LPAC 门禁。PowerShell/Node 实际退出 73，Git launcher 退出 0 并输出 2.55.0.windows.3，分别见 [PowerShell](evidence/windows-stage-a-2026-10-09-powershell-source-control.json)、[Git](evidence/windows-stage-a-2026-10-09-git-source-control.json)、[Node](evidence/windows-stage-a-2026-10-09-node-source-control.json)。Git launcher/实际 runtime 两个映像均冻结，普通 Git 的实际 3 成员（launcher/runtime/conhost）通过，其他普通工具 2 成员通过。绕过 launcher 的固定 Git runtime 对照：普通源成功，[回执](evidence/windows-stage-a-2026-10-09-git-runtime-source-control.json)；LPAC 实际退出 0xc0000135，[回执](evidence/windows-stage-a-2026-10-09-git-runtime-lpac-controller.json)，对应 STATUS_DLL_NOT_FOUND，仅定位到加载失败而未确定哪个 DLL。所有普通夹具进入回收站，LPAC 实验权限/profile 已退役。72 项测试、锁定构建、all-targets Clippy、fmt check 通过；重构后的[完整共享源 LPAC 文件/网络回归](evidence/windows-stage-a-2026-10-09-source-observer-regression-controller.json) error=null、4 成员/清理通过。普通正向证明本轮固定环境可以运行工具，不能替代专用账户工具、DLL 依赖闭包或完整 A7 验收；PSEtwLog、Git 依赖、凭据 1702 与两个旧 hive 债务仍未解决，A/B 未完成。

固定工具 admission 新增显式 stdio：只通过 PROC_THREAD_ATTRIBUTE_HANDLE_LIST 继承 NUL/stdout/stderr 三个真实句柄，STARTF_USESTDHANDLES 与 bInheritHandles 同步设置，映像、Job 和其他句柄不在列表。stdout/stderr CREATE_NEW 于自有 output；完整 Job 停止后从原句柄各读取最多 16 KiB，关闭 stdio 后才撤销 fixture ACL。预算、原句柄读取、重复创建拒绝、inheritable flags 和 UTF-16/UTF-8 解码回归通过。PowerShell 原始错误为 `System.Management.Automation.Tracing.PSEtwLog` 类型初始值设定项异常，[回执](evidence/windows-stage-a-2026-10-09-powershell-stdio-controller.json)保留可读本地化 UTF-16 诊断；Git stderr 为 `error launching git`，[回执](evidence/windows-stage-a-2026-10-09-git-stdio-controller.json)；Node 仍 73 且 error=null，[回执](evidence/windows-stage-a-2026-10-09-node-stdio-controller.json)。三条实际工具/conhost 拓扑仍全部通过，进程树、fixture ACL、profile 已回收。71 项测试、锁定构建、all-targets Clippy、fmt check 通过。此证据定位了启动错误信息，不能证明 ETW 或 Git 依赖失败的内部根因；仍需普通源/专用账户同环境对照、依赖冻结及完整工具行为，不添加额外 capability、不修改系统 ACL 来掩盖失败，完整 A/B 未完成。

真实工具的共享源 LPAC admission 已加入独立固定入口并实机运行：PowerShell/Git/Node 均创建暂停 primary、入自有 Job、核验实际用户/package/唯一 registryRead capability/Low/LPAC，所有实际成员（工具与 conhost）完整拓扑通过。工具入口使用固定绝对映像和固定参数，不使用 PATH；持有 FILE_READ_DATA、share-read-only 映像句柄到回收，记录卷号/file ID/大小，拒绝目录、reparse 和 128 MiB 以上文件；不修改工具或系统 ACL。环境只传显式目录及固定 Git 限制，HOME/USERPROFILE/LOCALAPPDATA/TEMP/TMP 指向自有 output，PowerShell 禁用 profile，未继承宿主 PATH、代理或秘钥配置。Node `process.exit(73)` 成功，[Node 回执](evidence/windows-stage-a-2026-10-09-node-admission-controller.json) error=null；PowerShell `exit 73` 实际 0xffff0000，[回执](evidence/windows-stage-a-2026-10-09-powershell-admission-controller.json)拒绝；Git `--version` 实际 1，[回执](evidence/windows-stage-a-2026-10-09-git-admission-controller.json)拒绝。修正了固定路径分隔符造成的最初拓扑误判，重跑后上述全部 topology=true。三次进程树停止、fixture ACL 撤销和 profile 退役均通过。69 项测试、锁定构建、all-targets Clippy、fmt check 通过；[源文件版本/摘要快照](evidence/windows-stage-a-2026-10-09-tool-source-versions.json)仅为安装映像 inventory，不能代替冻结运行时版本验收。该入口当前仅共享源账户 admission，不证明专用账户完整工具兼容性、工具依赖闭包、构建行为或网络矩阵；PowerShell/Git 失败原因与专用账户工具路径仍须继续验证，A7/完整 A/B 不得标完成。

自身模拟下的精确 credential reference 对照已实机完成（UUID 056756f4-bcac-48ce-a7ee-97b01e1bac38）。仅当环境中的固定引用与实际 primary 用户 SID/本轮 UUID 同源才启用；线程比较通过后，再核验线程用户/AppContainer 身份，调用同一 bounded owned-reference CredRead 负例，意外成功仍擦除 SDK blob、不记录内容。普通账户原始和自身模拟都返回 1168；LPAC 自身模拟的比较字段一致、恢复 verified=true，但 CredRead 仍 Win32 1702；LSA 连接仍 Access Denied，见 [完整回执](evidence/windows-stage-a-2026-10-09-credential-self-profile.json)。因此排除本轮“仅增加自身模拟即可修复 CredRead”的假设，不修改原始 primary 凭据失败门禁，不把 LSA 拒绝代替凭据验收。67 项测试、锁定构建、all-targets Clippy、fmt check 通过。独立恢复服务 99e97ef1-9471-474a-b550-0aa24d537e48 已清空本轮所有自有资源，[债务为空](evidence/windows-stage-a-2026-10-09-credential-self-recovered-profile.json)，恢复 diagnostic_error=null，两个服务已退役。下一步需扩展实际工具与默认策略矩阵，并独立继续定位 Credential API 的失败层；完整 A/B、两个旧 hive 恢复仍未完成。

LSA 同身份线程模拟对照已实机完成（UUID d1bd6d25-1481-4b69-8900-d2f8b86bdbab）。ImpersonateSelf 前拒绝已有线程模拟；比较实际 primary/thread 的用户 SID、完整性 SID、AppContainer 状态、包 SID、能力 SID/attributes 和 AuthenticationId，随后调用固定 LsaConnectUntrusted 并 RevertToSelf，复核线程无 Token 与 primary 比较字段不变。普通账户原始及自身模拟的 LSA 连接/关闭均 0；LPAC 原始连接仍 0xC000007C，自身模拟成功、所比较字段一致，连接返回 -1073741790（0xC0000022 / STATUS_ACCESS_DENIED），未获句柄，恢复 verified=true，见 [完整回执](evidence/windows-stage-a-2026-10-09-lsa-self-profile.json)。此为连接层权限负例，不证明 CredRead 原始 1702 已解决，也不把线程对照代替原始 primary 凭据验收。失败回退使用 RAII，RevertToSelf 失败立即 abort；任何可能返回的上下文错误在 RPC 分配前完成。66 项测试、锁定构建、all-targets Clippy、fmt check 通过。独立恢复服务 6476b4e1-01b4-4821-8b05-bcdff7042aa9 回收本轮全部凭据/profile/账户/过滤器，[债务为空](evidence/windows-stage-a-2026-10-09-lsa-self-recovered-profile.json)，恢复 diagnostic_error=null，两个服务均已退役。完整 A/B 与两个旧 hive 恢复仍未完成。

凭据 1702 排查新增 LsaConnectUntrusted/LsaDeregisterLogonProcess 固定连接诊断，不查询认证包、会话或凭据数据，不更改凭据验收条件。SYSTEM 专用账户实机 UUID cc01a07d-398d-4488-899c-a506b8d69881：普通 primary 的连接/关闭均 NTSTATUS 0；LPAC 的 LsaConnectUntrusted 返回 -1073741700（0xC000007C / STATUS_NO_TOKEN），未获得句柄；同一 LPAC 的本地 RPC 绑定创建、认证配置与释放仍全部 0，CredRead 仍 Win32 1702，见 [完整回执](evidence/windows-stage-a-2026-10-09-lsa-admission-profile.json)。该差异说明 client-side RPC 配置成功不能证明 LSA 连接成功，尚不能据此宣称凭据权限拒绝或已查明 CredRead 内部根因。65 项测试、锁定构建、all-targets Clippy、fmt check 通过。恢复服务 da68a80c-70f1-467a-bb0a-4ddd8a694207 已精确回收本轮凭据/profile/账户/过滤器，[债务为空](evidence/windows-stage-a-2026-10-09-lsa-admission-recovered-profile.json)，恢复 diagnostic_error=null，原 workload 与恢复服务均已退役。两个旧 hive 债务仍保留，完整 A/B 未完成。

三类固定报告已统一为有界、同句柄读取：根 workload 最多 16 KiB，leaf network 与普通账户凭据对照各最多 4 KiB；先验证根目录、output 和文件类型，拒绝 reparse 与文件硬链接，持有目录句柄并通过已验证文件句柄读取，超预算在 serde 前拒绝。预算边界、大文件、output junction、报告硬链接回归及共享宿主实机通过。专用账户 SYSTEM 实机 UUID df279f95-f51c-49e0-b4ae-02d732a9817f 的普通 primary、root、leaf 报告读取通过，74 项中仅 owned SYSTEM credential reference 检查因 Win32 1702 失败，其余 73 项通过，普通 primary 对照为 1168，实际 Job 最终 active=0/total=4，见 [完整回执](evidence/windows-stage-a-2026-10-09-report-reader-profile.json)。恢复服务 48560242-b5c2-4d63-b27c-9b47d6977567 已回收本轮凭据/profile/账户/过滤器，两个服务均退役，[债务为空](evidence/windows-stage-a-2026-10-09-report-reader-recovered-profile.json)，恢复 diagnostic_error=null。63 项测试、all-targets Clippy、fmt check 通过。本改动仅保护固定原型报告，不证明完整 broker 消息边界、调用者授权或并发路径替换安全；两个旧 hive 债务、凭据 1702 与完整 A/B 仍待完成，生产 unavailable。

8.3 短目录及敏感文件短名八项访问已在共享宿主和专用账户 LPAC 实机完成（专用账户 UUID cb1340de-475e-4513-885f-56750d5bfff0）：控制器调用 GetShortPathName，并要求当前对象最后一段确实不同，分别通过两个 held handles 比较卷号/file ID，不能把仅祖先已有别名或 API 返回原长名算作本对象短名覆盖。冻结短目录与自有 `.env.local` 文件短名到固定环境；LPAC 的目录别名 readonly/workspace/secret 六项读写符合原权限，`.env.local` 文件短名两项读写均 Win32=5，见[专用账户回执](evidence/windows-stage-a-2026-10-09-short-alias-profile.json)、[共享宿主对照](evidence/windows-stage-a-2026-10-09-short-alias-controller.json)。内容全部为固定非敏感 fixture，未读取用户 .env。[Microsoft API 文档](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getshortpathnamew)说明成功可能返回原长名，因此没有真实别名时当前诊断拒绝而非跳过计绿。核心门禁扩为 71 项（另有 3 项 credential）；旧回执缺失短名观察不能匹配。61 项测试、Clippy、构建及 fmt 通过，新增实际根和 `.env.local` 短名身份回归及新实机回执回放；完整凭据门禁仍因 1702 拒绝。独立恢复服务 f09ad4b9-6c83-4740-ab8a-daf67d8be3c4 已清空本次全部资源，[债务为空](evidence/windows-stage-a-2026-10-09-short-alias-recovered-profile.json)，恢复 error=null。该证据仅证明本机固定对象的短名 ACL 访问，不替代完整默认策略路径规范化、其他卷或并发 namespace 替换；两个旧 hive 仍待重启后恢复，A/B 未完成。

实际 LPAC leaf 后代网络四项尝试已在共享宿主及专用账户 SYSTEM 路径完成（专用账户 UUID df12e127-6f53-490a-992b-c39058cf5738）。固定 leaf 不再只退出：normal 模式实际 WSAStartup=0、v4/v6 TCP connect 与 UDP bind/send 均 Win32=10013；UUID/SID/version、精确五项检查和 4096-byte 读取预算由 parent 在 leaf 退出后核验并合并，父级暂停身份/Job 核验仍先于 Resume，执行树保持同一四成员及最终 active=0。四项 controller receiver 正向控制已通过、结束 received=0，见[专用账户回执](evidence/windows-stage-a-2026-10-09-descendant-network-profile.json)、[共享宿主对照](evidence/windows-stage-a-2026-10-09-descendant-network-controller.json)。UDP API 记录本身仍不作为拒绝证明，必须结合实际 receiver；完整 workload 仍因 credential 1702 未通过。正常门禁基础集合扩大为 63 项（另有 3 项 credential），旧 root-only 58 项回执不再匹配；真实新回执基础集合匹配但完整凭据门禁拒绝，错误 UUID/SID/version、重复与 incomplete leaf 报告有回归。59 项测试、Clippy、构建及 fmt 通过。独立恢复服务 15e91032-1658-4685-b7f5-111f81412436 清空本次全部自有凭据/profile/账户/过滤器，[债务为空](evidence/windows-stage-a-2026-10-09-descendant-network-recovered-profile.json)，恢复 error=null。该证据不替代 DNS、私网、入站、替换程序或服务代办矩阵；两个旧 hive、默认策略、完整 broker 与 A/B 仍未完成。

真实 NTFS junction 的根及嵌套目录撤销拒绝回归已在本机执行通过。独立测试创建全新 UUID 目录，junction 指向同一自有测试根的外部 target，实际经 junction 读取固定 marker 成功；分别将拥有目录（含 junction）和 junction 本身作为 revoke_files 根，都必须返回 reparse rejected。拥有目录与普通文件带实际 package ACE，对比撤销前后 owner/file/target 的二进制 DACL 完全一致，target 内容保留。首轮夹具写 handle 导致只触发 Win32 sharing violation，已经关闭该写 handle 后复测，确认走实际 reparse 门禁；清理保留原对象 identity，重新取得写 handle 时比较 volume/file ID，仅移除匹配对象的 reparse 数据，之后沿用回收站清理普通测试树，当前没有 ShellSpan-reparse-* 残留。夹具按 [Microsoft REPARSE_DATA_BUFFER mount-point 布局](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer)构造，只在 cfg(test) 中使用，未加入任意高权限 API。新增 Win32_System_Ioctl feature，依赖版本不变。57 项测试、all-targets Clippy、构建和 fmt check 通过。该证据覆盖普通宿主的真实 junction 撤销门禁，不替代专用账户执行路径、准入默认规则、其他 reparse tag 或并发替换；两个旧 hive 仍待重启后恢复，凭据 1702 与完整 A/B 未完成。

固定重启后恢复脚本的幂等门禁继续加固：旧版本会仅凭回执 retirement flags 跳过恢复，现已删除该跳过分支；[纯门禁模块](../../tests/windows-sandbox-account/scripts/InterruptedProfileGate.psm1) 区分记录退役、当前 OS 一致与恢复资格，拒绝 SAM/hive/profile/service 矛盾、非布尔字段、未知账户缺席状态，支持 durable profile retirement 之后的部分账户/过滤器恢复。标记一致也继续调用 native 固定 SYSTEM 恢复重新核验当前进程、凭据、WFP，结束后再次核验当前 SAM/hive/CIM/service。新增[门禁回归](../../tests/windows-sandbox-account/scripts/Test-InterruptedProfileGate.ps1)覆盖 stale flags、未清理 credential、部分清理续作及畸形字段，PowerShell 语法和回归通过。实际两个 hive 仍加载，脚本拒绝且准备目录数量不变，见[更新拒绝证据](evidence/windows-stage-a-2026-10-09-hive-recovery-script-negative.json)。Windows boot time 未变化，尚未执行手动重启；本轮没有新服务/账户/过滤器，也未验证重启后正向或整个 B6。A/B 未完成，重启时机仍等待操作者安排。

两个既有崩溃 hive 的当前状态已重新核验，见 [OS 状态快照](evidence/windows-stage-a-2026-10-09-hive-debt-current-state.json)：SAM SID 与保护回执匹配、账户禁用、原服务缺席，但 HKEY_USERS 与 Win32_UserProfile.Loaded 均确认 hive 仍加载。准备固定 [重启后恢复脚本](../../tests/windows-sandbox-account/scripts/Recover-InterruptedProfiles.ps1)，只绑定 ba16502e/4bb6655d 两项 UUID/SID/账户，不自动重启；提供 InspectOnly，预检不符合则不准备新服务，正向才使用既有固定 SYSTEM 恢复契约并检查最终服务与资源回执。语法解析、[只读检查](evidence/windows-stage-a-2026-10-09-hive-recovery-script-inspection.json)、[拒绝无新准备资源](evidence/windows-stage-a-2026-10-09-hive-recovery-script-negative.json) 已实测。注册表路径分隔符的初次检查误报已修正，并用实际加载 hive 复测一致。已请求操作者安排手动重启时机，因为这会中断其他程序；重启后正向恢复未测，不能声明债务解除，也不把本次 readonly 诊断算完整 B6。A/B 未完成，生产 unavailable。

固定工作负载回执验收缺口已修复：此前正常路径主要依赖 `complete && all(passed)`，只对 credential 项检查唯一性，其他项可能被缺失/重复/无关 passing 项替代；现在明确要求 58 项基础检查及启用 credential 时的 3 项附加检查各出现且通过一次，并拒绝额外项。中断路径原来只看 17 项数量与 passing，现在要求精确 13 项文件前置检查及 4 项 controller receiver 检查，且 complete 必须为 false。新增逐项遗漏/重复/未知/失败和错误完成标记回归；回放已保存硬链接实机回执，完整基础集合匹配，原 credential 1702 仍拒绝；回放真实 repeated-cancel 回执仅匹配中断契约，不能升级为正常完成。56 项测试、all-targets Clippy、fmt check 通过。本轮未创建 OS 资源，也未以历史证据回放代替新 OS 功能实测；该契约仅表达固定原型工作负载，不证明整个阶段 A/B 已完成，生产仍 unavailable，两个旧 hive 债务保留。

只读/敏感文件到可写目录的硬链接创建负例已在共享宿主与专用账户 LPAC 实机通过（专用账户 UUID 73681a3b-afff-4fe2-9d80-78b7abac0e8b）：源上下文先对同一源文件与 output 目录成功创建、读取并移除精确新建测试别名，LPAC 两项 fs::hard_link 均返回 Win32=5，见 [专用账户回执](evidence/windows-stage-a-2026-10-09-hardlink-profile.json)、[共享宿主对照](evidence/windows-stage-a-2026-10-09-hardlink-controller.json)。固定正向别名在启动前移除，避免硬链接计数污染权限退役；既有硬链接退役拒绝回归仍通过。52 项测试、all-targets Clippy、fmt check 通过。独立恢复服务 92bee7ea-d49c-44d3-a2bd-b62d17ed1619 已清理本次全部凭据/profile/账户/过滤器，[债务为空](evidence/windows-stage-a-2026-10-09-hardlink-recovered-profile.json)，恢复 error=null。该证据不替代既有跨项目 alias 的准入检查、并发硬链接替换或完整默认策略；短名、reparse、凭据 1702、两个旧 hive 债务和完整 A/B 仍待完成。

Everyone 授权外部文件读写负例已在共享宿主及专用账户 LPAC 实机通过（专用账户 UUID 1dadd254-a81f-4e0b-bc6e-51595c0b53f0）。固定文件显式 Everyone FRFW；实际文件 handle GetSecurityInfo/GetAce 核验 Everyone 掩码完整且无 S-1-15 package/capability ACE，源账户读/写打开正向也通过，LPAC 读写均 Win32=5，见 [专用账户回执](evidence/windows-stage-a-2026-10-09-everyone-profile.json)、[共享宿主对照](evidence/windows-stage-a-2026-10-09-everyone-controller.json)。回归测试将实际 Everyone ACE 降为只读时，源门禁必须拒绝而不能误把夹具缺失计为隔离成功。52 项测试、all-targets Clippy、fmt check 通过。独立恢复服务 e298c626-bf33-49e2-be68-3d7c00427698 已完成本次全部自有凭据/profile/账户/过滤器清理，[债务为空](evidence/windows-stage-a-2026-10-09-everyone-recovered-profile.json)，恢复 error=null。本证据仅覆盖固定 Everyone 文件，不替代任意对象、目录祖先或完整 ACL/默认策略矩阵；凭据 1702 和两个旧 hive 债务仍未解决，A/B 未完成。

可写目录内受保护子 DACL 的 rename/delete 边界已实机通过（专用账户 UUID 2dddade5-e674-45d3-94d7-b7c1966ed1e9）：output 普通继承 ACE 允许 child DELETE，不授予父目录 FILE_DELETE_CHILD；固定 protected.txt 关闭继承且无 package ACE。源账户先通过读/写/DELETE 打开正向，LPAC 普通 artifact rename/delete 成功，protected child 的 read/write/rename/delete 全部 Win32=5，见 [专用账户回执](evidence/windows-stage-a-2026-10-09-protected-child-profile.json)。独立恢复服务 496d29e0-dfbc-48b6-b208-23d9b5321272 清空本次全部资源，[债务为空](evidence/windows-stage-a-2026-10-09-protected-child-recovered-profile.json)，恢复 error=null。新增 controller 停树后内容/目标路径复核，并在[共享宿主 LPAC 实机](evidence/windows-stage-a-2026-10-09-protected-child-controller.json)通过（error=null/tree stopped/fixture ACL revoked/profile removed），仅是该新增复核的共享宿主证据。52 项测试及 all-targets Clippy 通过。该结果不替代完整默认项目策略、并发宿主 ACL、Everyone 或祖先 rename/delete 验收；凭据 1702 与两个旧 hive 债务仍保留，A/B 未完成。

NTFS 备用数据流六项固定负例已实机通过（UUID 3bf5dd08-4c5d-4b29-8717-b275a357470f）：自有 readonly/workspace/secret 文件预置 owned-probe 流，普通 SYSTEM 创建上下文及精确源账户先验证流内容及写打开正向，LPAC 随后实际 read/write：readonly 流读取成功、写入 Win32=5；workspace 流读写成功；secret 流读写 Win32=5，见 [完整回执](evidence/windows-stage-a-2026-10-09-ads-profile.json)。没有读个人数据，流只含固定非敏感测试内容。回归测试覆盖流内容篡改时源正向门禁拒绝、基础流内容保持独立；52 项测试及 all-targets Clippy 通过。独立恢复服务 6457af00-4422-4334-b805-4c06027e8c25 完成全部自有凭据/profile/账户/过滤器清理，[最终债务为空](evidence/windows-stage-a-2026-10-09-ads-recovered-profile.json)，恢复 error=null。该证据仅覆盖既有固定流访问，不替代默认项目规则、任意流创建、路径规范化或并发替换验收。凭据 1702 和两个旧 hive 债务仍保留，A/B 未完成。

重复取消固定路径已实机通过（UUID 78680981-2497-4295-84ee-bc51abb09353）：后代恢复标记出现后同一 manual-reset event 连续 SetEvent 三次，wait 命中取消事件，actual tree active=4/total=4，所有成员身份/映像/Job 观察通过；首次 end_process 后对同一组 held root/Job handles 再执行两次，最终 active=0/total=4、重复退役 verified=true、controller report error=null，见 [完整回执](evidence/windows-stage-a-2026-10-09-repeated-cancel-profile.json)。该有限证据覆盖取消信号重复发送及相同稳定句柄重复回收，不替代未来 broker 重放/并发取消/断连语义。服务退出前 namespace absence 未确认，因此保留债务且初次 service-result diagnostic_error 非空；独立恢复服务 76db9ae9-cff5-44e2-878c-e352c28bf5d4 随后完成精确清理，[最终债务为空](evidence/windows-stage-a-2026-10-09-repeated-cancel-recovered-profile.json)，恢复 error=null。52 项测试及 all-targets Clippy 通过，新增真实 Job 重复终止测试确认 accounting 总数不变。两个旧 hive 债务仍保留，A/B 未完成。

显式 Job breakaway 负例已实机通过（专用账户 SYSTEM LPAC，UUID 6f799249-5588-4931-8f7a-b49b6214a1ab）：同一冻结 probe 映像使用 CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | CREATE_NO_WINDOW、无继承句柄，CreateProcess 返回失败及 ERROR_ACCESS_DENIED (5)；不把文件不存在等其他失败计为通过。同映像普通后代创建成功、实际 Job/身份核验通过并以 73 退出，见 [完整回执](evidence/windows-stage-a-2026-10-09-breakaway-profile.json)。意外成功分支保持暂停、终止并等待精确句柄，不恢复执行。固定恢复服务 22ab4930-75c6-484d-b4ff-92bbbc3e8e24 随后清空本次凭据/profile/账户/过滤器，[债务为空](evidence/windows-stage-a-2026-10-09-breakaway-recovered-profile.json)，恢复诊断 error=null。51 项测试和 all-targets Clippy 通过。该证据覆盖 A6 的本次根到 leaf 显式 breakaway，不替代并发、重复取消、其他工具后代或完整崩溃恢复；凭据 1702 及两个旧 hive 债务仍未解决，A/B 未完成。

固定 RPC 认证配置对照已实机完成（UUID 8c11808c-bf1e-42d3-be61-274f76fbc8de）：普通 primary 与 LPAC 均成功配置 WINNT/current-token、packet privacy、static identity、IDENTIFY QoS，绑定创建和释放也全部返回 0；没有联系服务端或发送请求。LPAC CredRead 仍为 1702，普通 primary 为 1168，见 [完整认证配置对照](evidence/windows-stage-a-2026-10-09-rpc-auth-configuration-profile.json)。该结果仅排除本次固定绑定的客户端认证配置失败，不证明 Credential Manager 实际端点可达或 credential-set 权限拒绝。独立恢复服务 d08d3668-895c-4a43-aabe-1ed01d5f1c48 已退役，本次凭据/profile/账户/四项过滤器均删除，[债务为空](evidence/windows-stage-a-2026-10-09-rpc-auth-configuration-recovered-profile.json)，恢复诊断 error=null。50 项测试及 all-targets Clippy 通过；缺失认证结果不能误计成功。既有两个 hive 债务保留，A/B 仍未完成，生产 unavailable。下一步仍需定位实际凭据服务调用边界。

通用本机 RPC 客户端初始化对照已实机完成（UUID 316def03-92f3-429e-90a8-f4f7a924969a）：普通 primary 与 LPAC 的 RpcStringBindingCompose/RpcBindingFromStringBinding/RpcBindingFree/RpcStringFree 均返回 0；只使用本次 UUID 派生的固定 ncalrpc endpoint 名，不联系服务器、不解析服务端点或调用服务。LPAC CredRead 仍返回 1702，普通 primary 返回 1168，见 [完整 RPC 对照](evidence/windows-stage-a-2026-10-09-rpc-client-binding-profile.json)。因此本次通用字符串绑定创建不是失败点，不能据此证明 Credential Manager 服务端可达或访问被拒绝。恢复服务 e34b5cfa-6f93-472e-9ec7-be650e84f881 后[本次债务为空](evidence/windows-stage-a-2026-10-09-rpc-client-binding-recovered-profile.json)。48 项测试通过，生产仍 unavailable，既有两个 hive 债务保留。

同冻结映像/环境/私有桌面的 ordinary primary CredRead 对照已实机通过（UUID ce5e7582-b2c0-43de-b0c1-70e47e81d81b）：创建后暂停态核验 actual SID/non-AppContainer/non-elevated/baseline Job，才恢复固定 credential control；报告 UUID/SID/version/单一 outcome 与预算核验，退出 73。普通 primary 与 impersonation 均返回 1168，LPAC 仍返回 1702；[完整对照](evidence/windows-stage-a-2026-10-09-credential-primary-comparison-profile.json) 固定工作负载因此未通过。没有修改共享 RPC ACL 或 LPAC 能力。恢复服务 9d228c3d-1405-4cc5-ae46-7766ab1f4500 后[本次全部债务为空](evidence/windows-stage-a-2026-10-09-credential-primary-comparison-recovered-profile.json)，既有两个 hive 债务不变。47 项测试通过；下一步定位 LPAC RPC 初始化/本机端点边界，仍不能宣称 A1 或 A/B 完成。

CredRead 同账户 SDK 对照已实机运行（UUID 748d7423-a429-45af-86bc-b36b9c027815）：SYSTEM 原引用存在且正向读取成功；同一专用账户的精确普通 impersonation context 返回 ERROR_NOT_FOUND (1168)，LPAC primary 子进程仍返回 RPC_S_INVALID_BINDING (1702)，见 [完整对照](evidence/windows-stage-a-2026-10-09-credential-sdk-comparison-profile.json)。这排除了普通账户此 impersonation 形态的查询故障，但不能当成同进程环境普通 primary 对照，也不证明 LPAC credential 拒绝验收。固定恢复服务 b9be31a8-c63c-4224-ad08-8e8c8acc4006 后[本次债务为空](evidence/windows-stage-a-2026-10-09-credential-sdk-comparison-recovered-profile.json)，没有增加残留。46 项测试通过，普通对照拒绝无 thread Token 或 SID/引用不匹配；下一步需同冻结环境的 ordinary primary 比较及 LPAC RPC 边界定位。

固定 SYSTEM 自有凭据的 LPAC 负例已加入且强制检查不能缺失/重复/失败。实机 UUID 4a72c7ac-1408-4335-9316-975261604010：SYSTEM 写入/重读正向通过，LPAC CredRead 返回 RPC_S_INVALID_BINDING (1702)，未被计为凭据拒绝通过，workload_checks_passed=false，见 [负例](evidence/windows-stage-a-2026-10-09-system-credential-negative-profile.json)。没有扩大能力或共享 RPC ACL，也没有读取个人凭据；意外成功的自有返回缓冲区会清零释放。固定恢复服务 UUID 53014b7a-674d-4456-8d37-df9157d26c6e 随后[清空本次全部债务](evidence/windows-stage-a-2026-10-09-system-credential-negative-recovered-profile.json)，[服务结果](evidence/windows-stage-a-2026-10-09-system-credential-negative-recovery-result.json) error=null。46 项测试通过；凭据负例仍未验收，需区别 RPC 调用边界与真正的 credential-set 权限拒绝。既有两个 hive 债务不变。

专用账户到实际 SYSTEM controller 的六项危险句柄负例已实机通过（UUID 6ca68dfa-5532-4d7f-b584-212c357404d6）：完整工作负载检查通过，execution 四成员身份门禁通过、最终 active=0、夹具撤销通过，见 [工作负载回执](evidence/windows-stage-a-2026-10-09-system-handle-profile.json)。独立 SYSTEM 恢复服务 UUID 522e184b-c1ac-4188-a212-99e4998f6ede 随后完成凭据/profile/账户/过滤器精确退役，[最终回执](evidence/windows-stage-a-2026-10-09-system-handle-recovered-profile.json) 债务为空，[服务结果](evidence/windows-stage-a-2026-10-09-system-handle-recovery-result.json) error=null。本次未产生额外残留；既有两个崩溃 hive 债务不变。45 项测试通过，A1 的跨槽/凭据及实际 broker 边界仍未完成；核对表已同步，A/B 未完成。

A1 控制器句柄负例新增六项（VM_READ/VM_WRITE/VM_OPERATION/CREATE_THREAD/DUP_HANDLE/TERMINATE）：冻结当前 live controller PID 到固定环境，LPAC 仅尝试 OpenProcess 并关闭任何意外句柄，不执行内存读取、写入、注入、复制或终止；只有 ERROR_ACCESS_DENIED 通过，缺失进程不通过。共享宿主 LPAC controller 实机六项全拒绝，probe complete=true，树/ACL/profile 清理通过，[完整证据](evidence/windows-stage-a-2026-10-09-controller-handle-negative.json)。新增普通 controller 对自身相同六项权利的真实正向对照，45 项测试通过。该结果不替代专用账户 SYSTEM broker/跨槽/凭据负例，A1 仍未完成；两个加载 hive 债务仍保留。

恢复重新 logon 的短暂启用窗口新增持久化 `recovery_logon_pending`：先保存意图再启用账户，立即禁用并实际核验后才清除意图；下一次恢复先检查精确服务退役、冻结账户 SID/非管理员身份及全部四项 WFP，再恢复禁用状态。未恢复 quarantine 的回执不能继续资源退役；账号/过滤器已退役或缺乏 verified credential 的 pending 回执被拒绝。新增边界断言确认拒绝时回执不变，44 项测试通过。该崩溃窗口仍待故障注入实机验证，且不解决现有加载 hive 债务。

带凭据引用的运行中服务崩溃/新 SYSTEM profile API 恢复已实际比较（账户 UUID 4bb6655d-3b91-4088-b7f3-7db3e7005b0b，恢复服务 UUID 36781909-23d8-4ab0-8d90-a6228a97df4d）：重新读 SYSTEM 凭据、核验四项精确 SID WFP、短暂账户 logon 后立即禁用、实际 Token SID/冻结 profile 身份均通过。LoadUserProfile 与 UnloadUserProfile 返回成功，随后实际 hive 仍存在，故恢复拒绝后续文件/账户/过滤器退役；[API 结果](evidence/windows-stage-a-2026-10-09-system-credential-crash-recovery-result.json)、[债务回执](evidence/windows-stage-a-2026-10-09-system-credential-crash-recovered-profile.json) 已保存。不能把 API 成功当成卸载完成，也不能通过重复加载/卸载宣称崩溃债务已消失。SSPA4bb6655d3b91 与旧 SSPAba16502e566b 均保留禁用账户和 SID 网络封锁；两条自有服务均退出并退役。需进一步解决原 profile 加载句柄/生命周期所有权，而非放宽缺席门禁。44 项测试通过，缺少凭据引用的恢复在操作前拒绝且不改变回执。

SYSTEM 凭据引用已接入固定工作负载并实机通过（账户 UUID 4f6829d7-38cf-4150-b9d0-c4247c7162ae）：创建意图先持久化，Credential Manager 写入及原口令重读一致；回执仅保存引用。新增 `--prepare-owned-system-profile-recovery <精确 UUID>`，冻结独立恢复服务计划，拒绝自目标/nil/执行模式混用，检查受保护目标回执；服务以实际 SYSTEM 执行精确账户恢复，未开放任意命令/路径。恢复服务 UUID 052e39ae-c64c-4d38-8a9e-371c52e6a33a 退役后，[最终账户回执](evidence/windows-stage-a-2026-10-09-system-credential-recovered-profile.json) 证明 credential_removed/profile_removed/account_removed/filters_removed=true、债务为空；[恢复服务结果](evidence/windows-stage-a-2026-10-09-system-credential-recovery-result.json) error=null。44 项测试通过。该正常恢复正向结果不代表原 ba16502e 无凭据引用的崩溃实例恢复，也不证明加载 hive 的 profile API 重启恢复已通过。

新增 SYSTEM Credential Manager 引用模块：精确 UUID/规范账户 SID 派生目标，拒绝已有引用 adoption，实际 SYSTEM 主 Token 且无 thread impersonation 才允许 store/read/remove；读取/删除核对 target/账户/type/persistence/flags，UTF-16 秘密不提供 Debug/Serialize 并在释放时清零，Credential API 返回的 blob 在 CredFree 前清零。普通宿主拒绝和账户/目标替换回归通过，独立测试 43 项通过。模块尚未接入固定服务的 profile 恢复；SYSTEM vault 正向持久化仍待实机验证，旧 ba16502e 崩溃实例没有此引用，不能宣称其债务已恢复。

运行中 SYSTEM 服务崩溃已实际注入（UUID ba16502e-566b-4193-93d6-b6b34414ae68）：持久化时 execution 四成员存活、全部身份门禁通过，然后服务自身无析构退出 0xe8。外部 controller 确认服务进程退出并退役服务；[崩溃回执](evidence/windows-stage-a-2026-10-09-system-running-crash-profile.json) 与 [服务退役](evidence/windows-stage-a-2026-10-09-system-running-crash-service.json) 已保存。新进程恢复发现 Windows 仍保留专用账户 hive，因而拒绝撤销/账户/过滤器退役，债务未清空。普通 RegUnLoadKey 尝试 Win32 5，且该 API 文档面向 RegLoadKey hive，不适合作为 LoadUserProfile 恢复方案，实验代码已移除；[失败证据](evidence/windows-stage-a-2026-10-09-system-running-crash-recovery-final-error.txt) 保留。账户 SSPAba16502e566b 保持禁用与四项 SID 网络封锁，不能宣称本次恢复成功。下一步需恢复 profile API 所需凭据引用与生命周期上下文。固定 service-crash 模式与拒绝门禁回归通过，40 项测试及 Clippy 通过；A/B 仍未完成。

精确账户恢复现已接入文件撤销检查点：要求受保护 SYSTEM 工作负载计划已记录服务退役且 SCM 当前确认缺席、精确禁用账户无进程、hive 缺席、profile 为本次新建且有冻结身份、包 SID 与 UUID 派生值一致，再按 held root 卷号/文件 ID 撤销文件 ACE。独立 `controller_workload_files_retired` 不代表完整退役；须经原 profile 删除及 hive/ProfileList/目录实际缺席门禁，才标记完整夹具退役并继续账户/过滤器清理。未知 hive 或对象状态不强制卸载、不解封。新增检查点回归，40 项测试通过；运行中 SYSTEM 服务故障注入与恢复仍待实机验证。

文件 ACE 撤销已从 registry/profile 撤销拆开，为句柄丢失后的恢复提供独立步骤。专用账户正常撤销现在将受保护回执的卷号/文件 ID 传入撤销操作，在持有根句柄之后、任何 ACL 修改之前再次核对实际身份，关闭此前路径检查到重新打开之间的根替换窗口。身份不匹配回归通过，独立测试 39 项通过。此基础尚未接入服务崩溃后的完整恢复状态机。

撤销前后复核完整目录清单，发现新增/缺失对象时保留债务；新增真实目录回归，独立测试 38 项通过。共享 LPAC controller 网络工作负载实机复跑通过：probe complete=true、检查无失败、receiver quietness=true、process_tree_stopped=true、fixture_acls_revoked=true、profile_removed=true、error=null，见 [句柄撤销复跑](evidence/windows-stage-a-2026-10-09-retirement-leases.json)。该结果只证明共享宿主候选正常路径，不替代专用账户服务崩溃恢复。

撤销包 ACE 及最终 DACL 复查改为 GetSecurityInfo/SetSecurityInfo 操作全部持有的文件句柄，遍历租约持续到撤销核验结束。真实回归发现 metadata-only open 无法阻止重命名，改为明确 FILE_READ_DATA/FILE_LIST_DIRECTORY + FILE_SHARE_READ 后，写入与重命名均拒绝，释放后恢复。37 项测试通过；尚不能替代祖先路径、并发增量对象与完整服务崩溃恢复验收。

夹具撤销前增加实际文件句柄属性核验：在全部遍历完成且尚未修改 ACL 时拒绝 reparse 对象和多链接普通文件，避免直接对已存在的外部硬链接别名修改包权限。外部硬链接回归使用真实 NTFS 对象，36 项测试通过。此检查仍不证明并发路径替换安全，后续恢复需保留稳定句柄和对象身份绑定。

精确 UUID 恢复失败现在会持久化本次恢复标志、已完成的部分清理状态和去重后的剩余债务；回执写入失败同时报告原清理错误与持久化错误，不宣称恢复成功。新增重复失败保留既有债务的回归测试，独立原型 35 项测试通过。此改动不代表运行中服务崩溃恢复已验收。

最新专用账户正常、超时、固定取消、执行根异常四条路径均已实际通过：超时/取消时四成员存活，根异常退出码 0xe7 后三成员存活；各条全四成员身份门禁通过，最终 execution total=4/active=0，源基线树独立停止。服务退役后，各精确 UUID 恢复均清空夹具/profile/namespace/账户/四过滤器债务。见 [超时](evidence/windows-stage-a-2026-10-09-system-timeout-profile.json)、[取消](evidence/windows-stage-a-2026-10-09-system-cancel-profile.json)、[根异常](evidence/windows-stage-a-2026-10-09-system-root-failure-profile.json) 与 [普通复跑](evidence/windows-stage-a-2026-10-09-system-lifecycle-normal-profile.json)。中断实验工作负载 complete=false，不替代正常网络验收。34 项测试、Clippy、构建通过。服务/宿主运行中崩溃与重启、重复取消、并发、breakaway、跨槽负例、完整默认模式及完整 B 仍未完成。

最新专用账户执行树已完整捕获四个实际成员（root/leaf 两个固定 probe、两个 System32 conhost）：每个均通过 actual 用户/package/唯一 capability/Low IL/LPAC/精确 Job/映像核验。普通源/创建对照另归 baseline Job，两成员停止；execution 最终 total=4、active=0 与身份快照一致。34 项固定工作负载再次通过；[最终成员证据](evidence/windows-stage-a-2026-10-09-system-job-observer-final-profile.json) 与 [精确恢复](evidence/windows-stage-a-2026-10-09-system-job-observer-final-recovery.json) 证明全部资源债务为空。32 项测试、Clippy 与构建通过，共享 observer 宿主实机复跑亦通过。跨宿主/broker/槽位句柄负例、默认模式及专用账户生命周期扩大矩阵仍待完成，A/B 未完成。

最新 SYSTEM 专用账户固定工作负载已实际通过 34 项：13 项文件/产物、2 项私有注册表拒绝、后代身份/LPAC/Job/退出、3 项 Winsock registry 与初始化、v4/v6 TCP/UDP API 及四个外部 controller 接收端零计数。源账户文件/注册表正向对照先通过。最终 UUID 11229a0d-9d3e-4f98-88bd-07a519656c3d，[工作负载](evidence/windows-stage-a-2026-10-09-system-workload-final-profile.json) 根退出 73、全部检查通过、六成员 Job 停止、夹具身份核对与包 ACE/私有 key 撤销通过；服务退役后 [精确恢复](evidence/windows-stage-a-2026-10-09-system-workload-final-recovery.json) 清空账户/profile/namespace/过滤器债务。共享 probe 的宿主候选亦实机复跑通过。完整 helper 身份与默认 readOnly/workspace/ACL/扩大网络/生命周期矩阵仍未完成，account_lpac_verified=false、生产 unavailable。独立测试现 32 项。

**最新启动突破**：同一 SYSTEM 服务内，LPAC CreateProcessAsUserW 在 controller context 返回 2，在精确专用账户 impersonation context 成功。actual 用户/package/唯一 capability/Low IL/LPAC 行为均通过，固定 cmd 退出码 73。见 [完整启动对照](evidence/windows-stage-a-2026-10-09-system-target-context-profile.json)。创建树停止、服务退出并删除后，[精确恢复](evidence/windows-stage-a-2026-10-09-system-target-context-recovery.json) 清空所有账户/profile/namespace/过滤器债务。当前只通过 admission，不是文件/网络/helper/生命周期或 A/B 完成；下一步将完整固定验收工作负载接到这条创建路径。独立测试现 31 项。

最新一次性 SYSTEM 服务已实机运行：actual LocalSystem Token 持有 assign-primary/increase-quota，同专用账户普通暂停创建成功，LPAC 比较仍 Win32 2。见 [账户对照](evidence/windows-stage-a-2026-10-09-system-service-profile.json)、[服务退役](evidence/windows-stage-a-2026-10-09-system-service-protected.json) 和 [账户精确恢复](evidence/windows-stage-a-2026-10-09-system-service-profile-recovery.json)。全部拥有资源债务为空。仅固定诊断服务，完整 broker/IPC/账户池未实施；独立测试现 30 项。

最新只读权限核验确认提升控制器 Token 缺少 SeAssignPrimaryTokenPrivilege，increase-quota 存在且创建时临时启用；普通 SDK 基线仍为 1314。见 [实际权限](evidence/windows-stage-a-2026-10-09-controller-privileges.json)；本次恢复债务为空，独立测试现 26 项通过。受控 SYSTEM 基线尚未实施，LPAC 错误 2 仍未定位。

同 Token、桌面、映像和环境的普通 CreateProcessAsUserW 对照返回 Win32 1314，当前提升控制器尚无普通创建成功基线；LPAC 比较仍为 Win32 2。下一步核验创建端权限并建立受控 SYSTEM 基线。见 [普通对照](evidence/windows-stage-a-2026-10-09-controller-ordinary-control.json)；本次精确恢复已清空债务。

最新 SDK 参数核对发现并修正 CreateProcessAsUserW 的环境块参数位置错误：环境指针此前误传到进程安全属性参数。修正后实机仍返回 Win32 2，因此未解决 LPAC 启动；此前显式环境/HKCU 对照不能用于排除对应原因。见 [修正后结果](evidence/windows-stage-a-2026-10-09-controller-lpac-argument-fix.json) 和 [精确恢复](evidence/windows-stage-a-2026-10-09-controller-lpac-argument-fix-recovery.json)。本次账户、profile、namespace、四项过滤器均已退役，债务为空。

阶段 A 未完成，阶段 B 未完整实施，生产门禁仍为 unavailable。原专用账户单 restricting SID 启动路径受 KnownDlls 权限边界阻断，不能通过改共享对象 ACL 或放宽 restricting SID 修复。普通宿主用户下 LPAC + 唯一 registryRead 的固定候选已通过文件、私有注册表、四项回环网络、根/后代/console helper 完整身份和正常/超时/取消/执行根异常退出的有限实机检查；这些结果不等于专用账户完整默认路径验收。

最新 controller 接收端证据：[LPAC controller 网络结果](evidence/windows-stage-a-2026-10-09-lpac-controller-network-final.json)。网络正向对照与实际接收计数由同一个 controller 的克隆 socket 完成；低权限入口只获得冻结回环端点，不持有接收 socket。受保护账户计划 reader 与固定专用账户入口已接线；工作区普通文件不能成为设置计划，实际负例见 [拒绝记录](evidence/windows-stage-a-2026-10-09-account-plan-rejection.txt)。专用账户 Windows profile 加载/卸载、私有 station/desktop 精确 DACL、同名 station 拒绝与资源退役已通过固定实机诊断。设置控制器在卸载 profile 后直接异常退出，受保护回执记录待清理债务；新进程按精确 UUID 恢复后 profile、账户与四项持久过滤器均不存在，债务清空，见 [中断](evidence/windows-stage-a-2026-10-09-account-profile-controller-crash-final.json) 和 [恢复](evidence/windows-stage-a-2026-10-09-account-profile-controller-recovered-final.json)。故障点没有运行 LPAC 命令，专用账户组合已实际运行：普通 bootstrap 的 SID/非管理员身份与受保护计划通过，LPAC 子进程创建返回 Win32 5；显式私有桌面与实际 Low/NW 标签未解决创建失败。最终证据见 [组合结果](evidence/windows-stage-a-2026-10-09-dedicated-account-lpac-final.json)，外层两成员树停止，profile/账户/过滤器退役，债务为空。LPAC 行为和运行中崩溃恢复仍未验收。

验收范围与剩余要求：[阶段 A/B 完成核对表](agent-shell-sandbox-windows-ab-checklist.md)。独立原型当前 25 项测试、Clippy 与构建通过；controller 分离后正常文件/网络、超时、取消、执行根故障四条实际路径复跑均通过清理核验。阶段 A/B 要求不能以这些有限结果替代。

## 本次改动

新增 `tests/windows-sandbox-account/` 独立 Windows Rust crate、锁文件、运行脚本与说明。
未引用 PSEC/minifilter，未修改生产 Rust/TS/IPC/UI，生产 `verified()` 仍为 false。
新目录独立忽略 target，未手改现有依赖或生成文件，未 commit/tag/push。
修改设计仅记录本次原型结果和验证方案修正。原有大量未提交文件均保留。

实现了普通账户、单一 call restricting SID、DISABLE_MAX_PRIVILEGE、增量非继承 ACE、
NTFS/固定卷/祖先 reparse 拒绝、受保护自有 fixture、四层持久账户 SID ALE block、
WFP 事务、内存一次性凭据、调用拥有回执与正常失败清理。默认入口无系统副作用。
明确设置开关 `run.ps1 -RunOwnedFixture` 使用 RunAs/UAC，构建本身不提权。

检查 readOnly/workspace 的普通文件、外部 fixture、现有 .env.secret、根 .env.local、
.git、敏感对象 DELETE/WRITE_DAC、祖先 DELETE、父目录 DELETE_CHILD、构建产物创建重开。
这些文件检查在专用账户受限 Token impersonation 下执行，不能冒充完整进程验收。
网络使用自有 IPv4/IPv6 回环 TCP/UDP 接收端，并先做宿主正对照；同时记录 API 和接收端。

## 实机与测试证据

- `cargo test --locked --manifest-path tests/windows-sandbox-account/Cargo.toml`：2/2 通过，无忽略项。
  一项为权限掩码约束；另一项真实调用 Windows CreateRestrictedToken/AccessCheck，证明普通 SID
  与 restricting SID 必须双重允许、Everyone 不足以通过、显式 deny 有效。
- `cargo clippy --locked --manifest-path tests/windows-sandbox-account/Cargo.toml --all-targets -- -D warnings`：通过。
- 独立 crate 构建通过。默认实机入口退出 2：当前为 medium Token，未提升，不改系统。
- UAC 设置入口实际运行，退出 2。**27/32 通过，5 项失败**，不是跳过或 mock。
  原始脱敏结果：[JSON 回执副本](evidence/windows-stage-a-2026-10-07.json)。

失败项目：workspace 构建产物创建/重开；IPv4/IPv6 的回环 TCP 和 UDP 各一项。
TCP API 实际连接成功且接收端观察到连接；UDP Send 成功且接收端收到包。
不能以“有规则”或“API Send 行为”宣称网络已阻断。

## 设计调整与具体阻塞

1. 非继承 ACE 只证明现有对象访问，新对象权限尚未成立。构建检查使用真实创建并重开，
   当前失败记录未进一步区分创建与重开错误。下一轮必须分离错误码并验证父级继承与
   Token default DACL，设计可逐对象追踪/撤销的权限传播；不得放宽 restricting SID。
2. 网络 sockets 来自宿主主 Token 进程中的 impersonation 线程。因此接收端反例否定了
   该验证形态，不能当成专用账户 primary Token 的完整网络判定。必须实现真实受限主 Token
   子进程与身份查询后再验证 WFP，不能以 impersonation 代替命令运行。
3. 尚无私有桌面、PowerShell/Git/Node 最小启动权限、根/后代受限身份、宿主/broker/其他槽
   句柄反例、私网/入站/DNS/COM/RPC 服务代办、hardlink/ADS/短名称/链接竞争的证据。
4. 尚未实现完整敏感快照扫描/预算/次次派发刷新、已知宿主 HOME/钥匙串/存储对象矩阵。
   external.txt 是自有外部拒绝 fixture，不能代表宿主所有敏感对象。
5. 目前账户只在同一进程内一次性使用，密码未落盘。尚不是阶段 B 的受保护 credential reference、
   账户池、身份验证管道或 crash-safe object-identity journal。回执只是自有 fixture 实验入口。

上述不足阻止阶段 A 验收，不能把后续 B/C/D 的实现当作补齐 A 证据的理由。

## 本机拥有资源与清理

本次 fixture：`C:\ProgramData\ShellSpan-stage-A-c15557a4-e498-429c-892b-ca883fc0770b`。
原回执：该目录 `ownership.json`。账户：`SSPAc15557a4e498`，SID 与四个过滤器 GUID 见 JSON。
未创建任何沙箱 child/process Job 或服务；没有待证明终止的受限子进程。

回执 `cleanup_debt=[]`：正常流程禁用/删除自有账户、逐 SID 增量撤销 fixture ACE、
删除四个确切 WFP 过滤器均未返回错误。之后 `Get-LocalUser -Name SSPAc15557a4e498` 未找到账户。
WFP 证据是删除 API 返回成功，未追加独立过滤器枚举或重启核查；不得外推为 crash/reboot 恢复通过。

fixture 保留是明确的证据保留债务，未直接删除文件。为了普通宿主读取原始回执，另经 RunAs/UAC
对**该确切 ownership.json** 添加当前宿主 SID 的 Read ACE；它不授予实验账户或 restricting SID。
首次未提升 Get-Content/Get-Acl 尝试均被拒绝；该读取辅助只针对本次自有回执。
回执副本已保存仓库，无密码、Token/Job 句柄或秘密内容。

验收审阅后，通过项目回收站机制退役这一确切 fixture；不要按名称前缀批量删除任何资源。
当前代码在崩溃/激活窗口/ACL 对象替换/回执写入失败时仍可能留下清理债务，README 已列出限制。
不应无人值守重复运行或在企业策略冲突时放松配置。必要时管理员按受保护回执核对精确账户 SID、
过滤器键与对象后恢复；不能依据 PID、名称前缀或历史记录认领资源。

## 串行后续

**不创建阶段 B 会话。** 下一步仍是阶段 A：解决新对象权限、实现并验证真实 primary Token
子进程，然后补齐本阶段文件/敏感对象/网络负例。A 真正验收通过后才 list_projects/create_thread，
在 ShellSpan 本地项目创建 B，并传递设计、最新交接路径、前序会话 ID 和 A→B→C→D 串行要求；
不得并发修改此工作区。B/C/D 继续保持 unavailable，D 全部必要证据通过后最多 partial。
