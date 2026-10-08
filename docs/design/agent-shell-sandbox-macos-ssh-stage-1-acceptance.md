# macOS 与 SSH 完善阶段 1：异常恢复与资源归属

日期：2026-10-08。状态：本轮修复、回归和可执行的真实验收已记录，阶段 1 整体验收待完成。此记录属于 [macOS 与 SSH 完善计划](agent-shell-sandbox-macos-ssh-completion-plan.md)，不替代此前编号阶段的验收记录。

## 修订、环境与证据

- 基线 HEAD：`689509decac0d39efbf08cf180d9e237d3212a86`，加本次未提交工作树。最初仅完善计划文件未跟踪；没有覆盖其他工作树改动，没有 commit、tag 或推送。
- 环境：macOS 26.7.1 / 25G241、arm64，Rust/Cargo 1.95.0、Node 24.21.0。SSH 为普通账户在 loopback 上启动的独立自有 sshd，密钥、known_hosts、项目和数据库由 fixture 创建；没有使用用户服务器或修改系统 SSH 配置。
- 当前最终运行目录：`.phase4-acceptance/stage1-four-remaining-r2-2026-10-08/`。`report.json` 保存 46 个源文件 SHA-256、基线修订、命令退出码与实际 Wry 二进制 SHA-256，`sourceUnchanged=true`，所有本轮执行检查退出码为 0。下文早期记录保留其当时结果，不替代本文末尾的当前修订证据。原始日志、独立 App 报告与事实 JSON 均在已有忽略目录，不纳入 Git。
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
