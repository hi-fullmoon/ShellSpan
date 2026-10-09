# Stage A account sandbox prototype

The fixed `DnsRpcBlockInternetProbe` now publishes its root-process trace intent
in the protected profile receipt before starting the PID-filtered session and
resuming the verified LPAC process. `Run-FixedProjectMatrix.ps1 -Case
DnsProtectedRpcTrace` delivered an empty client trace while both DNS receivers
still received test requests. Empty trace is not evidence of no RPC or denial.
Cleanup independently verifies session absence before releasing profile/account
and network rules. Recovery may retire a verified live session only after the
original controller/target are stopped and protected receipt/account gates pass;
reappeared completed sessions and unknown states remain quarantined. The actual
controller-crash recovery path still requires fault-injection validation.

Fixed RPC observation control: build `shellspan-rpc-trace-control`, then run
`scripts/Run-FixedRpcTraceControl.ps1` elevated. Both accept no supplied PID,
provider, endpoint or command. The memory-only trace filters its own PID and RPC
client events 5/7, exports bounded interface/operation/protocol/status metadata,
and requires stopped session, drained consumer and no lost events. The actual
ordinary cache-only DNS control delivered a correlated LRPC pair (operation 4,
interface 45776b01-5956-4485-9f80-f428f7d60129). This is not LPAC evidence or a
network denial. Admission integration requires protected trace ownership and
exact crash recovery first; the diagnostic Drop path is only best-effort cleanup.

Git repository controls: `--run-source-git-init-control` and `--run-lpac-git-init`
run fixed bare initialization with an empty template in owned output. Ordinary
initialization passes; shared-source LPAC fails while creating the HEAD lock.
Existing Git version admission does not prove repository workflow compatibility.
The dedicated entry `--prepare-owned-system-git-init` uses the same fixed bundle
and owned output directory. ProgramData-based dedicated initialization also fails
on HEAD directory preparation; independent account/profile/filter recovery passes.

Fixed C# compilation controls: `--run-source-powershell7-build-control` and
`--run-lpac-powershell7-build` compile a fixed class with Add-Type and verify its
owned text artifact. The LPAC control uses the existing fixed registryRead and
lpacInstrumentation capabilities. The fixed command explicitly imports the
already-frozen Microsoft.PowerShell.Commands.Utility.dll. Ordinary compilation
passes. The build mode now freezes and copies a bounded ref directory (471 total
files on this machine); shared-source LPAC compilation and retirement pass.
These controls do not satisfy dedicated-account or full project build acceptance.
The fixed dedicated-account entry `--prepare-owned-system-powershell7-build`
now uses the same frozen references and existing SYSTEM admission/recovery flow.
Its fixed C# compilation, artifact, exact execution identity and independent
resource retirement have passed. Full project build acceptance remains pending.
The current build command persists a fixed DLL, reloads it and invokes the
compiled method. Controllers also inspect its held identity, link count, size
and static PE imports. Receipts need `build_dll_verified` for this newer scope;
earlier in-process build receipts do not prove persisted DLL execution.
The current child loads the DLL bytes it hashed, then writes a fixed SHA-256
receipt. The controller compares that receipt with its held DLL bytes. This
detects subsequent byte changes; it does not authenticate arbitrary tool output.

Fixed SYSTEM workload receipts now carry a Credential Manager reference bound to
the owned UUID and account SID, never the password. To recover such a receipt
under its credential owner, elevate `--prepare-owned-system-profile-recovery <UUID>`,
then run `--run-owned-system-admission <new preparation UUID>`. This creates only
the fixed one-shot recovery service; the protected plan freezes the original
account UUID. A loaded hive still blocks recovery until the profile API lifecycle
is safely recovered. The earlier `ba16502e-566b-4193-93d6-b6b34414ae68` crash has no
credential reference and remains an offline disabled-account debt.

Independent Windows-only experiment with a fixed minimal runner. Production remains
unavailable; mandatory phase A evidence is incomplete. No arbitrary command or user
project path is accepted. See the [latest continuation](../../docs/design/agent-shell-sandbox-windows-stage-a-2026-10-08.md).

