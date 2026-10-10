# macOS 与 SSH 完善阶段 1：异常恢复与资源归属

日期：2026-10-08；状态更新：2026-10-09。状态：**阶段 1 本轮完成**，按用户决定保留完成状态；缺少 macOS 主机的不同真实账户验收列为后续补验，不记作已通过。历史债务、平台及竞争限制继续保留。下文各轮记录保留当时的状态与证据，以本文末尾的完成决定为当前状态。此记录属于 [研发终版中的 macOS 与 SSH 完善阶段](agent-shell-sandbox-final.md#4-macos-与-ssh-后续研发顺序)，不替代此前编号阶段的验收记录。

## 修订、环境与证据

- 初始 HEAD：`689509decac0d39efbf08cf180d9e237d3212a86`。工作期间 HEAD 更新为 `6276f5b3689df5d181d837273f487708b58c450a`，最终核对时为 `0bfc32af6dd65a4aa5c8aff457bb0a9d939e6260`；保留当前状态，没有回退这些提交。本轮工具没有执行 commit、tag 或推送。
- 环境：macOS 26.7.1 / 25G241、arm64，Rust/Cargo 1.95.0、Node 24.21.0。SSH 为普通账户在 loopback 上启动的独立自有 sshd，密钥、known_hosts、项目和数据库由 fixture 创建；没有使用用户服务器或修改系统 SSH 配置。
- 当前最终运行目录：`.phase4-acceptance/stage1-local-controller-final-r9-2026-10-08/`。`report.json` 保存 55 个源文件 SHA-256、基线修订、命令退出码与实际 Wry 二进制 SHA-256，`sourceUnchanged=true`，`failedChecks=[]`。下文早期记录保留其当时结果，不替代本文末尾的当前修订证据。原始日志、独立 App 报告与事实 JSON 均在已有忽略目录，不纳入 Git。
- 最后补齐必要错误提示的前端证据：`.phase4-acceptance/stage1-final-frontend-2026-10-08/report.json` 保存 4 个前端文件的最终 SHA-256；`backendSourceHashesMatch=true` 确认复用上面的 18 个未改变源文件，`sourceUnchanged=true`。这次只改变双语提示与错误格式化，不重复计算此前 SSH／Wry 证据。
- 重跑入口：`tests/agent-shell-sandbox-macos-ssh/verify_stage1.py`，使用新输出目录。事实记录不导出密钥、授权 token、HMAC proof 或模型凭据。

## 生产路径与执行／资源状态对应表

| 路径 | 执行与授权状态 | 资源状态及恢复要求 |
| --- | --- | --- |
| 本地 OS 预检 | 公开 native probe 在 blocking worker 初始化当前 Runtime 存储；首次预检前写意图，缓存不是授权 | 固定真实进程、工作目录和 command temp 清理确认后解除意图；异常保留债务。未确认终止时保留目录 |
| SSH prepare／预检 | `NativeToolAdapter.prepare_sandbox` 冻结来源、账户、profile 代际和主机密钥；先核对目标，再执行固定自检及真实 stdin/cancel | 生产自检／stdin/cancel 启动前写意图；固定自检正常完成且最后签名清理确认后才解除。不把基础设施探测或通道关闭当作确认 |
| prepare／issue | Native 契约、Header 绑定、TTL、call digest 和远端 backend stamp 校验；关闭或恢复债务阻止新 prepare/issue | 审批和签发本身不认领进程；live grant、prepared token、remote controller key 不由历史恢复 |
| 本地 Direct dispatch | 能力校验到进程注册的窗口与取消资源快照串行；意图先于 spawn，启动注册后释放锁 | 持有真实 Child／未回收的组领头身份。完成最后组信号后才回收；回收后只观察。普通子进程、代理和 temp 清理确认先于终态回执 |
| SSH Direct dispatch | 完整启动输入开始交付后标记 unknown；签名 ready 后标记 started；来源变化立即废止执行授权 | 独立控制通道使用本次 job/root/digest/key 的签名回执。通道 EOF、命令输出和退出码不解除债务 |
| 本地取消／超时 | 停止当前拥有的组，核对组终态；清理失败优先报告 `terminationUnconfirmed` | `exec_command`／`wait_process` 的未确认终态返回 uncertain，registry 和意图保留；其他任务不被取消 |
| SSH 取消／断连 | 旧执行授权失效，不能重放；原 live job 可单独用冻结的 peer 和 cleanup key 核对清理 | 离线时 unconfirmed；重连不恢复执行授权，签名 controllerFinished/terminationConfirmed 加精确目录清理才确认。丢失 live key 后不能按 PID／名称认领 |
| 应用退出 | 单向 admission 关闭、撤销旧能力、停止 driver 和拥有资源；反复关闭复用结果 | 空的内存 registry 不消除恢复债务；清理或账本解除写入失败不能报告全局成功 |
| 重启 | 恢复策略、日志和暂停的队列，不恢复授权；发现持久化意图则 native admission 关闭 | SQLite WAL/FULL 的历史行只表达债务，不表达删除或发信号权限，不从它构造 PID、目录、controller key 或新 grant |
| 副作用 reconciliation | 现有 API 只能核对调用效果，不为资源清理提供凭据 | 即使确认了命令效果，历史资源债务也不会自动消失；没有可信资源终态时继续待完成 |

## 修复范围

1. 增加 Direct 意图账本，接入 Runtime／NativeAdapter 配置、本地及 SSH 生产预检、实际启动、正常资源回收和退出门禁。账本不存原命令、PID、密钥或 live grant；写入与门禁检查在同一锁内，异常丢弃意图继续关闭门禁。
2. 本地不再用 Shell 退出作为普通后代已停止的依据；采用 OS `waitid(WNOWAIT)` 保留组身份，最后信号之后不再对历史 PID 发信号。
3. 本地 temp 删除先于成功回执；实际权限导致的删除失败保留目录、registry 和持久债务。未确认清理不会被零退出码、策略失效或普通 command failure 覆盖。
4. SSH 使用未回收的固定 Shell leader 和有界 JSON 行 completion pipe，用户命令不继承该 pipe。兼容当前既有 Python 解释器，不安装依赖，不编写进程结构的字节解析器。权限拒绝仅表示无法确认，不能转成终止成功。
5. 串行保护启动到注册与取消时资源快照，避免取消返回后仍出现此前已获准但未注册的进程。锁只覆盖启动窗口，已运行任务仍可并发。
6. 更新两个沙箱协议；Wry 自有 Node 项目提供真实 package.json，保留项目读取边界。新增恢复债务／归属记录错误的双语提示，绑定失效提示不再笼统声称命令没有执行，要求先核对已有执行效果。仅修改必要提示，布局和控件未改动；没有权限扩展、自动重放或 Host 回退。

## 回归与真实验收

最终命令与结果以同目录 `report.json` 和原始日志为准。最终源码校验 `sourceUnchanged=true`，二进制 SHA-256 为 `5f0075fe76c674bd471741a5195ce48ce64abca60227a248822371fa27cff585`。

| 检查 | 最终结果 |
| --- | --- |
| `agent_runtime::native::process::tests` | 20 passed；包含独立子进程入口，不能解释为 20 个独立验收场景 |
| `direct_ownership` | 3 passed；真实 SQLite 债务、异常丢弃和 dangling symlink 拒绝 |
| 三项明确选择的真实 macOS SSH ignored tests | 输入／取消／超时／清理、离线重连、签发与绑定失效分别 1 passed，共 3 项；其他 ignored 项不算通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **失败**：1153 passed、1 failed、66 ignored；失败为既有 `terminal_screen_redacts_real_private_keys_across_rows_and_wrapped_delimiters` 的 `assert!(!credential_like)`。同修订单项复跑 1 passed，但保留全量失败，不改成整体通过 |
| Petdex 集成独立补验 | `cargo test --manifest-path src-tauri/Cargo.toml --test petdex_contract_probe`：5 passed；日志 `rust-integration.log`。这不消除上面的全量失败 |
| 最终 `pnpm test` | 2448 passed、2 skipped（271 个文件 passed、1 个文件 skipped）；包含双语提示与错误前缀回归，跳过项不算通过。最后前端补验目录保存原始日志 |
| `pnpm build`／`cargo build` | 通过；既有前端 chunk 提示及 Rust container_backend 的两项 dead-code 警告仍存在 |
| `pnpm check:rust:includes`／`check:ai-styles`／`check:llm:catalog` | 全部通过 |
| 修改的可独立检查 Rust 文件 | commands、macos_sandbox、native/mod、direct_ownership、process、remote_seatbelt、remote_seatbelt_recovery 的 `rustfmt --check --config skip_children=true` 通过 |
| 全仓 `cargo fmt -- --check` | **失败**：日志保留既有 mod、capability、mcp、runtime 等差异；没有格式化无关代码，不计为通过 |
| `git diff --check` | 通过；没有无关 UI 改动、调试转储、凭据或未忽略的临时项目 |

终端脱敏失败没有输出密钥，也没有修改该模块。失败断言表示命中了 credential-like 分支，该生产分支会清空屏幕并放置统一脱敏提示；这次没有证据证明私钥泄露。单项复跑不能解释全量失败，随机密钥场景的稳定性仍待单独定位。

| 场景 | 入口与效果证据 | 终态／范围 |
| --- | --- | --- |
| 派发前崩溃 | 独立真实 Rust 测试 App 已提交意图，尚无命令效果；仅终止刚创建的 Child handle | 无 effect，原 App 已回收，新 engine admission 阻止，持久行仍为 1；不宣称真实模型审批恢复 |
| 派发后没有持久结果而崩溃 | 同一独立 App 启动真实有界 Shell，看到 started 后中断；两秒后真实 effect 为 startedfinished | 没有重放，原 App 已回收，自然完成仍不解除债务，新 engine 阻止派发；没有 Wry/pipeline driver 证明 |
| Shell 提前退出 | 实际普通后台 sleep，读取其真实 PID，并核对 controller 与 OS | 组停止后才确认；回收后只观察，不向历史 PID 发信号 |
| 两个本地任务 | 真实并发进程、分别取消；取消首任务时第二任务仍 running | 两者分别确认停止，新的 startup 无剩余债务；不代表子 Agent／fleet 组合 |
| 启动注册窗口中的取消 | 真实进程已启动，生产 dispatch 锁仍持有；另一个线程实际 cancel_task | 取消须等注册完成，之后确认停止；有持久化与新的 startup 核对 |
| 清理成功／失败 | 真正删除 temp；另一次仅对自有 temp 的父目录设置不可写权限，使真实删除失败 | 成功回执在目录消失之后；失败 retained / uncertain / current + restart dispatch blocked。断言前恢复自有目录权限 |
| SSH 输入／取消／超时 | 既有 production remote runner、真实 SSH stdin、读写和拒绝测试 | 精确所属目录清理、实际 controller receipt 和源 PTY 零写入；未从通道关闭推断终止 |
| SSH 有限离线及重连 | 两个实际 job；停止第一个不影响第二个。仅终止本次 listening sshd，断开来源，观察至少 15 秒后重开相同自有 fixture | 离线终止未确认；重连旧 capability 仍无效；原 live job 签名清理确认，两个确切目录均不存在，旧输出没有重放 |
| SSH 认证／profile 绑定变化 | production NativeToolEngine 真实批准／签发／执行，改变再恢复 profile 认证字段并重新预检 | 旧 prepared 和已签发 grant 仍拒绝，没有 forbidden marker；恢复原值不能复活旧授权，不代替真实不同账户验收 |
| 实际 Wry AppExit | NativeAdapter 已启动真实后台命令和 Node HTTP 服务；活动状态确认后首次 AppExit 发起 production shutdown | 核对进程、代理、端口、旧 pending token／签发能力、marker、Exit 事件及持久化意图；不宣称 model-registered approval |
| 两个真实 Wry 的正常恢复 | restore-seed 正常退出后，相同独立数据目录 restore-reopen | 策略保留、队列暂停、授权不恢复、旧效果不重放；新 explicit approval 才执行，不宣称硬崩溃或远端恢复 |

最终事实文件：`facts/crash-before-dispatch.json`、`crash-after-dispatch.json`、`shell-exit-group.json`、`two-task-cancellation.json`、`cancel-during-registration.json`、`cleanup-before-receipt.json`、`cleanup-failure.json`、`ssh-offline-reconnect.json`。真实 Shell 提前退出场景的 OS 后代观察为 absent、controller terminationConfirmed=true；清理失败场景 exitCode=0、terminationConfirmed=false、目录 retained、当前与重启 dispatch 均 blocked；启动注册竞争场景拥有进程最终为 0，新的 startup 可派发。

SSH 最终实测离线观察 **15.002627416 秒**，离线 terminationConfirmed=false、重连后 true；两个确切目录 absent、旧 capability unavailable、sourcePtyWrites=0，effect 仍为单次 `second-running`。监听重新启动和 source reconnect 是显式 fixture 恢复步骤，没有执行旧命令。

Wry `wry-exit/shutdown-check.json` 为 passed=true、19 checks true、productionAppExit 首次清理 2 个实际活动资源，proxy/port 终态确认、modelRequests=0、PTY writes=0；实际 race 为 gateRejected，不代表全部派发竞争分支。`app-exit-events.json` 记录 PID 66440 的真实 ExitRequested/Exit。`wry-restore/restore-seed.json`／`restore-reopen.json` 均 passed=true，实际 PID 66457／66470，相同创建时间、绑定和数据目录保持，旧授权没有恢复。三个 PID 最终 OS 查询均不存在；两个 Wry 状态目录的 `dispatch_debt` 实际计数均为 0。

## 必须继续保留的待完成项

- 模型已派发后硬崩溃的本地资源债务仍为 1，状态 uncertain；命令效果核对通过不能证明资源清理，也没有恢复模型续跑。WaitingApproval 与两个远端 Session 场景的当前证明见下文。
- 真实不同 SSH 账户变化仍待验收。当前两个远端 Session 使用同一普通账户；反复离线和多个独立进程共用状态目录的最新范围见下文。
- 主工作台中恢复提示的实际显示与完整操作链；本轮只验证必要的双语错误格式化和现有前端回归，不代替阶段 2 的真实 UI 验收。
- 旧会话、旧版本和版本回退兼容验收按用户要求移出完成条件；缺少拥有凭据的实际资源仍不按历史 PID／名称补认领。
- 中间未确认的诊断 fixture 不能凭名称清扫；成功最终场景的精确资源清理不证明所有历史试验残留已核对。没有进行名称扫描、批量信号或历史目录清理。
- 忽略／跳过项不计通过。全仓格式门禁已在后续本轮处理，阶段 6 的其他质量范围仍待对应验收。

有限离线事实只适用于实测观察时长。硬链接、同账户恶意竞争、敌对后代逃离进程组仍是 `partial` 限制；本轮不扩大隔离承诺。阶段 1 未完成，不能据此开启阶段 2 的前置门禁。

## 当前修订：三个指定场景的补齐证据

最终二进制 SHA-256：`6a324cfc9b97427c081678e92c9f9cee3ff2cc70df0cd0a896aa1adb2c62c97b`。完整运行目录为 `.phase4-acceptance/stage1-completion-final-r2-2026-10-08/`；31 个源码哈希匹配，未创建提交或推送。

| 场景 | 当前真实结果及证明范围 |
| --- | --- |
| 模型 WaitingApproval 硬中断 | `model-waiting-recheck/report.json` passed；实际 MiniMax 请求产生审批后，仅对自有 Wry SIGKILL，seed=-9、reopen=0。旧审批取消／拒绝，旧 marker 未执行；新显式审批才执行。主运行的首次尝试请求 3 次仍未达到固定审批，保留 pending；同一二进制的新目录补验通过，不改写原失败 |
| 模型已派发硬中断 | `model-unknown/report.json` passed，实际模型请求 3 次；started 后 SIGKILL，恢复无重放、无新模型请求，效果为单次 started/ended。人工 ConfirmedApplied 仅核对真实效果；资源债务 1、uncertain，native 门禁仍关闭，shutdown 不伪称清理成功 |
| 两个独立远端 Agent Session | `multi-remote/report.json` passed，8 项检查通过；真实 profile／密钥／PTY／项目分别独立，共用生产 Runtime/NativeAdapter。取消 alpha 时 beta 仍运行，旧绑定审批拒绝，beta 独立清理，两个精确目录消失，PTY 写入 0。第二 engine 对仍存活创建者的核对返回 resolved=0、uncertain=2，不误清理 |
| SSH App 崩溃恢复 | `ssh-crash/report.json` passed，seed=-9、reopen=0，9 项检查通过。父进程保持自有 sshd；新 Wry 同状态目录先拒绝派发，再调用生产清理 IPC，resolved=2、uncertain=0，重复调用 0/0。两个精确目录消失，旧效果单次、策略绑定保留，旧执行授权不恢复，新显式审批才执行 |

远端清理凭据在启动前托管于系统钥匙串，数据库仅存引用。恢复核对存储根、意图、task/request/target、冻结 peer/account 和控制器摘要；固定 status/stop/cleanup 的签名终态才解除债务。没有按历史 PID、名称或目录猜测拥有关系。缺失／不匹配托管凭据、遗留本地债务继续关闭门禁；实际 SQLite 删除但缺少可信终态的回归也保持 uncertain。

当前修订回归：process 20 passed、ownership 4 passed、明确运行的真实 SSH 3 passed；全量 Rust **1155 passed、0 failed、66 ignored**，另 5 个集成测试 passed。前端 **2448 passed、2 skipped**；前端／原生构建、includes、AI styles 和模型 catalog 检查通过。Wry 活动退出及正常恢复通过。全仓格式检查仍失败，保留 `rust-fmt.log`；跳过和 ignored 不计通过。早期终端脱敏失败的记录仍保留，但当前完整运行通过。

### known_hosts 事故与修复

新增测试 App 标识最初没有进入 debug known_hosts 隔离名单，导致测试覆盖 `/Users/zhengbiwen/.shellspan-dev/known_hosts`。没有找到能够证明其原始开发信任记录的备份。用户明确回复“没有，可以复制一份出来”后，保留覆盖后文件的忽略目录快照，并将 `/Users/zhengbiwen/.shellspan/known_hosts` 复制为新的开发基线；两者 cmp 一致。这是用户授权的基线重建，不能称为原始记录完整恢复，生产文件未修改。

现已限定两个精确 debug App 标识，并在新 harness 写入前强制 known_hosts 位于本次 fixture 状态目录。当前最终多会话和 SSH 崩溃报告的 `userKnownHostsUnchanged=true`，补验后生产／开发基线仍一致。未把主机条目、密钥或清理 token 写入本验收文档。

## 排除兼容验收后的继续实施

用户明确不要求兼容验收，本轮完成条件已移除旧会话、旧版本和版本回退。新运行目录为 `.phase4-acceptance/stage1-four-remaining-r2-2026-10-08/`，对应源码发生了格式和跨 App 门禁修改，不把之前二进制证据冒充本轮证据。

- 全仓 `cargo fmt -- --check` 已通过；按本轮格式门禁范围运行 rustfmt，没有撤销用户代码。
- 补齐跨 App 资源门禁：在 SQLite IMMEDIATE 事务内核对 foreign debt 并写入本次意图，封闭两个 App 先配置、后派发的窗口。真实独立测试进程已验证第二 App 拒绝派发，第一 App 不受误取消影响，精确解除后新实例可继续；ownership 6 passed，含独立子进程入口。共享状态采用拒绝第二 App 的安全行为，不承诺同时执行。
- 同一自有普通账户 SSH fixture 连续三轮离线／重连通过。三个事实文件 `facts/ssh-offline-reconnect-cycle-{1,2,3}.json` 记录离线时长分别 15.032896917、15.024159333、15.033488708 秒；每轮离线未确认，重连签名清理确认，两目录 absent、旧 capability 不可用、sourcePtyWrites=0。
- 只读历史资源核对：`.phase4-acceptance/stage1-resource-inventory-2026-10-08/report.json` 记录 6 个有精确记录的远端目录，全部 absent；25 个债务数据库计数可核对。不扫描临时目录、不删除文件、不读取托管密钥、不对历史 PID 发信号；路径观察不是清理权限，目录 absent 也不自动解除债务。
- 本地已派发硬崩溃的历史债务缺少受保护的资源拥有凭据及确切 temp 记录，仍保持 uncertain。现有进程内 worker 会随 App 消失；自然结束和命令效果不能证明代理、后代及 temp 的完整终态。不能安全删除债务；本地跨崩溃清理仍需独立控制器与可信终态回执支持。
- 当前机器 UID=501，只有一个普通登录账户。没有第二个已授权账户及 profile，已向用户请求环境说明；不使用系统服务账户、不创建账户或修改系统 SSH 安全配置。不同真实账户验收保持待完成。

本轮最终二进制 SHA-256 为 `4f0f22fd4992a9da04c051d0be9a0c2ef9bcdea1dbfd78bbbc86a7aae8757f1d`，46 个源码哈希均匹配。全量 Rust 1157 passed、0 failed、66 ignored，集成 5 passed；前端 2448 passed、2 skipped；前端／原生构建、fmt、includes、AI styles、模型 catalog 全部通过。当前二进制的模型 WaitingApproval 与 unknown 中断、双远端会话、SSH 崩溃恢复、Wry 活动退出和正常恢复全部通过，无 failedChecks。unknown 的通过仍表示预期的 fail-closed：债务保留，不能理解为本地资源清理完成。两个 SSH 生命周期报告均 `userKnownHostsUnchanged=true`。

最终历史核对目录 `.phase4-acceptance/stage1-resource-inventory-final-2026-10-08/` 包含新增验收记录：8 个有精确记录的远端目录全部 absent、31 个债务数据库计数已记录。缺少可信终态的本地及历史债务仍 pending，没有自动清除。阶段 1 剩余为本地跨崩溃资源清理、缺少凭据的历史残留终态，以及第二真实普通账户验收；兼容项不再作为门禁。

## 当前最终修订：独立本地控制器与可信终态

本地受限 Direct 和首次固定预检已接入同一应用二进制的无界面独立控制器。主 App 启动前写债务并在系统钥匙串托管精确胶囊；命令、当前契约及 token 仅在私有管道中交付。控制器持有真实 Child／未回收的组身份、代理和临时目录，父管道 EOF 后停止拥有的组，确认代理关闭与 temp 清理，然后 fsync 保存 HMAC 签名终态。重启核验应用根、意图、task/request/target、job 与策略摘要后才解除债务，不按历史 PID 发信号，不恢复旧命令或执行 grant。

启动输入交付后未取得 ready／终态时保持 unknown，不能由管道关闭推导 notStarted。真实预检已成功清理且控制器确认没有创建用户命令时，才签发明确 notStarted。未确认终态即时关闭当前账本门禁；即使 finish 发生在 intent 绑定之前，绑定后仍补记 uncertain。真实权限删除失败回归同时验证当前共享资源门禁和新的 begin 被拒绝。

| 最终场景 | 真实结果 |
| --- | --- |
| 本地 Wry SIGKILL | `local-crash/report.json` passed，seed=-9、reopen=0；12 项检查全部 true。真实输入并关闭命令 stdin 后 Shell 仍运行；与另一个 Node 服务同时活动后中断 App。原进程与两个确切 temp 均 absent、端口关闭、marker 仅 started；生产清理 IPC resolved=2/uncertain=0，重复调用 0/0，门禁重开，PTY 写入 0 |
| 模型已派发硬中断 | `model-unknown/report.json` passed；实际 MiniMax 生成调用并审批后中断 App。`model-recovery-result.json` 的 11 项检查 true，resourceState=confirmed、remainingResourceDebt=0。旧审批／resume 拒绝、无新模型请求，旧效果仅 started；先核验独立资源回执，再单独核对部分命令效果，没有重放或模型续跑 |
| 模型 WaitingApproval | `model-waiting/report.json` passed；旧审批失效，原命令未执行，新显式审批才执行 |
| 其他生产回归 | 三项明确选择的真实 SSH ignored tests（其中连续三轮离线）、双远端 Session、SSH App SIGKILL、Wry AppExit 与正常恢复全部通过；两个 SSH 生命周期报告 `userKnownHostsUnchanged=true` |
| 回执安全回归 | 3 passed；真实进程清理产生的签名仅接受精确 job／token，篡改 proof、回执缺失和符号链接均拒绝；回执目录精确退役可重复调用 |

最终二进制 SHA-256：`3f9c0de2596b9ffe5cb140ca64ebe1dd76795c52a1668cb6ca4790893972a8c3`。运行开始基线 `6276f5b3`，55 个源文件运行前后哈希匹配，最终工作树逐项复核无差异；HEAD 更新本身没有改变这组验收源码。process 20 passed、ownership 6 passed、local receipt 3 passed；全量 Rust **1160 passed、0 failed、66 ignored**，另集成 5 passed；前端 **2454 passed、2 skipped**。原生／前端构建、全仓 fmt、includes、AI styles、模型 catalog 和 diff check 通过，跳过项不算通过。新增控制器错误复用双语清理提示，无布局改动。

中间记录保留：首次 Node 服务失败已通过控制器自身真实 OS 预检修复；模型中断脚本要求子进程 cwd 属于项目，新控制器已使用冻结项目根；原生审计回归改用真实应用控制器，相关测试显式完成真实 OS 前置核验，不跳过生产路径。r7 全量曾出现既有终端私钥脱敏断言失败，退出竞争曾出现 unexpectedFailure；没有删除原日志或将其改写为通过。独立全量复核和七个有诊断字段的真实 AppExit 均通过，r9 完整运行也通过；间歇性失败的稳定性仍应保留后续观察，成功不能外推为全部竞争分支已穷尽。

最终历史核对：`.phase4-acceptance/stage1-local-controller-history-final-2026-10-08/report.json`，14 个有精确记录的远端目录和 12 个本地目录全部 absent，65 个债务数据库计数已保存；脚本源文件 SHA-256 同时记录。只观察实际记录的路径，没有按名称扫描临时目录、删除文件、发历史 PID 信号或读取托管密钥。没有可信胶囊／终态的旧债务仍 uncertain，目录 absent 不作为解除依据。

截至 2026-10-08，本地跨主 App 崩溃清理已在上述受限路径修复；实际 SIGKILL 窗口覆盖命令／服务运行期间，首次预检虽同样接入控制器，当时尚未单独注入该窗口的硬中断。控制器自身被强制终止、回执丢失／损坏、持久化清理失败或从未托管凭据的历史资源仍不能自动确认。Host 本地账户路径保留原有行为；敌对后代逃离进程组、同账户竞争及硬链接限制仍 partial。阶段 1 仍保留缺少证据的历史残留和第二真实普通账户验收；兼容问题排除，不据此宣布整阶段完成。

## 2026-10-09：首次预检补验与阶段 1 收尾边界

最终入口：`tests/agent-shell-sandbox-macos-ssh/verify_stage1_closeout.py`，已接入完整 `verify_stage1.py --complete-recovery`。最终证据目录为 `.phase4-acceptance/stage1-closeout-final-2026-10-09/`，基线 HEAD 为 `0bfc32af6dd65a4aa5c8aff457bb0a9d939e6260`；16 个相关源码的 SHA-256 运行前后匹配，`sourceUnchanged=true`、`binaryUnchanged=true`、`failedChecks=[]`。最终二进制 SHA-256：`ff6e42ddc52e08af5f039f68ab011a6294c6dc96cb13e382080c40635ded3dae`。

| 收尾检查 | 最终证据及范围 |
| --- | --- |
| 首次预检控制器运行时硬中断 | 独立真实 Wry 调用生产 native probe；实际控制器已收到启动输入、创建真实 workspace 和 command temp，固定 Shell 尚未 spawn，尚无签名终态。仅 debug 且精确绑定隔离 fixture 的有界屏障定位此窗口，就绪记录通过 rename 原子交付。核对实际父子进程和持久债务 1 后 SIGKILL 自有主 App，seed=-9；释放屏障后控制器执行原固定预检、清理并签名，实际控制器最终不存在。固定预检命令、胶囊及回执规则未替换 |
| 预检重启门禁与清理 | 同状态目录 reopen=0，5 项检查均 true：核验前阻止派发；生产清理 IPC 验证签名后 resolved=1、uncertain=0；重复核对 0/0；两个精确目录均 absent；重新预检可用。只记录 receipt 是否存在，不导出 token 或 proof |
| 终端私钥脱敏稳定性 | 随机真实密钥可能在原始屏幕的 `otp` 子串检测中被误判为凭据提示。现在先复用既有跨行私钥脱敏，再检测凭据提示；保留原有 OTP／Password 检测规则和整屏隐藏机制。真实 ssh-keygen 的 RSA／Ed25519、完整／未闭合密钥及多种列宽回归重复 20 轮，20/20 通过；额外断言 OTP 提示仍触发隐藏 |
| 实际 AppExit 竞争 | 最终二进制连续 20 轮，20/20 通过；17 次 gateRejected，3 次返回原生 process handle 的 nativeStarted 分支。后者仅表示原生派发入口返回 handle，不外推用户 Shell 一定已开始。每轮核对 production AppExit、资源／代理／端口终态、旧授权拒绝及单次 marker。已退役 handle 还须结合 shutdown 确认、该 task 的持久债务为 0、实际记录的 Shell PID 不存在及无完成 marker 核对，不能单凭 registry 缺失判断成功 |

本轮最初的 `.phase4-acceptance/stage1-closeout-r1-2026-10-09/report.json` 保留 20 次 AppExit 中的 5 次失败，错误均为 `Process handle was not found`。这是验收在 shutdown 已确认清理并退役 registry 后再次查 handle 的竞争，已按实际资源和账本证据修正；没有放宽生产清理门禁。后续 r2 的 20 次全通过记录保留，最终结果使用上表对应的最终二进制。此前 r7 的 `unexpectedFailure` 缺少具体错误字段，不能断言与本次失败同源；保留旧日志及有限重复观察的边界，20 次成功不证明穷尽所有退出竞争。

最终原生构建、全仓 `cargo fmt -- --check`、`pnpm check:rust:includes`、`git diff --check` 通过。Rust 全量日志为 `.phase4-acceptance/stage1-closeout-final-rust-full-2026-10-09.log`：1160 passed、0 failed、66 ignored，另 5 项集成测试 passed；ignored 不计通过，既有两项 container_backend dead-code 警告保留。本轮未修改前端或 UI 布局，未重跑前端测试、模型或 SSH 生命周期验收，之前结果只适用于其对应修订。

历史债务处理边界固定如下：

- 有精确受保护胶囊的债务，仅通过生产恢复入口核对应用根、意图、目标及控制器签名终态；无法读取、不匹配或缺失可信终态时继续 `uncertain`，派发门禁继续关闭。本轮首次预检恢复验证了这条路径。
- 没有可信拥有凭据／终态、无法补回证据的旧债务作为明确持续限制保留，不再尝试按 PID、进程名称或目录名称清理，也不因目录 absent、命令自然结束或副作用核对而解除债务。不为了收尾清空账本或恢复执行授权。
- 最终只读核对为 `.phase4-acceptance/stage1-closeout-inventory-postchecks-2026-10-09/report.json`：此前有精确记录的 14 个远端目录、12 个本地目录均 absent，128 个债务数据库计数已记录。该数量包含本轮独立 fixture，不代表 128 个未清理资源；预检的另外两个精确目录由预检报告独立确认 absent。路径观察不提供清理权限，没有读取历史托管密钥或对历史 PID 发信号。
- 当前机器仍只有一个普通账户（UID 501），没有第二个已授权普通 SSH 账户及 profile。不同真实账户验收保持待完成，不使用服务账户、不创建账户或修改系统 SSH 配置。

首次预检本次中断覆盖控制器已分配真实资源、固定 Shell 尚未启动的窗口，不证明固定预检 Shell 正在运行时的硬中断，也不证明控制器自身被强制终止后的自动恢复。阶段 1 整体仍待完成，阶段 2 门禁保持未开启；无凭据历史债务已明确为持续限制，第二真实普通账户验收仍需环境。

## 2026-10-09：收尾审核与已启动预检 Shell 中断

审核发现并修复未闭合私钥后的交互门禁遗漏：先做私钥脱敏可能同时遮蔽后续 Password／OTP 提示，不能再仅依赖遮蔽后的正文决定是否允许输入。真实 ssh-keygen 回归在修改前失败，日志为 `.phase4-acceptance/stage1-audit-unclosed-key-before-2026-10-09.log`；失败没有输出私钥。

修复复用现有正则及流式私钥边界状态，不增加私钥解析器。原始快照存在未闭合私钥时整屏隐藏并阻止输入；流式屏幕通过 `privateKeyBlockOpen` 保留状态，实际交互写入的凭据门禁同时核对此状态，滚动／缩放不清除。真实结束边界才清除流式状态；完整私钥仍局部脱敏、保留其他普通输出。新回归覆盖真实密钥后的 Password／OTP、原始快照、实际流式模型、缩放及结束边界，未闭合场景断言明确要求阻止交互，未删除安全断言。协议同步记录该字段及门禁语义。

已启动 Shell 的入口为 `verify_stage1_closeout.py --running-preflight`，最终目录 `.phase4-acceptance/stage1-running-preflight-final-2026-10-09/`。仅 debug 隔离 seed 在原 `printf native-ready` 后追加自发 SIGSTOP，将该次观察超时延至 15 秒。真实 Child 的 PID 只用于观察，脚本核对它的父控制器及实际 OS 停止状态后，对本次 Popen 主 App SIGKILL。生产预检现在轮询父控制管道的 Stop／EOF，沿用自己持有的组身份终止、核对及清理；普通预检的原有超时不变，没有扩大执行权限或从历史 PID 构造清理权限。

| 最终检查 | 实际结果 |
| --- | --- |
| 已启动的真实固定预检 Shell | `actualShellStoppedBeforeAppKill=true`，seed=-9；父管道关闭后 Shell 与控制器均不存在，两个精确目录 absent，签名回执存在。重启的 5 项检查均 true，先拒绝派发，再由生产签名核验解除 1 条债务，resolved=1/uncertain=0；重复核对 0/0，重新预检门禁开放 |
| 原启动前窗口复验 | 同一最终二进制的 `.phase4-acceptance/stage1-preflight-before-spawn-reaudit-2026-10-09/report.json` passed，5 项签名恢复／目录／门禁检查 true，resolved=1/uncertain=0 |
| 终端与退出复验 | 新未闭合私钥门禁回归 passed；原真实密钥脱敏回归重复 20 次，20/20 passed；真实 AppExit 竞争重复 20 次，20/20 passed，15 次 gateRejected、5 次返回原生 handle。退出验收继续要求持久债务及实际资源终态，不因 registry 缺失直接判断成功 |
| 最终质量检查 | 原生构建、全仓 fmt、includes、diff check passed。`.phase4-acceptance/stage1-running-preflight-final-rust-2026-10-09.log` 为全量 Rust 1161 passed、0 failed、66 ignored，另 5 项集成 passed；ignored 不计通过，既有两项 dead-code 警告保留 |

最终二进制 SHA-256 为 `b7c21990e95daaee16b1da08e7d1c960ba81bc4bc24bc789aa92b64988ae02a4`。两个最终入口的 16 个相关源码运行前后匹配，`sourceUnchanged=true`、`binaryUnchanged=true`、`failedChecks=[]`；基线 HEAD 仍为 `0bfc32af6dd65a4aa5c8aff457bb0a9d939e6260`。未创建提交、tag 或推送，未修改用户可视终端、UI 布局或前端代码，也没有重跑真实模型／SSH 生命周期。

首次运行 `.phase4-acceptance/stage1-running-preflight-audit-2026-10-09/report.json` 保留 pending：2 秒预检时限内没有取得 Shell 状态，OS 查询返回 PID 不存在，不能算作已启动窗口验收通过。该自有 fixture 已产生可信胶囊和签名终态，随后通过生产 preflight-crash-reopen 核验，原 fixture 的 `shutdown-check.json` passed、resolved=1/uncertain=0、重复 0/0；清理日志为 `.phase4-acceptance/stage1-running-preflight-audit-signed-recovery-2026-10-09.log`。没有修改最初的 pending 报告，也没有按 PID／名称补清理。

SIGSTOP 注入覆盖真实已启动、受控暂停的固定预检 Shell，不证明未经时序注入的所有运行竞争或控制器自身被强制终止后的自动恢复。旧 r7 unexpectedFailure 的原始原因仍无法从旧日志确认。没有可信凭据的历史债务继续 uncertain；第二真实普通 SSH 账户仍缺环境。阶段 1 整体保持待完成，阶段 2 门禁继续关闭。

用户随后明确授权在其 Linux SSH 主机创建普通账户用于基础验证。已创建独立 UID 1001 的普通账户，仅属于自身用户组，密码锁定，沿用用户现有 Ed25519 公钥登录；实际密钥登录、UID／home 核对、自有临时目录写入／读取及精确清理均通过。没有修改 sshd 配置或赋予 sudo 用户组成员资格，root 密码未保存到文件或日志。该环境只记为基础 SSH 验证，不具备当前远端 macOS Seatbelt 后端，不能解除阶段 1 的不同 macOS SSH 账户验收缺口或开启阶段 2 门禁。

## 2026-10-09：本轮完成决定

用户明确要求“先保持完成状态”。阶段 1 按本轮已实现、已回归及现有环境可执行的验收范围记为完成；不同真实 macOS SSH 账户因暂时没有主机而延期，待环境具备后补验，不继续阻塞本轮完成状态。Linux 普通账户仅证明基础 SSH 可用，不替代该项验收。旧 r7 原因未确认、有限时长／时序注入的证明范围及既有 partial 限制继续披露。

该完成决定不改写原始报告、测试结果或历史失败，不把忽略项记作通过，不解除缺少可信凭据的 uncertain 债务，也不修改任何生产派发、审批或恢复门禁。阶段 2 仍待单独前置复核、实施与验收，本次不启动阶段 2。
