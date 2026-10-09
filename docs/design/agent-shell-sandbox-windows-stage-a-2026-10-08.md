# Windows sandbox 阶段 A 续作记录

日期：2026-10-08（Asia/Shanghai）。**仍为 NO-GO；生产 unavailable；不启动 B。**
此前记录：[2026-10-07 交接](agent-shell-sandbox-windows-stage-a-handoff.md)。

## 最新续作：两阶段启动与运行库例外

### 2026-10-09：文件矩阵及接收端验证

候选新增两个显式实验入口 `--run-file-network` 与 `--run-lpac-file-network`，只启动复制到新自有 fixture 的固定探针，不接受用户命令。fixture 位于当前用户 Temp 下，UUID 根目录从创建时受保护；非秘密测试文件的普通用户读/写正控制均验证后才启动。普通用户/SYSTEM 权限保持在自有根和 output 的继承链，package SID 仅给明确允许对象。新增产物创建/关闭、读重开、实际写重开；secret、external 及 AllApplicationPackages 外部反例均真实打开/写入。fixture 保留，不直接删除；只有本次新建 OS profile 用其生命周期 API 退役。

普通 AppContainer 可以读取带 AllApplicationPackages 读取 ACE 的外部对象，**不符合当前外部读取拒绝契约**。[修正监听后的普通候选证据](evidence/windows-stage-a-2026-10-09-appcontainer-verified-receivers.json)保留该失败；它的 TCP API 返回成功、UDP send 也返回成功，而经克隆监听线程正控制的接收端未观察到数据。只能报告本轮具体结果，不能把“零 capability”或“不见接收数据”概括为所有网络已阻断。尚未加入专用账户 WFP、私网/公网、入站或 DNS/服务代办验证。

LPAC 使用独立 opt-out 启动属性，不扩大读取 capability。Win32 class-46 的尺寸探测没有返回可用长度，该实验未据此猜测 Token 属性；改用实际 AppContainer Token 的 AccessCheck，先验证唯一 package SID 正控制，再验证 AllApplicationPackages 无效，并以真实文件反例交叉核验。[最终带普通用户文件正控制的 LPAC 回执](evidence/windows-stage-a-2026-10-09-lpac-host-control-final.json)：**13 项文件检查通过**，包括只读文件写拒绝、workspace 读/实际写、secret/external 读写拒绝、AllApplicationPackages 外部读写拒绝和产物创建/重开。精确 package 身份、Low IL 与 capability 空检查通过。

但 LPAC 在 Rust Winsock 初始化处遇 **10107** 并以 101 退出。报告 `complete=false`，只有文件阶段完成；四项接收端未收到流量不能证明网络探针已执行，**网络验收仍未通过**。固定探针的 panic 诊断只保存有界错误信息，不转储环境或 Token。下一步应定位 Winsock 初始化所需的具体资源；不可直接增加宽泛 registry/network capability 后宣称契约保持，也不能用初始化失败代替网络阻断证明。

本轮还修复并保留了两类验证设施故障：新文件漏继承宿主报告读取权限；克隆 socket 未显式设 nonblocking 导致监控线程退出等待。后者两轮通过向确切自有接收端发送唤醒流量完成清理，**这些网络结果作废**，见[恢复说明](evidence/windows-stage-a-2026-10-09-receiver-recovery-note.json)。当前每个克隆线程均显式非阻塞，且在子进程暂停时先证明线程能收到 TCP/UDP 正控制、排空计数；子进程成功 TCP 句柄保留至观察窗口结束，防止只观测短连接关闭后的队列。

曾有一次 ACL 撤销已验证，但 root 丢失宿主继承导致 ownership.json 更新失败，因此原型保留 profile。已对确切自有根修复宿主继承、独立核验全部 package allow ACE 不存在，再退役确切 profile；[恢复证据](evidence/windows-stage-a-2026-10-09-lpac-exact-retirement.json)保留原始失败。最终版本在新 fixture 的根和 output 保留宿主继承，并检查普通用户文件正控制，ACL 撤销后更新 ownership.json 成功。最新进程树停止、profile 退役及 package ACE 清理均确认；[生命周期汇总](evidence/windows-stage-a-2026-10-09-candidate-lifecycle-final.json)无未解决债务。所有新 fixture 路径详见汇总，仍待证据审阅后用回收站退役。该候选还没有可信崩溃恢复入口，Temp 回执不是恢复授权。

新增两项回归：缺失文件不能当作权限拒绝；同一克隆监听线程能捕获 IPv4/IPv6 TCP/UDP 并在无流量时退出。独立 crate 合计 **10 项测试通过**，build、clippy、fmt check 通过；生产未改，仍 unavailable。

LPAC 语义依据：[Microsoft TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/windows/win32/api/winnt/ne-winnt-token_information_class)。部分单 SID 原型和此前仅启动证明保留为历史记录，不合并其通过数。

### 独立替代候选：零 capability AppContainer

本地 deepseek-harness 的 `packages/sandbox/sandbox-windows-acl/README.md` 明确采用 WRITE_RESTRICTED，只限制写入，读取及网络不在其边界内。因此不能作为当前项目外读取拒绝的替代。Microsoft 对 WRITE_RESTRICTED 的说明与此一致。未改用该 flag，未安装 SYSTEM 服务，未接管 KnownDlls owner。

新增独立 `shellspan-appcontainer-candidate` 可执行文件；它不接入旧 fixture launcher 或生产，不接受任意命令/路径，必须显式 `--run-owned-profile` 才运行。只从未提权的当前用户创建随机且最初为空的 AppContainer profile，capability 数量为零；固定执行 System32/cmd.exe `/d /c exit 73`。暂停创建后绑定 kill-on-close Job，查询实际 TokenIsAppContainer、精确 package SID、同源 TokenUser、Low Integrity Level、TokenCapabilities 空，全部通过后才 Resume。

[最终实机回执](evidence/windows-stage-a-2026-10-08-appcontainer-final.json)：所有上述身份检查通过，固定程序正常返回 **73**，证明这条候选路径成功初始化并进入程序主流程；稳定句柄确认进程树停止后，用 DeleteAppContainerProfile 退役本次新建空 OS profile，API 成功。没有修改系统 DLL/共享对象 ACL、添加网络 capability、建立回环豁免、安装服务或创建专用账户/WFP 规则。首次显式空环境及仅 SystemRoot/WINDIR 环境均遇 203；追加仅 USERPROFILE/LOCALAPPDATA 目录定位变量后创建成功，不复制宿主完整环境或凭据。前序失败及[所有本轮 profile 生命周期摘要](evidence/windows-stage-a-2026-10-08-appcontainer-lifecycle.json)均保留证据，进程停止与 profile 退役无未解决债务。临时 JSON 回执保留，尚未通过重启/断电恢复验收。

这只证明当前用户下的候选启动路径，不证明专用账户组合、项目外/敏感文件拒绝、workspace 创建/重开、后代继承、私有桌面、真实 TCP/UDP 阻断或服务代办。没有 capability 不能代替接收端验证。普通 AppContainer 也允许一部分系统共享资源；外部对象的 AllApplicationPackages ACE、AppContainer 默认私有存储及 Low Integrity 写入行为必须纳入边界验收。LPAC 可作为更严格候选，但本轮未启动、未验证，不能混称已通过。

后续实验顺序：先验证候选的 readOnly/workspace 文件矩阵，包含 AllApplicationPackages 外部反例；再做固定子进程的 IPv4/IPv6 TCP/UDP 接收端检查，随后后代/私有桌面及恢复。若普通 AppContainer 无法满足明确允许范围，则评估 LPAC 或拒绝该候选。既有单 restricting SID 原型仍保持 NO-GO，没有自动降级或更改生产设计；只有独立矩阵通过才评审替代实现。

验证：独立 crate 8 项既有回归通过，新增候选的实际启动/Token/清理检查通过；build、clippy `-D warnings`、fmt check 通过。候选不计入旧阶段 A 的通过数，生产仍 unavailable。