```powershell
cargo test --locked --manifest-path tests/windows-sandbox-account/Cargo.toml
cargo clippy --locked --manifest-path tests/windows-sandbox-account/Cargo.toml --all-targets -- -D warnings
./tests/windows-sandbox-account/run.ps1
# Read-only report: diagnostic success does not mean admission passed.
./tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe --diagnose-loader-acl
# Explicit setup action; Windows presents UAC:
./tests/windows-sandbox-account/run.ps1 -RunOwnedFixture
```

The script builds both executables as the desktop user, then elevates only fixture
setup. Default execution performs no fixture setup and exits 2. The explicit action
also exits 2 while acceptance evidence is missing. Do not run the whole app as admin.

Setup creates a new disabled nonadmin account in built-in Users, an owned protected
ProgramData fixture, four persistent exact-account WFP blocks, and a private
noninteractive station/desktop. A fixed ordinary-account bootstrap logs on with an
in-memory password, derives its own restricted primary Token and launches only the
fixed child probe. The password is wiped and is absent from receipts, argv and
environment. Tokens and Job membership are checked using actual stable handles.
No production service or driver is installed; WinSta0/Default are not modified.

Fixture ACLs preserve existing owner and permissions. Only initially empty output
and scratch directories receive inherited account/restricting-SID grants. The six
output creation/reopen/nested checks pass. Secret objects and sensitive ancestors
retain protection; this is not the full sensitive snapshot implementation.

Setup temporarily grants noninheriting restricting-SID read/execute access to 22
fixed System32 runtime DLLs. It refuses directory/reparse objects, records actual
file identities before mutation and incrementally revokes its own SID afterward.
Only the setup Token's existing SeRestorePrivilege is temporarily enabled; account
privileges and ownership are not changed. This explicitly modifies those file ACLs
for the fixture lifetime. Never expand the list automatically after a loader error.

Current real result: suspended restricted primary creation, exact identity and Job
checks pass, as does kernel32.dll read. Resuming the child exits 0xc0000022 before
probe initialization. Real child IPv4/IPv6 TCP/UDP denial is therefore **unproven**.
Host receiver positive controls and fixed child network probes are implemented;
network success requires both child results and receiver observations. The former
impersonated-thread socket checks have been removed.

Latest diagnosis independently opens three shared loader objects with ordinary
and restricted Tokens: `\KnownDlls`, `\KnownDlls\ntdll.dll` and
`\KnownDlls\kernel32.dll`. Ordinary opens succeed; restricted opens return
0xc0000022. Startup now checks these objects before runtime file ACL changes or
child launch. It fails closed with specific object evidence on this machine.
No shared object ACL is modified. This proves named-object denial, not the full
causal loader trace; minimal shared-object permissions and recovery remain work.
The fixed runner suppresses critical-error dialogs so failures cannot silently
wait for interaction on its private desktop.

The subsequent elevated setup admission check can read the three object DACLs but
cannot open them with WRITE_DAC (0xc0000022). The prototype now checks this before
creating an account, fixture or WFP rules. On this machine it exits NO-GO with no
new resources. `--diagnose-loader-acl` emits JSON including actual elevation and
each status; its exit 0 means the diagnostic completed, while `passed=false` means
setup is unavailable. This is a limitation of the current UAC setup path, not proof
that a SYSTEM service or ownership takeover would be safe or sufficient.

## Independent AppContainer admission candidate

```powershell
# Run as the ordinary desktop user; always returns NO-GO exit 2.
./tests/windows-sandbox-account/target/debug/shellspan-appcontainer-candidate.exe --run-owned-profile
```

This separate executable creates only a fresh empty AppContainer OS profile with
zero capabilities. Its only command is fixed System32/cmd.exe `/d /c exit 73`.
It verifies actual package SID, same source user, low integrity, zero capabilities
and Job binding before Resume. Real entry/exit 73 passes; stable process-tree
cleanup and the owned empty profile lifecycle API complete successfully. Retained
temporary receipts record interruption/cleanup debt; they are evidence, not
trusted recovery authority. Existing profiles are never adopted. It rejects an
elevated source and does not grant system ACLs, create network exemptions, or
switch the original backend automatically.

Explicit environment copies only SystemRoot/WINDIR/USERPROFILE/LOCALAPPDATA directory
locations. The current user is used only for this admission experiment; dedicated
account composition and private desktop have not been tested. File allowlists,
sensitive files, AllApplicationPackages exceptions, workspace creation/reopen,
receiver-backed networking, descendants and recovery remain unproven. This is
ordinary AppContainer, not LPAC. Production remains unavailable.

The candidate now also offers explicit `--run-file-network` and
`--run-lpac-file-network`. They create a protected owned Temp fixture, copy only
this fixed probe image and grant the unique package SID to listed objects. Ordinary
host file controls and cloned TCP/UDP receiver controls must pass before Resume.
Owned fixtures are retained; package ACEs are incrementally revoked and every
actual DACL verified after process-tree termination. No general crash recovery
API is provided; temporary candidate receipts are not authorization.

Latest outcome: ordinary AppContainer fails the external AllApplicationPackages
read counterexample. LPAC excludes that authority, and 13 actual file checks pass,
including output creation/reopen and secret/external refusal. LPAC then fails
Winsock initialization with 10107: its report is partial (`complete=false`),
so receiver silence is not network acceptance. LPAC admission is validated using
actual Token AccessCheck package/AAP controls and actual files, not an assumed
Win32 class-46 result. Both candidates remain NO-GO.

Latest regressions also cover missing-file versus permission denial and live
cloned receiver capture/termination. Historical receiver runs affected by blocking
clones and recovery wake traffic are excluded from network evidence.

## Ownership and recovery

Cleanup waits stable handles for root and Job members. Uncertain termination keeps
the account disabled, ACLs and offline WFP protection, and records cleanup debt.
Normal cleanup revokes owned runtime/fixture ACEs, removes the exact account and
then its exact WFP filters. Fixtures remain evidence and are never directly deleted.
Retire reviewed fixture directories using the project's recycle-bin mechanism.

For an interrupted owned fixture, run the built setup executable elevated with:

```powershell
# Substitute only the exact UUID in its protected ownership receipt.
./tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe --recover-owned-fixture <UUID>
```

Recovery validates protected receipt ownership/DACL, exact account SID and disabled
nonadmin state, process absence, all four owned WFP filter conditions and fixed
runtime file identities. It holds objects against replacement, rejects reparse and
fixture hardlink cases, removes only owned ACEs, and independently verifies account
and rule absence. It never kills a process by an unverified PID or infers ownership
from a prefix. Latest real recovery revoked all 22 runtime ACEs and cleared debt.
This is a fixture recovery prototype; crashes, receipt I/O failure, administrative
races and reboot persistence still need broader acceptance evidence.

## Remaining acceptance

Git 依赖诊断为 `--run-source-git-dependency-probe` 与 `--run-lpac-git-dependency-probe`。parent 通过持有的 Git runtime 映像提取有界静态 PE imports，发送固定身份/有界 basename 计划；未提升的 child 针对固定 Git 目录及 System32 记录文件打开、限制搜索路径的 LoadLibraryEx、实际 module 路径和 FreeLibrary。parent 要求 `dependency_report_bound=true`，还须检查树/fixture/profile 回收字段。该 probe 以 73 表示诊断交付，整个原型仍退出 2；DLL failure 属于报告内容，不代表 Git 兼容性通过。静态 imports 不覆盖全部 delay/dynamic/transitive dependencies，不得由此自动放宽原工具安装目录或系统 ACL。

`--run-lpac-git-bundle-admission` 从固定 Git runtime 的已持有句柄复制映像及静态本地依赖到本轮自有 fixture，限 16 files/64 MiB；冻结清单先于复制，create_new 不覆盖，对新文件核对身份及字节后仅授予 package FRFX。源映像和副本 lease 保留到完整 Job 停止，之后释放并撤销 fixture 权限。必须同时检查实际退出码、stdout、拓扑及全部清理字段。当前共享源实测 Git --version 返回 0；固定原型仍退出 2，该成功不替代专用账户或完整 Git/npm/build 行为验收。

专用账户入口为提升后的 `--prepare-owned-system-git-bundle`，随后对准备回执中的确切 UUID 使用现有 `--run-owned-system-admission UUID`。准备枚举只接受固定 Git bundle，并拒绝恢复或异常生命周期混用；没有任意路径/命令入口。检查 protected `service-result.json` 和账户 `ownership.json`，外层服务退出或删除不等于诊断及清理通过。本机 Git --version 已返回 0，但首轮 namespace 未确认，需要独立固定 profile recovery 才清空全部资源。此模式不生成完整 workload 报告，不得满足阶段 A 全矩阵门禁。