官方依据：[CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)、[AppContainer/LPAC 启动及权限模型](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。

### 后续命名对象诊断与启动门禁

**最新结果：UAC setup 本身没有所需对象修改权。**
首先仅请求句柄、不执行修改的[独立准入检查](evidence/windows-stage-a-2026-10-08-known-dll-admission.json)发现三个对象的 READ_CONTROL|WRITE_DAC 都返回 0xc0000022。随后将同样的固定对象检查纳入原型：[最终结构化报告](evidence/windows-stage-a-2026-10-08-setup-admission-final.json)记录 elevated=true，三个 READ_CONTROL 均成功，而 READ_CONTROL|WRITE_DAC 均拒绝。没有写入对象 ACL、接管 owner 或授予新系统权限。

新增 `--diagnose-loader-acl` 只读 JSON 入口；其退出 0 仅表示完成诊断，不能覆盖报告中的 passed=false 或 production=unavailable。未知参数仍拒绝。preflight 与实际 fixture 入口现在都先检查 setup 修改权；失败发生在账户/目录/WFP 创建之前。[入口失败诊断](evidence/windows-stage-a-2026-10-08-setup-gate-result.txt)及[前后资源盘点](evidence/windows-stage-a-2026-10-08-setup-gate-inventory.json)确认 exit=2，fixture 19→19，实验账户 0→0。未新增本轮 fixture 或清理债务。

这将问题从文件路径 ACL 修复推进为**当前启动方案的可行性限制**：单调用 restricting SID 在共享 loader 对象上没有访问权，当前 UAC 管理入口又不能修改其 ACL。不能继续扩大 DLL 清单、加入 RESTRICTED/Everyone 等宽泛 restricting SID，或安装未经设计/验收的更高权限服务。也不能仅据 WRITE_DAC 拒绝推断具体 owner、保护机制，或宣称 SYSTEM 路径必然成功。下一步应评审保持文件白名单与 network=deny 契约的启动替代方案，再做独立原型；当前阶段 A 继续 NO-GO，生产 unavailable。

新增只读 NtOpenDirectoryObject/NtOpenSection 诊断，在同一个专用账户的普通 Token 与受限 Token 下分别实际打开固定对象。三项普通身份均返回 NTSTATUS 0，受限身份均返回 **0xc0000022**：`\KnownDlls`（DIRECTORY_QUERY）、`\KnownDlls\ntdll.dll` 与 `\KnownDlls\kernel32.dll`（SECTION_MAP_READ | SECTION_MAP_EXECUTE）。这些命名对象不同于磁盘 DLL，文件 ACL 放行不能推定其可访问。该结果证实具体对象访问失败，但不证明它是 loader 失败的唯一原因。

回执：[首次诊断](evidence/windows-stage-a-2026-10-08-known-dlls.json)、[禁用固定 runner 严重错误弹框后的诊断](evidence/windows-stage-a-2026-10-08-known-dlls-final.json)。前者子进程超时、后者明确 loader 退出 0xc0000022；两轮均确认进程树终止，22 DLL ACE 已撤销，cleanup_debt 空。错误模式仅设于固定 runner 并由其子进程继承，不改变桌面应用或系统配置。

最新入口先进行该只读门禁，再考虑 DLL ACL 变更及子进程启动。[实机门禁回执](evidence/windows-stage-a-2026-10-08-loader-gate.json)拒绝三个对象，未添加 runtime ACE、未启动子进程，正常清理无债务。本轮三个确切账户枚举结果为空；保留 fixture UUID 为 6d2d23b5-61cd-4113-873d-03622093f5be、cad6f7e3-fd9f-44d3-aa87-58f35c775020、521fa742-df54-4701-86bf-0d475083e7f2。

新增真实对象正控制/受限拒绝/对象不存在区别回归，独立 crate 共 8 项测试通过，build、clippy 与 fmt 检查通过。仅增加 windows-sys 的用户态 ntdll API 绑定 feature，不安装驱动，不改变共享命名对象 ACL，不加入宽泛 restricting SID。

下一步需明确共享系统命名对象的最小允许范围和逐对象授权/撤销/恢复机制，才能评估有界修复并验证 loader 是否恢复。当前目录对象检查仅要求 QUERY，未来 loader 的实际要求还需追踪，不能把这个诊断掩码直接作为完整授权清单。禁止采用 Everyone/RESTRICTED 等额外 restricting SID 来跳过单 SID 契约，也不能把磁盘 DLL 白名单扩大当成已解决。

API 依据：[NtOpenDirectoryObject](https://learn.microsoft.com/en-us/windows/win32/devnotes/ntopendirectoryobject)、[用户态 NtOpenSection](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwopensection)、[SetErrorMode 与子进程继承](https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-seterrormode)。

以下是本日后续结果；后文的 1314/87 与 33/38 属于早期快照。

新增独立固定 runner，普通专用账户通过 CreateProcessWithLogonW 进入新建非交互私有 station/desktop，再从自己的 primary Token 派生确切单 restricting SID Token。账户仅加入本地化的内置 Users 组；密码仅在内存中，配置不接受任意命令或外部网络目的地。实际身份、组和私有桌面均查询真实对象，不从配置推断。未修改 WinSta0/Default。

修复源 Token 句柄遗漏 TOKEN_ASSIGN_PRIMARY/TOKEN_ADJUST_DEFAULT：受限 primary 现在可暂停创建，实际账户、非提权、无启用管理员组、确切 restricting SID、危险 privileges 关闭及 Job 绑定均通过。设置的默认 DACL 仅授权 SYSTEM、专用账户与该 restricting SID。恢复后仍以 **0xc0000022** 退出，固定探针没有初始化，因此四项真实子进程 TCP/UDP 网络阻断尚未执行，不能算通过。移除了原来无法证明子进程网络的 impersonation socket 检查。

系统启动例外限定为 System32 的 22 个固定 DLL（含 PE 导入表实际引用的 vcruntime140.dll），仅对 restricting SID 增加不继承的读/执行 ACE。未改目录 ACL，避免 SetSecurityInfo 传播已有可继承 ACE；拒绝目录/reparse 对象。仅临时启用 setup Token 已有的 SeRestorePrivilege，退出恢复原状态；不接管 owner，不授予账户系统特权。每次修改前保存路径、卷号、文件 ID 和 planned 状态；撤销合并当前 ACL，只移除自己的 SID。kernel32.dll 实际读取通过，但这不足以证明完整 loader 权限。尚未定位 loader 拒绝的具体对象，不自动扩大授权清单。

Job 清理捕获并等待稳定的根与成员进程句柄，PID 只用于找到并核验成员。无法确认全树停止时保留 ACL、禁用账户与 WFP。新增确切 UUID 恢复入口：验证受保护回执、账户 SID、实际进程不存在、四个过滤器身份/条件、runtime 文件身份，再增量撤销并独立确认账户及规则不存在。拒绝可由普通用户写入的回执、对象替换和未归属资源。

实机证据：

- [Users 与私有桌面](evidence/windows-stage-a-2026-10-08-users-runner.json)：45/47，受限 image 可读，kernel32 读取及启动失败。
- [最初 runtime 句柄尝试](evidence/windows-stage-a-2026-10-08-runtime-grants.json)：共享冲突 32，无系统 ACL 修改。
- [固定 DLL 读取](evidence/windows-stage-a-2026-10-08-runtime-files.json)：21 项例外已撤销，启动仍 5；其中继承自早期 runner 的“no system ACL changes”诊断文字不准确，实际变更以 runtime_grants 为准，已修正源码。
- [暂停 primary 与 loader](evidence/windows-stage-a-2026-10-08-primary-access.json)：身份/Job 通过，loader 0xc0000022，21 项例外撤销，无清理债务。
- [22 DLL 最新尝试](evidence/windows-stage-a-2026-10-08-runner-network.json)：loader 仍失败，进程树确认失败触发保护保留；[确切恢复后回执](evidence/windows-stage-a-2026-10-08-runtime-recovered.json)确认 22 项例外已撤销、账户与四条规则不存在，cleanup_debt 空。原始失败检查保留。

两次早期清理债务也已执行确切恢复：[首次两阶段恢复](evidence/windows-stage-a-2026-10-08-recovered.json)、[最小 runner 恢复](evidence/windows-stage-a-2026-10-08-minimal-recovered.json)。这些是故障后的实机恢复证据，不等于任意崩溃/断电/重启均安全。

本次新增保留 fixture UUID：f816a05e-bbd6-4a39-842b-72958382421c、ec6dae68-a30d-4b63-8584-f05a2b05c01b、3fd8658e-66cd-4668-9644-a37db9b0f621、7a88ee12-a6ea-455d-a8ee-55ff3a780289、2d03794b-0469-4a1a-b125-59c907edfd91、2bf04c02-bffb-4f23-97be-b2fea811a070、a3c914fd-50bd-4709-a071-7e076fb9d641、ef6de63b-4deb-4b1d-b089-993ac315d338、7ea3d493-0fdb-41b5-aa07-0512d1d15e57、57b34a9c-e95f-4165-86ef-f71f912fa159。确切目录均为 ProgramData/ShellSpan-stage-A-UUID，保留审阅，不直接删除。

下一步：定位 loader 拒绝对象并添加有界回归，成功初始化后执行真实 IPv4/IPv6 TCP/UDP 接收端核查；继续覆盖服务代办/DNS、入站/私网、后代/敏感句柄、对象别名与敏感快照、重启恢复。生产仍 unavailable，不启动 B。

最终代码验证：独立 crate 7 项测试通过，build、clippy `-D warnings`、fmt check 与 git diff whitespace check 通过。未修改生产后端、TS、IPC/UI，未运行生产全仓回归，未 commit/tag/push。

机制参考：[OpenAI Windows sandbox 文章](https://openai.com/index/building-codex-windows-sandbox/)、[SetSecurityInfo 传播语义](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)。

## 已完成的子项

自有 fixture 的 `project/output` 从非继承 ACE 改为普通账户 SID 与调用 restricting SID 的可继承 ACE，仅覆盖该最初为空的产物目录，不向项目根、敏感目录或规则目录传播写权限。原 owner/DACL 保留，权限不包含 DELETE_CHILD、WRITE_DAC 或 WRITE_OWNER。

真实检查拆分为创建/写入/关闭、读重开、写重开、创建子目录、嵌套文件创建/写入/关闭与读重开，分别保存结果和 Win32 错误码。六项均通过；readOnly 创建被拒，原有敏感文件/.env.local/.git/外部对象的检查仍通过。

清理时在撤销父目录专属 ACE 后，读取三个真实新对象的 DACL，核对账户 SID 和 restricting SID 无遗留 allow ACE。检查错误或遗留均记录 cleanup_debt，保留账户及网络保护。该方案仅证明自有产物目录，不证明任意真实项目的新文件工作流或敏感快照传播。

## primary Token 启动仍未通过

增加固定自有 `runner.exe` 的暂停启动探针：显式空环境、不继承句柄、创建 kill-on-close Job、绑定根进程、查询实际账户 SID/受限状态及 Job 成员关系，最后终止并等待稳定进程句柄。线程不 Resume；私有桌面、loader、网络及后代尚未验证。无法确认终止时不撤销 ACL 或网络保护。

本机 UAC 管理员入口调用 `CreateProcessAsUserW` 实际返回 **1314**。因此未创建根进程，身份/Job/终止检查未执行，不能算通过。Windows 对该 API 的特权要求见 [Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)。本轮未增加系统登录权、安装服务或使用未受限 Token 替代。

两个中间实验使用同一个受限 Token 的 `CreateProcessWithTokenW`，均返回 **87**；去除 CREATE_NO_WINDOW 后仍失败。最终代码恢复为 CreateProcessAsUserW 单一路径，无自动替代启动。该 API 在默认桌面参数下可能自动增补账户访问权限，参见 [Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithtokenw)；额外只读检查 WinSta0 和 Default 的 DACL，未发现这两次实验的确切账户 SID ACE。该检查不代表私有桌面已实现。

下一项是解决专用账户 primary Token 的可信启动权限和私有桌面，再执行真实进程网络检查。当前四项 impersonation 回环 TCP/UDP 仍实际连通，不能称为网络阻断成功。

## 验证与回执

- 独立 crate 的两项原有真实 Token/权限测试通过；新增的产物回归在 UAC 自有 fixture 实机执行。
- 独立 crate build、clippy `-D warnings` 与 fmt 检查通过。未更改生产 Rust、TS、IPC 或 UI；未重跑生产全仓回归。
- 最终实机：**33/38 通过，5 项失败**（primary 启动 1314 与四项旧形态网络检查）；cleanup_debt 为空。失败和未执行子项不算通过。
- [产物修复回执](evidence/windows-stage-a-2026-10-08.json)、[primary 1314 回执](evidence/windows-stage-a-2026-10-08-primary.json)、[中间 87 回执](evidence/windows-stage-a-2026-10-08-primary-token.json)、[去除启动标志后的 87 回执](evidence/windows-stage-a-2026-10-08-primary-final.json)、[最终清理核查回执](evidence/windows-stage-a-2026-10-08-cleanup.json)、[桌面只读核查](evidence/windows-stage-a-2026-10-08-desktop-audit.json)。

五个自有 fixture 均保留证据，不直接删除文件；回执记录正常账户/ACL/WFP 清理无错误，另枚举本地账户确认五个确切账户均不存在。WFP 尚未做独立过滤器枚举或重启核查。审阅后仍需通过项目回收站退役以下确切目录，不能按前缀批量清理：

| ProgramData 下的目录 | 实验 |
| --- | --- |
| ShellSpan-stage-A-d367c1b0-9dc4-4f23-8929-db413240fe70 | 新对象权限 |
| ShellSpan-stage-A-52db149b-bc52-4765-91b5-495df3f3df8c | primary 启动 1314 |
| ShellSpan-stage-A-5410bb67-ffa3-44e9-963d-8abe5fc57a0a | 中间启动 87 |
| ShellSpan-stage-A-915c818d-2ada-4d2d-a4ea-61a68165f6f5 | 标志调整后 87 |
| ShellSpan-stage-A-45be075d-cab4-4ba2-9d61-7ee104377a2f | 最终代码与继承 ACE 清理验证 |

仍缺：运行中的 primary/后代身份、私有桌面、最小工具链权限、真实进程网络和服务代办、完整敏感快照、对象别名边界以及异常恢复。当前 probe 查询 IsTokenRestricted 也不能代替未来对确切 restricting SID 集合、低权限组与 privileges 的完整核验。

## 2026-10-09：registryRead LPAC 及夹具事务边界

最新证据：`evidence/windows-stage-a-2026-10-09-lpac-transaction-guard.json`。实际低完整性 LPAC Token 与唯一 `registryRead` capability 匹配；13 项文件操作、Winsock 初始化、IPv4/IPv6 TCP/UDP 探针及持续接收端检查通过。固定子进程返回 73，Job 进程树停止，夹具 package ACE 撤销并核验，创建的 profile 已通过生命周期 API 移除。此结果仅覆盖普通宿主用户下的自有夹具，不能替代独立账户、完整网络范围或生产可用性验收。

修复夹具准备过程的事务边界：受保护目录及计划记录创建后，先将夹具交给调用层保存，再执行文件创建、package ACL 授权及宿主正向对照。授权阶段发生错误时，调用层仍持有自有夹具，可进入现有撤销流程。尚未验证进程崩溃时的可信持久恢复；Temp 中的计划记录仍不能作为恢复授权来源。

验证：独立原型 10 项测试通过；所有 targets 的 Clippy（warnings 作为错误）通过；真实 LPAC 探针通过上述有限矩阵。阶段 A 尚待私有注册表反例、独立账户组合、后代进程与取消/异常恢复、扩大网络和 ACL 负向矩阵；阶段 B 的受控 broker、受保护 journal、账户池、类型化 IPC 和故障恢复验收尚未完成。生产 gate 保持 unavailable。

## 2026-10-09：宿主私有注册表负向对照

`evidence/windows-stage-a-2026-10-09-lpac-private-registry.json` 验证唯一 registryRead capability 的 LPAC 对自有 HKCU\Software\ShellSpanStageA-UUID 键的 KEY_READ 和 KEY_WRITE 均返回 Win32 5。键创建时使用 protected DACL，仅 SYSTEM 与宿主 SID 拥有访问；宿主读写打开正向对照通过。未读取或记录任何真实用户注册表值。固定子进程退出且进程树停止后，使用 RegDeleteTreeW 退役该次创建的精确键，再通过 RegOpenKeyExW 返回 2 核验不存在。文件、Winsock 与四项持续接收端检查仍通过，profile 与 package ACE 清理成功。计划记录包含由夹具 UUID 决定的精确键名；既有键不采用、不删除。此结果不证明全部注册表或 credential API 隔离，完整 A/B 验收仍待后续。

## 2026-10-09：实际后代 Token 与 Job 计数反例

`evidence/windows-stage-a-2026-10-09-lpac-descendant.json` 在真实暂停后代上比较用户/package/完整性 SID、全部 capability SID 与 attributes，验证 LPAC AccessCheck 及 Job membership，再恢复固定叶子并确认退出 73。此检查证明后代 Token，但 `IsProcessInJob(NULL)` 只证明属于某个 Job。

随后增加宿主针对其持有的确切 Job handle 的 accounting 核验；`evidence/windows-stage-a-2026-10-09-lpac-descendant-final.json` 实际 TotalProcesses=4，违背“只有根与一个固定后代=2”的假设，报告保留 error 并拒绝通过。当前尚未确定另外两个进程的身份和创建来源，不能通过放宽数量消除反例。下一步使用稳定进程 handle 与确切 Job membership/创建信息取证。全部自有资源清理确认通过；独立原型 11 项测试与 Clippy 通过，但不替代该真实失败。阶段 A/B 未完成。

## 2026-10-09：确切 Job 的实时进程身份取证

新增 Job completion port 观察器，在 root 创建前关联宿主持有的确切 Job。每次 NEW_PROCESS 通知只把 PID 用作查找，立即取得 process handle，再通过 IsProcessInJob(process, owned_job) 核验成员并查询镜像；不按 PID 杀进程。观察器在 Job handle 关闭前停止并 join。

`evidence/windows-stage-a-2026-10-09-lpac-conhost-token.json` 确认 4 个进程为两个固定 probe.exe 与两个 System32\conhost.exe；所有实际 process handle 均属于确切 Job，TokenIsAppContainer=true、完整性 RID=4096，无查询错误。这解释了原先计数假设错误，但当前报告仍拒绝“exactly 2”门禁，未通过放宽数量消除失败。还需补全 console helper 的用户/package/capability/LPAC 核验，以及明确的容许进程拓扑或无 console 启动方案，再重新验收。全部清理成功，11 项原型测试通过，Clippy warnings-as-errors 通过。

## 2026-10-09：固定拓扑与 console helper 完整身份通过

`evidence/windows-stage-a-2026-10-09-lpac-topology-final.json`：宿主实时取证四个确切 Job 成员，两个自有固定镜像、两个 GetSystemDirectoryW 对应的 conhost.exe；四者实际用户 SID、package SID、全部 capability SID/attributes 均精确匹配，实际 LPAC AccessCheck、AppContainer 和低完整性均通过。门禁核对 Job TotalProcesses=4、四个唯一 PID、精确镜像路径（Windows ASCII 大小写兼容）、每个成员全部安全事实与无查询错误。未知镜像、漏通知、身份缺失或计数变化均拒绝。回归测试覆盖未知镜像、错误 package、非 LPAC、重复 PID、缺失成员及额外计数。旧“只包含两个进程”假设被真实完整身份取证替换；历史失败记录保留。阶段 A 尚待取消/超时/崩溃、独立账户组合及扩展负向矩阵，阶段 B 未完成。

## 2026-10-09：真实超时进程树终止

增加固定 `--run-lpac-timeout` 入口，仅启动同一自有 LPAC 夹具与固定叶子；叶子保持运行 30 秒，根在成功 ResumeThread 后保存固定 resumed 标记并等待叶子。宿主在 1500ms 截止时须观察 WAIT_TIMEOUT、固定 resumed 标记、确切 Job 的 ActiveProcesses=4/TotalProcesses=4 和全部四个成员完整 Token/镜像拓扑；任一不足均拒绝。之后沿用 end_process 的稳定进程 handles 与 Job accounting 终止核验，树停止前不撤销 ACL 或退役 profile。

`evidence/windows-stage-a-2026-10-09-lpac-timeout-final.json` 显示 lifecycle_timeout_observed=true、process_tree_stopped=true、fixture_acls_revoked=true、profile_removed=true、error=null。entry_exit_73=false 是预期的超时中止，probe=null 明确此运行未完成文件/网络矩阵，不能用于宣称网络验收。12 项原型测试和 Clippy 通过。此证据仅证明固定树的超时路径，用户取消、broker/宿主崩溃、重启恢复和专用账户组合仍待验证；阶段 A/B 未完成。

## 2026-10-09：独立取消事件路径

新增固定 `--run-lpac-cancel`。宿主持有非命名、不可继承的手动重置 event；固定实验 requester 在后代 Resume 标记后 SetEvent。宿主使用 WaitForMultipleObjects 同时等待根进程和取消 event，必须观察取消分支而非根退出或截止；线程 join 后才关闭 event。随后核验完整四成员活跃树和实际身份，沿用同一稳定 handle / Job 终止与清理流程。

`evidence/windows-stage-a-2026-10-09-lpac-cancel.json`：lifecycle_cancel_observed=true、lifecycle_timeout_observed=false、树停止、ACL/注册表/profile 清理通过、error=null。`evidence/windows-stage-a-2026-10-09-lpac-timeout-after-cancel.json` 复核原超时分支仍独立成立。12 项测试和 Clippy 通过。此证据为真实 Win32 取消事件唤醒与清理，固定自动请求并不代表产品 UI/IPC 取消接入，也不证明提前取消、反复取消、执行方崩溃或重启恢复。阶段 A/B 仍未完整验收。

## 2026-10-09：执行根进程无析构异常退出

固定 `--run-lpac-root-failure` 在低权限根完成后代 Resume 并保存标记后，通过 TerminateProcess(GetCurrentProcess(), 0xe7) 注入无析构异常退出；固定叶子保持运行，宿主凭真实根 handle 等待并核验故障码。此操作只针对本次固定执行根，不终止宿主或任意外部 PID。

`evidence/windows-stage-a-2026-10-09-lpac-root-failure.json`：lifecycle_root_failure_observed=true，根退出后 ActiveProcesses=3，四个已取证成员的完整身份与确切 Job 拓扑通过；宿主 end_process 终止残存 Job 树并核验，process_tree_stopped/fixture_acls_revoked/profile_removed 均 true、error=null。未完成文件/网络矩阵，不能作为此矩阵通过的证据。12 项原型测试与 Clippy 通过。此实验仅证明执行根异常退出后宿主仍在线的恢复，不能替代宿主/broker 崩溃、受保护 journal 或重启恢复。

## 2026-10-09：受保护回执发布中断与不可信父目录反例

账户原型原先 truncate/write/sync 保存 ownership.json，存在写入中断留下不完整回执的缺口。现在创建同一受保护目录内唯一 create_new pending 文件，写入并 sync_all 后关闭，通过 MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH) 发布；准备期间不截断已发布回执。发布前持有父目录 handle（不共享删除）、排除父/目标 reparse、核验父/已有目标/pending 的 SYSTEM/Administrators ownership 与不可被不可信身份写入的 DACL，大小限制 64KiB。中断 pending 文件保留为证据，不作为恢复授权来源。

固定 `--diagnose-owned-journal` 仅提升此设置诊断，普通身份先构建。`evidence/windows-stage-a-2026-10-09-protected-journal-final.json` 在新自有受保护目录中验证刷盘后发布前注入失败保留 revision 1 完整回执、正常下一次发布完整 revision 2；ProgramData 不可信父目录在写入前拒绝，目标文件不存在；实际 root/回执 ACL 验证通过。未创建账户、WFP 或服务。13 项原型测试与 Clippy 通过。

此实验是受控发布失败点，不证明断电/文件系统损坏、宿主实际崩溃后的 LPAC profile 恢复或完整阶段 B journal。下一步账户 LPAC 组合还需专用 profile 装载/退役计划、可信记录、private desktop 的 package 授权和相应恢复校验；原 bootstrap 仍不加载 profile，尚未接入此候选。阶段 A/B 未完成，生产 unavailable。

## 2026-10-09：controller 网络证据与专用账户冻结计划接线

专用账户安装 SID WFP block 后，不能由这个账户做网络正向对照：该对照自身也会被阻断。新增共享 receiver_control，由控制器持有四项 socket 的克隆 worker，先观察真实宿主正向流量，再冻结回环端点并持续计数；fixed worker 只接收地址，不接收任何 socket handle。原夹具也复用此实现，去掉独立旧 worker 和重复正向对照。共享回归测试用真实放行流量证明四项计数均为 1，再验证无流量停止；远端/零端口/错地址族拒绝。

`evidence/windows-stage-a-2026-10-09-lpac-controller-network-final.json` 完整实际 LPAC 矩阵与 controller 四项接收计数 0、完整 Job 拓扑、树停止及清理通过。候选新增矩阵完整性/失败门禁；任一失败 check 或 incomplete 报告不能只凭子进程返回 73 宣称通过。receiver_evidence_owner/receiver_quietness_verified 区分实际接收证据归属，专用账户路径明确标为 external-controller-required 且不自行声明 quietness。

新增 account_lpac_plan 固定类型：UUID 推导账户/profile/目录名，无任意命令、可选路径或凭据字段；仅冻结 account SID 与四项已分配回环端点。reader 持有 root 与文件 handle，验证 SYSTEM/Administrators ownership、无不可信写入 ACL、非 reparse、单硬链接、8KiB 上限后读取相同文件对象；固定入口再校验实际源 Token SID。已将 `--owned-account-lpac` 接入预先冻结 profile 名和外部 receiver 配置；低权限 account-report.json 只是诊断输出，不能授权恢复。工作区直接调用在读取计划安全门禁处拒绝，无 profile 创建（拒绝记录见 evidence/windows-stage-a-2026-10-09-account-plan-rejection.txt）。

UUID 保持版本 1.26.1，仅启用 serde feature；锁文件只新增现有 serde_core 依赖。16 项测试与 Clippy 通过。controller 重构后原正常/超时/取消/根故障四路径均实际复跑，证据为 controller-refactor-*.json；未创建新专用账户，设置端的 profile/desktop 生命周期和可信恢复仍待实现。此原型契约并非阶段 B 的已完成 broker IPC。

## 2026-10-09 专用 profile、私有桌面与卸载后控制器中断

固定设置诊断已验证新停用非管理员账户的普通登录 Token、Windows profile 加载/卸载、冻结目录卷号/文件 ID、私有 station/desktop 四主体 DACL、不可见、同名 station 拒绝与关闭后不存在。正常退役及已清理回执重复恢复均通过。

最终故障实验 UUID `4dd74e2a-9f56-4ccc-af66-c76af2435c57`：profile 已卸载和 station 已关闭后，控制器直接 TerminateProcess 退出 232；受保护回执明确保留 profile/账户/过滤器待清理债务。新提升进程按精确 UUID 恢复退出 0，独立验证 profile、账户和四项持久过滤器不存在，cleanup_debt 清空。证据为 `evidence/windows-stage-a-2026-10-09-account-profile-controller-crash-final.json` 和 `evidence/windows-stage-a-2026-10-09-account-profile-controller-recovered-final.json`。

恢复只接受受保护且预算受限的固定回执，校验当前 SID、停用非管理员状态、无账户进程、无加载 hive、冻结 profile 身份与精确过滤器条件；不提供任意 profile 路径、按前缀删除或 PID 杀进程。该故障点没有运行 LPAC 命令，不覆盖运行中 LPAC、broker 断连或重启。17 项独立测试、Clippy warnings-as-errors、锁定构建通过。阶段 A/B 均未完成，生产 unavailable。

### 2026-10-09 profile 注册表绑定边界

profile_binding 改为从同一个 KEY_READ 句柄校验 owner/DACL 并读取 ProfileImagePath。创建任何账户前和恢复清理前均校验 ProfileList 父键，要求 SYSTEM/Administrators owner，拒绝普通主体的注册表写入、子键创建、链接、删除及权限变更；不修改机器注册表 ACL。掩码使用注册表语义，允许 KEY_READ 中的 KEY_NOTIFY，不套用文件写权限位。

新增实际 Windows security descriptor 回归测试覆盖只读正例、八种变更权限、普通主体 owner 和 null DACL。18 项测试、Clippy 与构建通过。真实新 profile 生命周期通过（UUID 4f357bb6-4ab4-4872-afd5-66b055b9575d），最终版重复恢复退出 0、profile_registry_security_verified=true、全部资源清理且债务为空；见 account-profile-registry-binding.json 和 account-profile-registry-recovery.json。此处仍没有运行专用账户 LPAC，不改变 A/B 未完成结论。

## 2026-10-09 专用账户 LPAC 首次实际组合

新增 --diagnose-owned-account-lpac 固定设置入口，已接通真实专用账户/profile、私有 station/desktop、受保护固定 AccountLpacPlan、普通 bootstrap 实际 SID/非管理员核验、外层 no-breakaway Job 和宿主持有的四项接收端。账户不能修改启动映像、计划或拥有回执，仅可写单独诊断文件。私有 GUI 对象实际 Low/NW 标签已核验；未修改共享桌面。

首次组合、显式私有桌面和 Low 标签三个实验均到达普通 bootstrap 后在创建 LPAC 子进程时返回 Win32 5；不能以接收端安静或 cleanup 成功作为 LPAC 行为验收。最终版本证据 windows-stage-a-2026-10-09-dedicated-account-lpac-final.json，UUID b303e00b-6f73-4a78-bc4a-439d03141015，outer Job total=2，receiver counts=[0,0,0,0]，account_lpac_verified=false，Windows profile/账户/过滤器退役且 cleanup_debt=[]。完整候选诊断保存于受保护回执快照。

新增清理 acknowledgement 非布尔/缺项拒绝回归；19 项测试、Clippy 与锁定构建通过。该固定原型的低权限诊断不能作为生产 broker 的恢复授权，独立 OS 资源身份核验仍未实施。下一步定位专用账户 LPAC 创建失败的权限/Job 边界，随后继续完整 A 与 B；生产 unavailable。

## 2026-10-09 启动 Token/Job 边界与部分 profile 退役恢复

固定 LPAC bootstrap 现复用加载 profile 的专用账户 primary Token，通过 CreateProcessWithTokenW 启动；设置端只临时启用已有 SeImpersonatePrivilege，账户保持停用。对照仍在 CreateProcessW 创建 LPAC 子进程时报 Win32 5，故不能把再次登录差异认定为原因。

实际 source_creation_boundary：session=1、Token 不受限、子进程策略 flags=0、当前 Job limit flags=8192（kill-on-close）、active process limit=0、UI restrictions=0。最终版 UUID 354e732d-bf4d-4ae6-8147-b9ed8159f620，全部资源正常退役且债务为空；见 windows-stage-a-2026-10-09-dedicated-account-lpac-boundary-final.json。这些证据排除所观察 Job 的进程数/UI/子进程禁用限制；尚未定位其他创建权限边界。

UUID da62891d-b9d3-400e-8f51-564172c8a1e6 暴露实际部分退役：缺失 WTS SID 保守拦住首次卸载，精确恢复时 Windows profile API 移除 SID registry binding 后仍保留固定夹具目录；提供显式路径再次调用该 API 返回 Win32 2。现恢复临时启用既有 backup/restore 权限，核验无账户进程/无 hive/无 binding、冻结根卷号与文件 ID，对无 binding 的精确残留沿用仓库 trash 5.2.9 回收站策略；不直接递归删除。实际残留已移入回收站，账户及四过滤器退役，债务清空；见 windows-stage-a-2026-10-09-dedicated-account-lpac-recycled-recovery.json。后续增加 512 对象预算和 reparse/硬链接拒绝，无法核验则保留债务。

WTS 缺失 SID 的进程只作 lookup hint，使用 held process handle 验证实际 Token 或已退出状态；不能查询活跃 Token 时仍拒绝，不按 PID 杀进程。真实自身进程 SID 拒绝和其他 SID 正例回归通过。21 项独立测试、Clippy warnings-as-errors 和锁定构建通过。A/B 未完成，生产 unavailable。

## 2026-10-09 专用账户 namespace 边界正向对照

新增固定 --diagnose-owned-account-lpac-admission，仅使用 System32/cmd.exe /d /c exit 73，同账户/profile/private desktop/LPAC+registryRead 条件，明确 account_lpac_admission_only=true，不替代默认文件网络验收。实际仍 Win32 5，排除本次私有夹具映像路径作为充分原因。实际 CreateAppContainerProfile 返回 SID 与设置端 DeriveAppContainerSidFromAppContainerName 完全一致，排除本次 package SID 不匹配。

只读 namespace 诊断对 API 返回的相对路径使用实际 session 的 BaseNamedObjects 解析，不改变任何对象 ACL。早期错误用法的 87/STATUS_OBJECT_PATH_SYNTAX_BAD 文件保留为历史；最终有效证据为 dedicated-account-lpac-namespace-absolute.json 和 host-lpac-namespace-control.json。专用账户可 traverse 当前 session AppContainerNamedObjects，READ_CONTROL 和 DIRECTORY_CREATE_SUBDIRECTORY 返回 0xc0000022；宿主用户三个请求均成功，同时真实 LPAC 固定文件/网络路径仍通过。此差异是进一步定位依据，不是完整因果证明。

控制器另创建并持有精确唯一 package SID 叶目录：无 OBJ_OPENIF，无 permanent 属性，不采用已有对象，不修改共享父目录 ACL；实际四主体（SYSTEM/Administrators/专用账户/package）全部目录权限、Low/NW 标签通过。bootstrap 能访问叶目录，仍不能创建 LPAC 子进程。结束后叶目录实际不存在、所有账户/profile/四过滤器清理，债务为空。证据 dedicated-account-lpac-owned-namespace.json，UUID 535bff80-e923-417e-b0d1-8a3fcf6154fe。该结果表明仅预建 package 叶目录不足。

新增 namespace 精确 session/package 校验、实际同名碰撞拒绝和关闭后消失回归；23 项测试、Clippy warnings-as-errors 与锁定构建通过。下一条路径是受控设置端通过有明确源账户 Token 的 SDK 进程创建 API 创建 LPAC，验证其 namespace 创建上下文；不放宽共享父目录 ACL，不使用未受支持 token API，结果不能提前成为 A/B 完成依据。完整 SYSTEM broker、账户池、typed IPC 及矩阵仍未验收。

## 2026-10-09 设置端直接 SDK LPAC 创建对照

新增固定 --diagnose-owned-controller-lpac-admission，仅在独立设置诊断中调用受支持 SDK，始终 production unavailable、admission_only，不运行用户或模型命令。CreateAppContainerProfile/GetAppContainerFolderPath/DeleteAppContainerProfile 在精确专用账户 impersonation scope 内执行，实际 package folder 在冻结专用 Windows profile 中；现有线程 impersonation 不采用，成功/失败均 RevertToSelf。

创建端使用从从不恢复执行的固定源进程取得的 primary Token，实际 SID/非管理员/session 与本次私有桌面匹配。只临时启用设置 Token 已有 impersonate/increase-quota 权限并恢复，没有政策授予。LPAC 属性冻结为唯一 package、唯一 registryRead、AAP opt-out；暂停根必须通过实际用户/package/capability/Low IL 和 package-positive/AAP-negative AccessCheck，之后才能恢复。源进程和执行根共享 controller-owned no-breakaway Job。子进程环境只含冻结账户目录与 Windows 目录，SDK 比较前重新构造 mutable command buffer。

实际 CreateProcessWithTokenW 的 LPAC 扩展属性调用返回 87；CreateProcessAsUserW 比较返回 2。预建叶目录、由 OS 创建 namespace、显式源环境和临时 HKCU 绑定对照均未解决。HKCU 绑定没有保留在最终代码。最终证据 controller-direct-lpac-final.json，UUID 6237208d-b644-40ef-87ff-4fbd030c37f1，source Token session=1/non-elevated=true，LPAC 未创建，源 Job 已停止，package profile 已退役。

SDK 创建过程中 namespace 引用仍存在于创建进程，设置端不提前退役账户/过滤器。原进程实际退出后，新进程精确 UUID 恢复确认 namespace 不存在，再清理 Windows profile/账户/四过滤器，债务为空，见 controller-direct-lpac-final-recovery.json。此前 e4bbe631、abcf30cc、c77e2c95、a0a978c9 对照也均已精确恢复。

新增实际 impersonation 错误恢复/嵌套拒绝、普通 Token 不得冒充 LPAC、registryRead SID 验证回归。25 项测试、Clippy warnings-as-errors、锁定构建与 diff-check 通过。后续需要定位实际失败位置并对照受控非交互 SYSTEM 设置上下文，不能把 SDK 调用失败或 profile 清理成功当 A/B 完成。

## 2026-10-09 SDK 参数位置修正与证据更正

核对 CreateProcessAsUserW 参数时发现原型把显式环境块指针传入 lpProcessAttributes，lpEnvironment 则为空。现改为进程/线程安全属性均为空、禁止继承句柄，环境块传入 lpEnvironment。这是实现错误；此前显式环境与临时 HKCU 对照含有该错误，不能作为排除环境或注册表上下文原因的证据。

修正后固定实机诊断 UUID 38bd4e9f-d768-496d-8523-b170b76761c8：源 Token 为非管理员且 session=1，package folder 属于冻结专用 profile；CreateProcessWithTokenW 仍返回 87，CreateProcessAsUserW 仍返回 2，LPAC 根未创建。源 Job 已停止，package profile 已删除；创建进程持有的 namespace 引用导致首次清理保留债务。确认创建进程退出后，精确 UUID 恢复证明 namespace/profile/账户/四过滤器均不存在，cleanup_debt=[]。证据为 controller-lpac-argument-fix.json 与 controller-lpac-argument-fix-recovery.json。

修正后 25 项锁定测试、Clippy all-targets warnings-as-errors 与锁定构建通过。现有测试未覆盖 SDK 参数位置，不能声称已有这项回归保障。A/B 仍未完成，生产 unavailable。

## 2026-10-09 同 Token 普通进程创建基线

控制器新增固定普通 CreateProcessAsUserW 对照：同专用账户 primary Token、同私有桌面、同 System32/cmd.exe 映像及显式环境，去掉 LPAC 扩展属性；始终 CREATE_SUSPENDED，不恢复执行。若创建成功，先纳入已有 Job，再用持有的进程句柄停止并确认退出；错误路径保留句柄至统一 Job 退役。

实机 UUID b3cc5cbe-a86f-407b-a397-f356cd409feb：普通创建返回 Win32 1314；LPAC SDK 比较仍返回 Win32 2，WithToken 扩展调用返回 87。现有提升控制器不能建立普通 CreateProcessAsUser 成功基线，因此不能依据错误 2 单独断言映像路径错误。源树停止、package profile 删除后，创建进程退出；新进程精确 UUID 恢复确认 namespace/profile/账户/四过滤器均退役，债务为空。见 [对照](evidence/windows-stage-a-2026-10-09-controller-ordinary-control.json) 和 [恢复](evidence/windows-stage-a-2026-10-09-controller-ordinary-control-recovery.json)。25 项测试、Clippy all-targets warnings-as-errors 和构建通过。

[SDK 文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw) 说明该 API 需要 increase-quota，并可能需要 assign-primary-token；1314 表示所需权限未持有。[客户端安全上下文说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/processes-in-the-client-security-context) 说明 LocalSystem 服务持有这两项权限。下一步应先核验创建端实际权限，再建立固定受控 SYSTEM 普通创建正向基线；不能给宿主账户授予政策权限，不能将未通过普通基线的 LPAC 结果作为完整方案验收。

## 2026-10-09 控制器实际权限成员核验

新增只读 TokenPrivileges 核验，仅输出三项固定创建权限的 present/enabled，不输出任意 Token 转储，不授予政策权限。成员读取有 64 KiB 和 256 项预算；新增重复读取不改变状态及固定输出范围回归，独立测试现 26 项通过，锁定构建与 Clippy 通过。

实机 UUID 968ed66f-8ce4-4fad-a7d1-c8f6ddc46597：SeAssignPrimaryTokenPrivilege 不存在；SeIncreaseQuotaPrivilege 存在，核验时未启用，实际创建时按既有 scope 启用；SeImpersonatePrivilege 存在且已启用。普通 CreateProcessAsUserW 仍返回 1314，LPAC 比较返回 2。此结果支持普通基线受到创建端 assign-primary 权限缺失限制，不证明 LPAC 的错误 2 已定位。见 [权限核验](evidence/windows-stage-a-2026-10-09-controller-privileges.json)。创建进程退出后精确恢复所有拥有资源，债务为空，见 [恢复](evidence/windows-stage-a-2026-10-09-controller-privileges-recovery.json)。下一步固定受控 SYSTEM 基线仍待实施；A/B 未完成。

## 2026-10-09 固定 SYSTEM 映像准备

新增 --prepare-owned-system-admission：只在提升设置上下文创建唯一受保护 ProgramData 根，先持久化复制意图，再 create_new 复制当前固定原型映像；源句柄禁止写入/删除共享，逐块核对副本，目标 ACL 仅可信主体可写，目标要求无 reparse/单链接，保存卷号、文件 ID 和大小。没有任意源路径或命令参数，尚不安装服务、不派发 SYSTEM 操作。回执和映像保留为后续诊断材料。

首次源硬链接拒绝记录保留；Cargo 构建产物可有硬链接，现源仅允许在拒绝写入共享的持有句柄下复制，目标仍严格单链接。实机准备 UUID ee6a026b-6ce4-4337-95c8-77831e8a61b9 退出 0，映像大小 1866240，见 [准备结果](evidence/windows-stage-a-2026-10-09-system-image-preparation-final.json)。新增目标硬链接拒绝、源别名写入拒绝和额外派发字段拒绝测试；独立测试现 28 项，Clippy 通过。完整 SYSTEM 服务入口、受保护计划重新核验、服务 journal/身份/退役及成功普通/LPAC 创建基线仍待实施，不能标记 A/B 完成。

## 2026-10-09 一次性 SYSTEM 服务与成功普通创建基线

新增固定 service dispatcher/ServiceMain/拒绝所有控制消息，精确 canonical UUID 与 actual LocalSystem Token 门禁，受保护回执及 held image 卷号/文件 ID/大小/路径重新核验。安装端先记录服务创建意图，拒绝同名对象采用；只创建自有 demand-start/own-process/LocalSystem 服务，显式保护新对象 DACL，不改变已有或共享服务 ACL。账户实验 UUID 同服务 UUID，在服务启动前已冻结。固定实验报告写保护目录；没有用户/模型命令接口。

首次 UUID 5ce3cef2-de97-4208-aa52-0b3ec98f48ae 在未启动时遇默认服务 ACL 控制权限门禁。只读查询证明 stopped/PID=0/本次固定配置；精确恢复删除，并处理 DeleteService 的异步退役观察，最终确认不存在，见 system-service-recovered-final.json。固定 handler 拒绝自定义控制，恢复安全检查按 service 权限语义排除该无执行能力的只读控制；新建对象改为 SY/BA-only DACL。没有修改全局服务安全配置。

最终 UUID 43dc94e3-3f37-416a-96fc-0f96a78fdde9 实际服务启动、actual SYSTEM Token 与映像路径核验通过，controller 拿到稳定进程句柄，确认 stopped 后等待真正退出，再核对配置/ACL删除并独立确认不存在。报告 actual assign-primary/increase-quota 均 present=true，source Token non-elevated/session=0；普通专用账户 CreateProcessAsUserW succeeded=true，源/普通控制两成员 Job 已停止。LPAC 仍返回 2，WithToken 扩展调用仍 87，根未创建，不能证明 LPAC 成功。见 [服务](evidence/windows-stage-a-2026-10-09-system-service-protected.json)、[SYSTEM 结果](evidence/windows-stage-a-2026-10-09-system-service-result.json)、[完整账户对照](evidence/windows-stage-a-2026-10-09-system-service-profile.json)。

创建进程退出后精确账户恢复确认 package namespace/profile/账户/四过滤器全退役，cleanup_debt=[]，见 [恢复](evidence/windows-stage-a-2026-10-09-system-service-profile-recovery.json)。新增 service UUID/非 SYSTEM 入口拒绝、配置字符串预算与未终止输入拒绝、控制消息无派发能力回归，独立测试现 30 项，构建/Clippy 通过。下一步在普通 SYSTEM SDK 成功基线上定位 LPAC/profile 创建上下文；完整 A/B 仍未完成。当前单次诊断服务不具有产品 broker 的认证 IPC/租约/账户池/完整中断恢复能力。

## 2026-10-09 专用账户 LPAC 目标调用上下文成功

依据 [CreateProcessAsUserW SDK 的目标上下文说明](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)，增加同参数固定对照：controller context 失败后，重新构造 mutable command buffer，只切换到精确源账户 impersonation scope 调用同 API。每次创建错误在恢复线程上下文前捕获；成功根仍暂停，必须通过实际用户/package/capability/Low IL/LPAC AccessCheck 才恢复固定命令，不接受任意派发。线程 scope 现核验 actual thread Token SID 与源 Token 一致，成功/失败恢复、拒绝既有 impersonation。

实机 UUID 2e787291-a6aa-4f26-a35d-d560e0cb4e46：SYSTEM Token 所需权限 present，普通创建成功；WithToken 扩展调用 87，AsUser controller context 2，AsUser target account context 成功。actual_user_verified/actual_package_verified/actual_capabilities_verified/actual_low_integrity/actual_lpac 均 true，root_exit_73=true，source Token non-elevated/session=0，owned_job_total=4，树停止，package profile 已删除。见 [实际报告](evidence/windows-stage-a-2026-10-09-system-target-context-profile.json)。该差分证明此固定创建路径的目标上下文决定结果；不扩大解释为所有 Windows 启动失败的根因。

服务控制器持有实际进程句柄并确认退出，服务删除和不存在核验通过。namespace 缓存在服务进程退出后消失，精确同 UUID 恢复确认 Windows profile/账户/四过滤器退役，cleanup_debt=[]，见 [恢复](evidence/windows-stage-a-2026-10-09-system-target-context-recovery.json)。新增 actual thread SID 与 scope 退出无 impersonation 回归，独立 31 项测试、Clippy warnings-as-errors、锁定构建通过。

account_lpac_verified 仍 false：目前只跑 System32 cmd admission，全部 helper 身份、固定文件/注册表/外部 controller 网络、默认 readOnly/workspace、取消/超时/崩溃矩阵尚未接到该成功路径。下一步接完整固定工作负载并做实际 OS 验收，再确定低层方案与进入完整 B；生产 unavailable。

## 2026-10-09 SYSTEM 专用账户固定文件/注册表/网络工作负载

将 appcontainer_probe 整理为独立 crate 共享模块，宿主候选和固定原型复用同一工作负载。公开原始 SID/Token 接口显式 unsafe 与生命周期约束。固定主映像加入 probe/leaf 的固定入口，没有用户命令参数；--prepare-owned-system-workload 将固定工作负载模式写入受保护准备回执，服务只执行该冻结模式。

受保护账户回执先冻结唯一 ProgramData/ShellSpan-AC-UUID 路径，再创建夹具并保存根卷号/文件 ID；撤销前重新核对该身份。source 账户上下文打开并持有精确 RegOpenCurrentUser hive，不使用缓存 HKCU 作为跨线程身份依据；夹具 key 创建/核验/删除均使用该持有句柄，child 也通过当前用户 API 打开真实 hive。源账户实际文件读写与私有 registry 正向对照先通过；SYSTEM 外部 controller 持有 receiver clones，四项正向计数通过并清零，LPAC 只获得冻结回环端点和固定字段环境。

首次 UUID 5eedf5e7-f448-489c-85ec-d3ac74d61f94 与加入撤销前冻结根身份核验后的最终 UUID 11229a0d-9d3e-4f98-88bd-07a519656c3d 均实际运行固定 probe：root user/package/唯一 capability/Low IL/LPAC 全通过，root exit=73；13 项文件/产物检查、2 项 registry denial、固定后代 user/package/integrity/capabilities/LPAC/Job/exit、Winsock registry/read initialization、TCP/UDP v4/v6 与四接收端检查共 34 项全部通过。TCP/UDP 实际拒绝 10013，四 controller counts 均 0，初始化成功，不能把缺失运行或初始化失败算拒绝。owned_job_total=6，树停止；全部夹具 package ACE 和私有 registry key 实际撤销。见 [最终工作负载](evidence/windows-stage-a-2026-10-09-system-workload-final-profile.json)。

服务真实进程退出并精确删除后，两次各按 UUID 恢复 namespace/profile/账户/四过滤器，债务均为空；最终 [恢复证据](evidence/windows-stage-a-2026-10-09-system-workload-final-recovery.json)。共享模块宿主 LPAC controller 网络对照亦复跑，error=null、LPAC=true、全部 probe checks 通过，profile 删除，见 shared-probe-host-control.json；候选按设计仍退出 2 表示生产不可用。

新增显式 fixture UUID/非绝对 parent 拒绝、actual current-user registry binding 禁止替换、源控制与真实 package/key 撤销回归；测试 32 项、Clippy warnings-as-errors、锁定构建与 diff-check 通过。未知 workload 退役状态阻止 profile/账户/SID block 清理，崩溃后完整 workload 重构恢复尚待实施。

这些是有限工作负载证据，未覆盖所有 conhost/helper 的实际安全身份、两个完整默认模式、ACL/路径负例、DNS/入站/私网/系统服务代办、并发/取消/超时/异常/重启矩阵。下一步将 LPAC 执行 Job 与从不恢复的普通基线 Job 分开，接入实际 JobObserver 核验全部执行成员；继而补生命周期及默认模式。account_lpac_verified 仍 false，A/B 未完成。

## 2026-10-09 专用账户完整固定执行树身份与独立基线 Job

将既有 IOCP JobObserver 与严格四成员 topology 检查移入共享 crate 模块，宿主候选和 SYSTEM 专用账户复用实际 Token/映像观察逻辑。Observer 启动要求 Job handle 保持有效直至 finish/drop。普通永不恢复的源进程和创建对照另归 baseline Job；LPAC 执行 Job 只含工作负载。两棵树分别经 stable handles 停止，任一未知状态保留 profile/账户/SID block。

成员来自 exact Job completion port 的 PID lookup hint，随后使用 held process handle、IsProcessInJob(exact Job)、actual Token SID/package/capability/Low IL/LPAC AccessCheck 与完整映像查询。严格要求 2 probe + 2 System32 conhost、4 唯一成员；未知/缺失/重复/查询错误/身份偏差全部拒绝。停止后再次核对执行 total 未变且 active=0，防止身份快照后新增成员被遗漏。扩展 topology 回归覆盖用户/capability/IL/AppContainer/Job/查询错误负例，测试总数仍 32。

首次 UUID efdbd232-540c-48ba-856e-9981cba917a9 和最终 UUID dee25322-a8ed-42a7-b99b-074794991d7e 实机均捕获完整四成员，全部 actual facts true/Low IL 4096/error null。最终 execution total=4/final total=4/final active=0，baseline total=2/stopped=true，34 项固定工作负载全部通过。服务真实进程退出并删除后，精确同 UUID 恢复确认 fixture package/key、namespace、Windows profile、账户、四过滤器均退役，cleanup_debt=[]。见 [最终成员](evidence/windows-stage-a-2026-10-09-system-job-observer-final-profile.json) 和 [最终恢复](evidence/windows-stage-a-2026-10-09-system-job-observer-final-recovery.json)。

共享 observer 的宿主 --run-lpac-controller-network 实机复跑：actual LPAC、四成员、树停止、夹具撤销、profile 删除和 receiver quietness 均通过，error null，见 shared-observer-host-control.json。候选退出 2 仍表示生产 unavailable。32 项锁定测试、Clippy warnings-as-errors、构建和 diff-check 通过。

目前只证明完整固定正常执行树；专用账户超时/取消/根异常/宿主服务异常及重启、跨宿主/broker/他槽句柄/凭据负例、完整默认模式和扩大文件/网络矩阵尚待实施。下一步将既有固定 lifecycle marker/event/fault 工作负载接到成功的 SYSTEM 路径；account_lpac_verified=false，A/B 未完成。

## 2026-10-09 专用账户超时、固定取消和执行根异常

新增冻结 FixedLifecycle typed enum（normal/timeout/cancel/root_failure），受保护服务准备回执与账户回执同源绑定。--prepare-owned-system-lifecycle 只接受 timeout/cancel/root-failure，未知模式或任意命令拒绝；旧回执默认 normal。非工作负载计划不得携带中断模式。固定 leaf 在中断模式保持运行，仍为固定映像入口；不会执行用户命令。

timeout 使用实际 1500 ms deadline，要求 WAIT_TIMEOUT、root STILL_ACTIVE、四成员 active、固定 descendant-resumed marker。cancel 在 marker 后由 controller-owned 非继承 event 中断真实 root wait，要求 WaitForMultipleObjects 返回 event index、root STILL_ACTIVE 和四成员 active。root_failure 要求实际 root exit 0xe7、root wait signaled、三成员仍 active。三项都在后续 observer 中核验完整四成员 actual 用户/package/capability/Low IL/LPAC/映像/精确 Job，最后以 stable handles 终止自有树，核对 total 不变、active=0。没有 PID-only kill 或观察超时重启。

| 模式 | UUID | 实际触发 | 最终状态 |
| --- | --- | --- | --- |
| timeout | 36a4a7d8-a817-42c9-a74a-1c57cc7937de | deadline 时 root=259，active=4，timeout observed | topology=true，total=4/active=0，精确恢复 debt=[] |
| cancel | fac76926-88a3-4bb5-a744-042e02e01aee | event interrupt，root=259，active=4，cancel observed | topology=true，total=4/active=0，精确恢复 debt=[] |
| root_failure | 6f3cf46d-3309-4e5d-91c5-34f1a84d2459 | root=231，active=3，root failure observed | topology=true，total=4/active=0，精确恢复 debt=[] |
| normal 复跑 | 2ec7125f-7279-4056-8e9f-ca78522edffe | root=73，完整 34 项检查通过 | topology=true，total=4/active=0，精确恢复 debt=[] |

证据分别为 system-timeout-profile/recovery.json、system-cancel-profile/recovery.json、system-root-failure-profile/recovery.json、system-lifecycle-normal-profile/recovery.json。每次服务真实进程退出且删除后，才精确恢复 package namespace、Windows profile、账户和四过滤器；夹具 package ACE/私有 key 已在树停止后核对根身份并撤销，各次均无剩余债务。

中断发生在固定 descendant 等待阶段，报告 complete=false、workload_checks_passed=false；仅 13 项已完成文件前缀和四项 receiver 观察（17 项）通过，lifecycle_fixture_prefix_verified=true。没有执行到的 private registry/Winsock/network 后续检查不计通过；该中断证据不替代正常模式的 34 项真实网络/文件验证。

新增未知 lifecycle/任意字符串拒绝及触发门禁（缺 marker、错误 wait/exit、错误 total、无存活树）回归。独立 34 项锁定测试、Clippy warnings-as-errors、构建与 diff-check 通过。下一步仍须处理 SYSTEM 服务运行中崩溃后的完整 owned workload 恢复、宿主断连/重启、重复取消/并发/breakaway、跨槽句柄/凭据负例和两个默认模式；完整 A/B 尚未完成，production unavailable。