专用账户另有固定 `--prepare-owned-system-node` 与 `--prepare-owned-system-powershell`，后续调度/恢复流程相同。Node 当前固定 process.exit(73) 实测通过；PowerShell 当前固定 exit 73 在 PSEtwLog 初始化时以 0xffff0000 失败，诊断 stderr 保留。清理与恢复成功不能抹去该错误，也不能把工具固定启动视为完整 readOnly/workspace/npm/build 行为验收。

PowerShell 原因诊断先以普通桌面身份运行 `diagnostics/Build-PowerShellEtwProbe.ps1`，再使用 candidate 的固定 `--run-source-powershell-etw-probe` 与 `--run-lpac-powershell-etw-probe`。helper 仅运行固定 GAC 程序集 PSEtwLog 初始化器，记录有界完整异常链；exit 73 是诊断交付，仍须看 `initializer_succeeded`。当前普通对照成功、LPAC EventProvider.EtwRegister NativeErrorCode=5，parent 的 etw_delivery_verified=true 不代表 PowerShell 可运行。没有日志禁用、任意程序集或脚本入口；源/副本/全部实际 Job 成员与清理结果仍须核验。

该 helper 同时原生对照固定 PowerShell provider 与一个固定独立诊断 provider 的 EventRegister/Unregister，不安装 manifest、不写事件、不改 ACL。parent 要求精确两项 GUID、handle/返回码匹配，成功 handle 必须注销成功；目前普通对照两项均 0、LPAC 两项均 5。这只是两个固定 provider 的本机诊断，不能视为全部 ETW 边界验收。

PowerShell 7 固定对照为 `--run-source-powershell7-control` / `--run-lpac-powershell7-admission`，使用本机固定安装路径及 NoProfile/NonInteractive exit 73；`--run-lpac-powershell7-owned-entry` 仅复制固定 pwsh.exe 到自有 fixture 以区分入口路径与依赖失败，不提供完整运行时。当前普通对照成功，安装路径 LPAC 返回 0x80008085，自有入口返回缺少 pwsh.dll 的 0x8000809a；两者均兼容性未通过，不能计入 PowerShell 验收成功。

`--run-lpac-powershell7-runtime` 准备固定平面 engine DLLs/exe/两个 runtime JSON，自有源及副本 lease、intent 与完成清单，限 384 files/320 MiB；单独运行时撤销限 512 对象，普通夹具仍限 64。Modules/语言资源/个人配置不复制，不能计作完整工具闭包。首轮已加载到 ETW 注册异常，并出现同 Job 的受限 WerFault，正常退出/固定工具拓扑未通过；修正预算后以 `shellspan-retire-runtime-debt.exe` 无参数只恢复首轮精确夹具，验证原 creator/owner/image identity，并撤销 ACE、移除其 registry key/profile。该恢复不是任意资源入口或完整 B 恢复实现，原执行错误仍保留。

普通源正向对照使用 `--run-source-powershell-control`、`--run-source-git-control`、`--run-source-node-control`；必须是未提升且未模拟的普通 primary。另有 `--run-source-git-runtime-control` 与 LPAC 的 `--run-lpac-git-runtime-admission`，直接使用固定 `D:\Programs\Git\mingw64\bin\git.exe` 区分 launcher 与 runtime 加载失败。全部使用固定参数、自有目录、显式句柄列表及 Job；普通对照仍退出 2，报告 `positive_control_passed` 只表达诊断对照，不能作为沙箱验收或恢复授权。普通夹具停树后进入回收站，不能跳过清理字段检查。

工具诊断仅继承显式 NUL/stdout/stderr 三句柄。固定 output 文件不覆盖既有路径；停止完整 Job 后从原句柄各读取最多 16 KiB，再关闭句柄及撤销夹具权限。PowerShell 固定启动诊断按 UTF-16LE 解码，Git/Node 按 UTF-8 解码；截断、无效编码或超预算均保留失败，诊断输出不能作为恢复授权。

固定工具共享源 admission：`shellspan-appcontainer-candidate.exe` 新增 `--run-lpac-powershell-admission`、`--run-lpac-git-admission`、`--run-lpac-node-admission`。使用系统 PowerShell、`D:\Programs\Git\cmd\git.exe`、`D:\Programs\nodejs\node.exe` 三个本机固定路径，拒绝任意路径或参数。固定命令分别为无 profile 的 `exit 73`、`--version`、`process.exit(73)`；工具映像持有只读 lease，环境目录使用自有 output，所有实际成员必须通过独立工具拓扑门禁。与其他原型入口一样固定退出 2，必须读取报告判断实际检查与清理，不能把退出 2 或进程创建成功当成兼容性结论。当前共享源实机 Node admission 通过，PowerShell/Git 异常退出；专用账户、依赖与构建行为尚未验证。

Loader initialization, receiver-backed child networking, descendant behavior,
sensitive handles, DNS/service delegation, private network/inbound, full sensitive
snapshots, aliases and concurrent replacement, and crash/reboot persistence remain.
Unit tests cover real Token/AccessCheck behavior, exact restricting SID, default-DACL
handle permissions, fixed config validation, Job member cleanup, receipt protection
and read-only/noninheriting runtime deltas. They do not authorize stage B.

### LPAC 固定超时实验

`target/debug/shellspan-appcontainer-candidate.exe --run-lpac-timeout` 创建本次自有夹具，使固定后代保持运行；在 1500ms 截止时核验四个实际 Job 成员与完整 LPAC Token 后终止树，再撤销权限和退役资源。报告的 `lifecycle_timeout_observed` 和清理字段表达实验结果；`entry_exit_73=false`、`probe=null` 不代表完整文件/网络验收通过。原型仍固定退出 2，production unavailable。此入口不支持任意命令。

`--run-lpac-cancel` 使用同一固定长运行夹具，由宿主实验 requester 在后代恢复后发出自有取消 event；报告须为 `lifecycle_cancel_observed=true`、`lifecycle_timeout_observed=false`，并检查全部清理字段。此固定自动请求仅验证原型的取消等待/终止路径，尚未接入产品 IPC/UI。

`--run-lpac-root-failure` 固定注入执行根的无析构退出（0xe7），后代保持运行；宿主须观察正确退出码、剩余活跃 Job 成员及完整 Token，随后停止残存树并清理。报告 `lifecycle_root_failure_observed` 与 `active_processes_after_root_failure` 区分此路径。它不验证宿主/broker 自身崩溃或重启恢复。

### 受保护回执发布诊断

普通身份构建后，单独提升原型执行 `--diagnose-owned-journal`，仅创建 ProgramData 下 `ShellSpan-journal-A-UUID` 自有受保护证据目录；验证发布前中断保留完整上一版、下一版正常发布及不可信父目录拒绝。目录与未发布 pending 文件留作证据，不创建账户、过滤器或服务；不等同于宿主崩溃/重启恢复。账户原型的回执保存已复用此发布实现。

### controller 与专用账户计划

`--run-lpac-controller-network` 由外层控制器先验证四项真实接收正向对照，再把冻结端点交给固定 LPAC 探针；最终 quietness 证据来自控制器拥有的实际 socket worker。`--owned-account-lpac` 是专用账户 bootstrap 的内部固定入口，只读取当前自有目录中的受保护 account-lpac.json，匹配实际账户 Token 和 UUID，未提供用户/模型选定路径或任意命令能力。低权限 account-report.json 不能作为恢复授权。专用账户 LPAC 组合尚未实施，不能直接用普通工作区配置运行此入口。

### 专用账户 profile 与私有桌面诊断

普通身份构建后，单独提升固定原型执行 `--diagnose-owned-account-profile`。它创建一次性停用非管理员账户和四项持久 SID 过滤器，只在登录时短暂启用账户；加载新 profile 并冻结目录卷号/文件 ID，核验私有 station/desktop 的四主体 DACL、不可见与同名拒绝，然后卸载和精确退役资源。它不运行用户或模型命令，也不表示 LPAC 组合通过。

`--diagnose-owned-account-profile-crash` 在 profile 已卸载、私有 station 已关闭之后注入设置控制器无析构退出，预期退出码 232。受保护 `ProgramData/ShellSpan-account-profile-A-UUID/ownership.json` 保留明确清理债务。只把本次输出的精确 UUID 传给提升后的 `--recover-owned-account-profile UUID`；恢复校验受保护回执、当前账户 SID/停用非管理员状态、无账户进程、未加载 hive、冻结 profile 身份及精确过滤器条件，再通过系统 profile API、账户 API 和 WFP API 退役。证据目录保留；无法验证的对象保留债务，不按前缀或任意路径删除。此故障点尚未覆盖正在运行的 LPAC、broker 断连或重启。

### 专用账户 LPAC 组合入口（当前 NO-GO）

单独提升固定原型执行 `--diagnose-owned-account-lpac`：复用新 profile/私有桌面，外层 controller 持有接收 socket 和 kill-on-close Job，受保护自有子目录只授予账户读取/执行，单独诊断报告允许账户写入；账户仅在固定登录调用期间启用。普通 bootstrap 暂停时核验实际 SID 和非管理员身份，再恢复。LPAC 子进程显式使用冻结 UUID 对应的私有桌面，私有 station/desktop 创建时具有 Low/NW mandatory label，实际 DACL 与 label 均核验。

2026-10-09 实机仍在 CreateProcessW 创建 LPAC 子进程时返回 Win32 5；固定 bootstrap 与 console helper 两成员树已停止，候选撤销夹具 ACE 并退役 AppContainer profile，外层退役 Windows profile、账户及过滤器，债务为空。四接收端计数零不证明网络拒绝，因为 LPAC 子进程未启动。account_lpac_diagnostic_report 是固定原型诊断，不是生产恢复授权；独立 broker OS 身份核验仍必须实现。清理 acknowledgement 不完整时保留停用账户/SID block，不提前清槽。

当前固定 bootstrap 复用已加载 profile 的专用账户 primary Token（CreateProcessWithTokenW），不再次启用账户或传密码；设置端临时启用已有 impersonate 权限并恢复。报告 source_creation_boundary 记录真实 session、restricted Token、Job limits/UI 和子进程策略。该对照仍 NO-GO，Win32 5 尚未定位。

部分 profile 退役恢复：如果系统 profile API 已移除 SID binding，却留下冻结身份的自有目录，恢复在确认账户停用、无进程/无 hive/无 binding 后，核验根身份、最多 512 对象且无 reparse/hardlink，再用仓库同版 trash 库移入回收站；任何未知状态保留债务。恢复只读取固定受保护回执，没有通用回收站/路径删除接口。WTS 缺失 SID 使用实际 held process Token/已退出证据补查，活跃 Token 不可查时仍拒绝。

`--diagnose-owned-account-lpac-admission` 是固定 System32 cmd.exe 退出码 73 对照，报告 account_lpac_admission_only=true，不能算文件/网络或阶段 A 验收。只读 namespace_admission 记录实际 session 中 API 派生 namespace 的目录访问状态。设置端可创建并持有本次精确 package SID 叶目录，实际核验四主体 DACL 和 Low/NW 标签；无 OBJ_OPENIF/永久对象，不修改共享父目录 ACL，关闭后要求实际不存在。回执冻结名字，恢复只检查精确数值 session/package 与不存在状态。

当前实机：宿主用户可请求共享 namespace 父目录的子目录创建权限，专用账户此请求拒绝；预建本次叶目录后专用账户可访问该叶目录，LPAC 创建仍 Win32 5。该对照没有定位所有创建上下文问题，生产仍 unavailable。

`--diagnose-owned-controller-lpac-admission` 是独立固定设置进程 SDK 对照，不是产品 broker。账户上下文只用于创建/查询/删除本次唯一 package profile，要求实际路径在冻结账户 profile 内，并恢复线程身份。源进程从不恢复执行，仅提供同 session 的实际专用账户 primary Token；源与根全部归同一 owned Job。固定 LPAC SDK 参数及实际身份/AccessCheck 必须通过，才允许固定 cmd 退出命令执行；没有用户选定命令能力。当前两个 SDK 路径仍返回 87/2，LPAC 未创建。

创建进程可能仍持有 namespace 引用，清理会保留停用账户与 SID block。必须等待同一创建进程实际退出，再执行本次精确 UUID 恢复；已验证 namespace 消失和完整资源退役。不得用观察超时代替进程退出。早期环境/HKCU 比较存在 SDK 环境参数位置错误，不能排除这些原因；参数已修正，最终代码没有 HKCU 覆写。

### 固定 SYSTEM 服务对照（不是完整 broker）

提升执行 `--prepare-owned-system-admission`，取得精确 UUID；准备入口仅复制当前固定原型到保护目录并冻结映像身份。再提升执行 `--run-owned-system-admission <UUID>`：先记录安装意图，创建唯一 demand-start/LocalSystem/own-process 服务，保护新建服务 DACL，核验实际配置/ACL后启动。固定服务入口拒绝非 LocalSystem Token、非规范 UUID、回执不匹配和映像身份/路径替换。服务执行固定专用账户 SDK 对照，账户实验 UUID 在创建服务前已冻结，不接受任意命令或路径。所有服务控制消息都被拒绝。

正常路径持有并核验服务实际进程 Token/映像，等待 SCM stopped 与进程句柄退出，核对配置再删除，独立查询不存在（允许最多 5 秒异步删除观察）。未知/超时状态保留债务。`--recover-owned-system-admission <UUID>` 仅退休本次配置匹配且 stopped 的拥有服务，不能终止活跃服务或重启；账户/Profile/过滤器仍使用独立 `--recover-owned-account-profile <UUID>` 核验。

2026-10-09 UUID 43dc94e3-3f37-416a-96fc-0f96a78fdde9：实际 SYSTEM Token 持有 assign-primary/increase-quota；普通专用账户暂停创建成功，LPAC 创建仍 Win32 2。服务已停止/进程退出/删除；随后精确账户恢复清空全部债务。结果只建立 SYSTEM 普通创建基线，不等于 LPAC、完整 A 或完整 B 验收。

后续 UUID 2e787291-a6aa-4f26-a35d-d560e0cb4e46 在相同 SYSTEM 服务内对照目标账户线程上下文：controller context 仍 2，精确目标账户 impersonation context 下 LPAC 创建成功；实际根用户/package/唯一 capability/Low IL/LPAC 均通过，固定命令退出 73。服务/账户/profile/过滤器均退役。仅 admission 成功，account_lpac_verified 仍 false，完整文件/网络/helper/生命周期矩阵待接线；生产 unavailable。

`--prepare-owned-system-workload` 准备同一固定服务的文件/注册表/回环工作负载模式，随后仍使用精确 UUID 的 `--run-owned-system-admission` 启动。固定源/普通基线不恢复；实际 LPAC 根先核验安全身份再恢复固定 probe。receiver 正向计数和安静证明来自 SYSTEM 外部 controller，registry fixture 绑定 held current-user hive，撤销前核对冻结根卷号/文件 ID；未知退役状态保留账户与 SID block。

最终 UUID 11229a0d-9d3e-4f98-88bd-07a519656c3d 的 34 项固定检查、包 ACE/key 撤销及后续精确 profile/账户/过滤器退役通过，债务为空。固定后代已检查，全部 console helper 尚未在这条路径核验；默认模式和扩大矩阵仍不完整，不能算阶段 A/B 完成。

后续 UUID dee25322-a8ed-42a7-b99b-074794991d7e 使用独立 baseline/execution Job 与共享 IOCP JobObserver：执行中的 2 probe + 2 conhost 均实际核验用户/package/capability/Low IL/LPAC/映像/精确 Job；最终 total=4、active=0，baseline 两成员另行停止，34 项检查和精确资源退役通过。完整正常固定树已通过，专用账户 lifecycle/默认模式/跨槽负例仍未验收，生产 unavailable。

`--prepare-owned-system-lifecycle timeout` 准备固定超时实验；参数也可为 `cancel`、`repeated-cancel` 或 `root-failure`，随后使用同样精确 UUID 的服务启动/恢复命令。模式绑定于保护回执，无任意命令能力。超时/取消触发时 active=4，根异常 exit=0xe7 后 active=3，四成员身份核验通过，最终 total=4/active=0。重复取消实验发送三次固定事件信号，并在首次停止后以相同稳定句柄再次回收两次，最终会计总数必须保持不变；该实验不替代 broker 消息重放与并发取消验收。服务退出前 namespace 可能保留未确认债务，必须以独立固定恢复服务的最终回执确认全部清理。

中断报告 complete=false、workload_checks_passed=false：已执行文件前缀通过，不将未执行网络/registry 步骤计通过。完整运行中服务崩溃/断连/重启、重复取消、并发、breakaway、默认模式及跨槽负例仍待验收，A/B 未完成。

## 两个既有崩溃 hive 的重启后恢复

`ba16502e-566b-4193-93d6-b6b34414ae68` 与 `4bb6655d-3b91-4088-b7f3-7db3e7005b0b` 的 hive 当前仍加载，账户禁用、原服务已退役。新 Token 的 profile API load/unload 没有证明 hive 消失。先由操作者保存其他工作并手动安排 Windows 重启，之后重新检查；重启本身不能算恢复成功。

构建本独立原型后，在管理员 PowerShell 中运行固定脚本的只读检查：

```powershell
& 'D:\Developer\ShellSpan\tests\windows-sandbox-account\scripts\Recover-InterruptedProfiles.ps1' -InspectOnly
```

只有两项 `eligible_for_fixed_recovery` 均为 true，才运行同一脚本（不带 `-InspectOnly`）。脚本仅绑定上述两个 UUID/SID/账户；如果实际 hive/CIM profile 仍加载、账户身份替换或原服务存在，停止且不准备服务。native 原型再次独立核验受保护回执、精确身份、进程树、冻结文件和 WFP，再通过一次性 SYSTEM 服务执行恢复。最终同时检查 service-result error、服务退役以及 profile/account/filter/credential flags 和空债务。

恢复未知或失败时，保留打印的独立 preparation UUID 与受保护回执，检查其实际服务/helper 状态；不能因为观察超时重新派发。脚本不重启 Windows，不强制卸载 hive，不更改 User Profile Service，也不解除未知债务的 SID block。当前仅完成脚本语法、只读状态和阻塞拒绝路径实测；重启后的正向恢复尚未验证，A/B 仍未完成。

脚本不会仅凭旧的 retirement flags 跳过 native 核验；回执标记与当前 SAM/hive/CIM profile/service 状态冲突时拒绝。即使标记与 OS 一致，也通过固定 native 恢复重新验证进程、凭据及精确过滤器。已记录 profile 退役而账户删除/过滤器清理仅部分成功时，可以继续精确恢复；账户缺席但 profile 尚未持久记录退役时拒绝。服务完成后再次核验当前 OS 状态，不能只看 JSON flags。纯门禁回归可运行：

```powershell
& 'D:\Developer\ShellSpan\tests\windows-sandbox-account\scripts\Test-InterruptedProfileGate.ps1'
```

固定 ETW instrumentation 候选：`shellspan-appcontainer-candidate.exe --run-lpac-powershell-etw-instrumentation`。仅此诊断增加 registryRead + lpacInstrumentation；实际两项 provider 注册与同 assembly 初始化通过，完整 shell 和新增能力隔离验收仍未完成，生产 unavailable。

完整 PowerShell 5 instrumentation 对照：`shellspan-appcontainer-candidate.exe --run-lpac-powershell-instrumentation`；固定 exit 73 本机超时，进程和权限清理确认，不计兼容通过。

新增能力现有边界矩阵：`shellspan-appcontainer-candidate.exe --run-lpac-instrumentation-controller-network`，共享源 71 项通过，控制端接收器无流量；DNS/私网/RPC/凭据/专用账户仍未覆盖。

PowerShell 7 自有运行时固定启动候选：`shellspan-appcontainer-candidate.exe --run-lpac-powershell7-runtime-instrumentation`，共享源固定 exit 73 已成功并完整撤销本轮权限；专用账户、脚本/构建行为、完整 A/B 尚未验收。

专用账户 PowerShell 7 准备入口：提升执行 `--prepare-owned-system-powershell7-runtime`，后续仅按保护记录精确 UUID 派发与恢复；已实现固定 runtime 与两项能力、512 撤销预算，但尚未实机验收，不计 A/B 完成。

固定跨槽位注册表诊断：`scripts/Run-FixedProjectMatrix.ps1 -Case CrossSlotRegistryAccess` 仅绑定两个项目拥有且已禁用的旧中断槽，受保护拥有回执、SAM 和冻结 profile 身份匹配后执行 SYSTEM 与新 LPAC 主进程的四类访问正负对照。只申请打开并关闭句柄，不修改注册表数据。证据前缀单次使用，不重复已完成运行；默认策略仅接受八项明确 Win32 5，不能把未知错误当隔离成功。该诊断不构成完整 A/B 验收。
