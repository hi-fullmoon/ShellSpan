# Agent Shell 沙箱阶段 5：验收要求与证据对照

> 状态（2026-10-07）：验收进行中，整体未完成。阶段 2、3、4 仍在修改；本记录核对真实日志、当前实现和证据范围，并完成授权范围内的日志/导出局部修复，不代表全部最终修订已回归或正式发布。没有修改版本、运行 release:prepare、创建 commit/tag 或推送。

本轮以实施计划中用户批准的常规原生进程契约为准。macOS 保留原项目目录和工具链，Seatbelt 能力为 partial；既有硬链接别名、宿主同账户恶意竞态和恶意后代生命周期限制如实披露。旧报告要求完整文件对象隔离的门禁不再作为本版完成条件，但剩余路径、网络、授权、正常进程控制和无无限制回退仍须逐项实测。禁止重试此前安全检查中止的攻击反例。

## 证据规则

- “已核对”指本轮读取了对应原始日志或 JSON 的必要摘要；不是本轮重新执行。原始报告保留在表中指定路径，临时目录可能被清理，交付前应保存脱敏摘要和可复现入口。
- 原生链、真实模型回合、组件浏览器检查、常规测试、受限执行各自只证明匹配范围。普通构建成功不证明隔离；独立 Wry 窗口不证明主工作台全部状态；元数据访问不证明完整依赖安装。
- 失败区分实现不足、证据不足和缺环境。ignored、skipped、filtered 不是通过。没有真实请求的模型轮次不计验收。不得全局过滤失败制造绿色结果。
- 代码仍在变更，最终记录必须补充对应修订范围、执行时间、命令、退出码、结果摘要、能力和清理事实；本轮无法为共享未提交工作树给出稳定 commit 身份。

## 原计划五项要求对照

| 要求 | 已核对的匹配证据 | 当前结论 | 稳定后所需验收 |
| --- | --- | --- | --- |
| 实测代码阅读、pnpm/cargo 构建测试、依赖下载、本地服务、日志诊断、SSH 部署 | 下方日常任务矩阵：macOS 构建、普通模型、pnpm/cargo 实际依赖下载并执行、原生只读真实日志、授权网络和 Vite 服务有真实结果；完整受限系统测试仍有失败 | 部分通过，整体未完成 | 补 Host SSH 实际部署及受限 SSH 后端各自证据、模型诊断解释和最终相关回归；不把宿主能力测试全部强行放入受限契约 |
| Rust/前端回归、build、fmt、协议/IPC | 现有普通 Rust 1199 passed / 66 ignored，5 integration passed；前端 2573 passed / 2 skipped；build、includes、styles、catalog 成功 | 此前修订通过部分常规检查；全仓 fmt 有既有差异，最终修订未验证 | 实现稳定后运行受影响回归、协议/IPC 契约、build、fmt；保留真实失败与任务外差异 |
| 取消、超时、恢复、撤权、后台、不可用、多会话并发 | 真实模型后台取消、原生资源租约/撤销、GUI revoke；普通并发 temp/cache 与多层 Shell；同引擎两会话缓存 grant 隔离、checkpoint 重建需重新批准、正常进程/本地服务 shutdown | 明确资源的正常路径通过；应用恢复门禁与所有失败分支证据不足 | 分别验证未确认清理、完整恢复不扩权、不可用不派发、停止新 admission 与不自动 Host 续跑；不把引擎重建外推整个应用 |
| 设置、审批、工具结果一致；日志/导出不泄敏感信息 | 模型 session scope 复用与 GUI revoke JSON requests=5/nativeResults=2/PTY=0；既有双语浏览器记录；env 清理局部断言 | 文件授权局部通过；新增策略切换/资源 audit/完整导出尚未验收 | 真实主工作台或明确范围的生产组件 IPC、双语/键盘/宽窄、网络和缓存 scope/revoke、审计及导出全链检查 |
| 平台限制与回退 | 平台限制见后文；本地 partial；真实 Wry 正常/未确认/活动 AppExit 场景已验证指定入口关闭、资源清理、失败结果保留与无 Host 重放 | 指定关闭协调场景通过；实际版本回退、子 Agent Registry 及完整应用恢复尚未验收 | 完成子 Agent/driver 直接入口配套检查、最终受影响回归及远端生产链；不把关闭场景当已部署版本回退 |

## 日常任务与真实证据

| 场景 | 原始证据与已核对结果 | 证明范围与剩余事项 |
| --- | --- | --- |
| 代码阅读与普通修改 | `/tmp/shellspan-real-model-y2xHvP/model-check.json`：passed=true、requests=2、nativeResults=1、sourcePtyWrites=0、turnEndReason=completed | 真实 MiniMax-M3 经审批和 Seatbelt 创建/读取测试文件；不代表全部阅读工具或主工作台状态 |
| 本仓库受限 pnpm build | `/tmp/shellspan-env-local-native-build.json`：result.exitCode=0、terminationConfirmed=true | 根目录 .env.local 只读例外下构建成功；不能扩大为其他敏感文件允许或全部测试通过 |
| 本仓库受限 cargo check/build | `/tmp/shellspan-macos-native-cargo-check.json`、`/tmp/shellspan-macos-native-cargo-build-final.json`：均 exitCode=0、state=exited、terminationConfirmed=true，stdout/stderr 未截断 | 本轮读取对应摘要；历史构建范围独立于最终共享修订与受限测试，不外推为全量测试通过 |
| 普通小项目 pnpm/cargo 测试 | 当前 `tests/macos_direct.rs::native_workspace_scoped_autopilot_executes_ordinary_build_test_and_modification`；阶段 2 报告记录 1 passed | 已有报告证据，待稳定后核对或重跑对应日志；不能替代完整仓库 |
| 普通 Rust crate 受限测试 | `/tmp/shellspan-phase2-native-ordinary-rust.json`：exitCode=0、terminationConfirmed=true，单项实际测试 passed | 已核对真实摘要；这是普通 offline crate 行为，不替代本仓库宿主能力套件 |
| 本仓库受限 pnpm test src scripts | `/tmp/shellspan-phase2-native-full-frontend-signal.json`：exitCode=0、terminationConfirmed=true；294 files passed / 1 skipped；2573 tests passed / 2 skipped，58.08s，stdout/stderr 未截断 | 本轮核对新增真实受限调用摘要，同沙箱 worker signal 修复后该命令通过。范围为 src/scripts，不能改称未限定目录命令或最终共享修订已回归；旧 EPERM 失败已由此对应修复 |
| 完整仓库受限 cargo test | `/tmp/shellspan-phase2-native-full-rust.json`：exitCode=101；1079 passed / 124 failed / 67 ignored | 网络、PTY、嵌套沙箱等系统测试需逐类核实契约和环境要求；不能推导普通 cargo 项目均失败，也不能过滤全部失败算通过 |
| 公网访问与目标拒绝 | `/tmp/shellspan-network-production-acceptance.log`：`native_direct_network_authorization_dispatch_and_cleanup` 1 passed；已读当前测试的 curl、pnpm view、git ls-remote、非授权目标拒绝、单次 token 不可重用及代理取消断言 | 生产批准/签发/代理真实路径已覆盖；仅 TCP host/port 和实际地址范围，不证明 HTTPS 内容、路径或同目标 redirect 限制 |
| 完整依赖下载与执行 | `/tmp/shellspan-phase5-workflows-v3.log`：approved_locked_pnpm_install、approved_locked_cargo_fetch 两项真实通过；整轮为 2 passed / 2 failed，另外会话/诊断 fixture 的后续通过记录单列 | 生产批准→签发→Seatbelt/代理；空独立缓存，真实锁文件，pnpm 下载/执行 is-number 7.0.0，Cargo fetch 后离线构建/执行 itoa 1.0.15；锁不变、connectionsStarted>0、代理关闭、源 PTY 0。只批准 npm 或 index/static.crates.io:443 与 cache writePaths，解析器 cloudflare 显式进入审批/签名。Cargo 请求显式 CARGO_HTTP_PROXY 接已有 Unix SOCKS5，不推广任意来源/runtime；锁准备及 pnpm view 不计下载成功 |
| Node 本地服务与 Vite | `/tmp/shellspan-vite-service-acceptance.log`：`native_direct_vite_service_retains_pnpm_dev_command` 1 passed；当前测试以 pnpm dev 启动、真实文件 probe、会话复用、取消/到期和所属端口释放断言 | 覆盖 Node Unix 服务端到应用 loopback TCP 转接；不代表任意语言或监听所有网卡均支持，不把允许监听等同于外连 |
| 明确缓存 writePaths | `/tmp/shellspan-phase3-cache-native.log` 1 passed；最新 `/tmp/shellspan-phase5-cache-model-6nNARJ/model-check.json` 真实M3 passed=true / requests=5 / nativeResults=2 / PTY0 | 原生一次/会话/到期/撤销与实际模型 first approval→session复用→production revoke后重新审批各有对应证据；旧 requests=0 不计通过也不覆盖新结果。UI最新设置/audit组合仍逐项验 |
| 日志诊断 | `/tmp/shellspan-phase5-session-diagnostic-v5.log`：真实 Node MODULE_NOT_FOUND 写到自有 diagnostic.log，再由实际新建 readOnly Session 的冻结/签发/Seatbelt 执行读取，stdout 与文件原文相等；两项专项通过 | 证明真实正常日志错误读取和结果一致、PTY0；没有真实模型诊断解释或主工作台完整交互，不能将原生读取外推为模型理解正确 |
| SSH 原生绑定、Host 命令与 HTTP 传输 | 阶段 4 证据摘录的真实绑定/Host 测试 2 passed、目标 loopback HTTP 1 passed、双向传输 1 passed；来源 chunk 和准确范围见下方 | 证明指定 SSH 链路，不代表实际部署；新 Mac restricted NativeAdapter 证据单列，不从旧 Host 证据推导。Host 取消未确认远端 PID 终止时准确保留 terminationUnconfirmed，之后观察普通有界进程自然退出 |
| Mac SSH 生产 installedSlot NativeAdapter | `/tmp/shellspan-phase4-wry-a0csD1/remote-check.json`：passed=true，真实 Wry、共享 Runtime/engine、目标 macOS、capabilityFacts=partial、sourcePtyWrites=0；签发/审批/文件结果持久化、stdin/kill清理/断线旧审批拒绝均 true | 已核对 JSON 与 `remote_native_check.rs` 实际 prepare_sandbox / installedSlot / execute 代码；不是模型回合或 UI render，非所有远端平台、网络/外部资源授权、重启恢复或部署验收 |

## 生命周期与权限一致性

| 项目 | 原始证据 / 当前实现 | 验收范围 |
| --- | --- | --- |
| 真实后台取消 | `/tmp/shellspan-real-cancel-VOz6up/model-check.json`：passed=true、requests=1、processLifecycle=cancelled、terminationConfirmed=true、sessionEnded=true、sourcePtyWrites=0 | 正常 sleep 后台进程与生产 cancel；不承诺恶意后代完整树清理 |
| 会话授权复用与恢复失效 | `/tmp/shellspan-session-model-CGfafR/model-check.json`：passed=true、requests=5、nativeResults=2、PTY=0；阶段 3 报告描述重启后重新审批 | 真实模型同文件复用/撤销后重新审批；恢复重绑、账户变化及跨会话全组合仍需补验 |
| 同一引擎的会话缓存授权隔离与恢复 | `/tmp/shellspan-phase5-session-diagnostic-v5.log`：2 passed 包含真实两 Session 的 cache grant；`/tmp/shellspan-phase5-session-recovery-final.log`：追加 checkpoint 重建引擎后的实际 prepare/未批准签发拒绝，1 passed | A 资源批准不使 B 无需批准；两者独立批准后实际写缓存。取消 A 后 A 需重新审批，B 仍可原生写入；checkpoint 新引擎无旧 grant，实际请求重新需批准。仅明确缓存写资源与该原生链，不推广全部资源类型/GUI/账户重绑 |
| 真实 GUI revoke IPC | `/tmp/shellspan-native-revoke-tuQiHq/model-check.json`：passed=true、requests=5、nativeResults=2、PTY=0 | 独立 Wry 挂载生产 AiSandboxSettings、生产 get_session/revoke IPC；不能替代主工作台控制器全状态验收 |
| 正常链接、多层继承、并发 temp/cache | `/tmp/shellspan-phase2-normal-closure.log`：3 passed；包含 phase2_normal_links_and_nested_shell_inheritance、phase2_normal_worker_signals_stay_within_same_sandbox、phase2_normal_concurrent_command_temp_and_cache_are_independent | 正常内部链接读写、外部普通目标拒绝、悬空链接、多层 Shell、同沙箱 worker signal 与同名临时缓存并发；仅两个命令并发，不证明多个 Agent 会话授权隔离 |
| 不同受限调用的信号边界 | `/tmp/shellspan-phase2-independent-signals.log`：1 passed | 已读阶段 2 当前测试范围：第二份受限调用不能 signal 0 第一份正常 worker，自身 worker 可 SIGTERM 清理；不扩展为所有资源 grant 隔离或恶意后代保证 |
| timeout/stdin/租约到期 | 阶段 2 的真实 background/stdin/deadline 报告；当前网络/服务/cache 原生测试断言 | 分别保留普通进程控制和代理关闭范围；最终稳定后补精确日志及重新核对 |
| 应用退出/重启 | 阶段 2 历史容器 GUI 5/5、归属记录与清理债务 | 只证明容器归属协调层；不外推为 Mac 原生生产主工作台退出/重启全部资源已清理 |
| 空闲策略切换与记忆 | 阶段 3 正在追加实现 | 未验收；须证明有活动后台拒绝切换、空闲成功、默认记忆只含非敏感配置、恢复不保存授权 |
| unavailable 与非 Shell 工具 | 当前远端检查不自动安装或开放执行；MCP/SFTP/部署须独立能力检查 | 最终须按各工具校验拒绝路径与 source PTY 零注入；不将 Shell 沙箱保护扩展到所有工具 |

## 常规质量检查快照

这些日志均已读取，属于此前修订，待阶段 2–4 稳定后按变更范围更新。

| 日志 | 结果 | 限制 |
| --- | --- | --- |
| `/tmp/shellspan-phase3-frontend-final.log` | 294 files passed / 1 skipped；2573 tests passed / 2 skipped | release 回归负例的 manifest 错误输出不等于 suite 失败；跳过不计验收 |
| `/tmp/shellspan-phase3-rust-final.log` | 1199 passed / 66 ignored / 0 filtered，5 integration passed | ignored 的网络/平台验收需显式执行；不是受限环境全量结果 |
| `/tmp/shellspan-phase3-build-final.log` | TypeScript/Vite 构建成功 | 保留原有大 chunk 与 mixed import 告警 |
| `/tmp/shellspan-phase3-fmt-final.log` | native/mcp.rs:754 差异 | 既有任务外差异；不能写全仓 fmt 已通过，不擅自改动 |
| `/tmp/shellspan-phase2-normal-format.log` | 当轮新增 macos_sandbox.rs 测试另有格式差异 | 此日志早于修订，须核对最新文件与 fmt 结果，不能隐藏 |
| `/tmp/shellspan-phase3-includes-final.log` | 47 include 文件通过 | 不替代全仓 fmt |
| `/tmp/shellspan-phase3-styles-final.log` | AI style boundaries 通过 | 不替代实际布局检查 |
| `/tmp/shellspan-phase3-catalog-final.log` | 55 exact models validated、4 negative fixtures rejected | 不替代沙箱协议/IPC 契约专项 |

## 日志与导出脱敏要求

本轮只提取 JSON 中的请求数量、结果数量、退出码、取消/结束布尔值等必要事实；未显示原始 env、模型配置、配置文件正文、认证窗口或 keychain 内容。现有日志不含泄露迹象不能证明完整导出链已安全。

实际入口与序列化审计：

- 诊断包：`log-panel.tsx::handleDiagnosticBundle` → `diagnostic-bundle.ts::buildDiagnosticBundle` → `redactTerminalSecrets(selectedLog.content)` → `JSON.stringify` → `invokeExportLogFile` → `commands.rs::export_log_file` → `log_export.rs::write_redacted_export` → `fs::write`。最终保存边界以 serde_json 解析结构化 JSON，复用 `redact_json_value`；普通文本复用 `redact_sensitive_text`。
- 普通日志：`log-panel.tsx::handleExport` 发送所选 `content`，现在经过同一个生产脱敏保存函数。新增测试实际写入/读回独立临时文件，覆盖文本、JSON 及真实写失败；没有保存窗口或 IPC 成功替身。保存窗口交互未实测，不能将 helper 落盘等同于全 UI/IPC 验收。
- 前端 logger：生产 `formatLogRecord` 对 module/message 脱敏，structured details 复用 `redactSensitiveValue` 后序列化，Error stack 与文本细节保留原脱敏。自有标记回归直接执行生产 formatter，不制造 console/plugin 成功响应。
- 共享字段分类：Rust 与前端保持 normalized 敏感后缀语义，覆盖 prefixed env、CamelCase API key、cloud secret/access key；credential/credentials 继续精确匹配，credentialReference、operationId、诊断状态保留。没有自编 JSON 解析器、读取真实凭据或删除必要诊断。
- Agent 事件持久化：`session.rs` append 经 `sanitize_event` → `redact_json_value` → `encoded_events`；已有真实独立目录持久化回归检查 bearer 移除、taskId/messageId 保留和恢复。这与诊断包/普通日志是独立链，不自动等于所有导出入口已通过。

主会话已授权局部修复。新增 `src/lib/__tests__/sandbox-phase5-diagnostic-export.test.ts`、`src-tauri/src/log_export.rs`；修改全局 `src-tauri/src/commands.rs` 的保存调用、全局 `redaction.rs` 的敏感字段分类，以及前端 `logger.ts` / `terminal-output-buffer.ts` 的对应脱敏。没有修改 Agent 源码、UI 或 lib.rs 注册，也没有全文件格式化。相关测试与构建结果见追加记录。

稳定后应沿用生产审计、会话持久化和实际 `export_log_file` 调用链，核对策略/资源变化能追踪且不持久化可重用 grant；检查日志、事件、错误、会话记录、导出产物的凭据与敏感环境处理。采用真实隔离会话和现有 credential reference，不导出真实 secret、不打印敏感匹配行、不修改钥匙串 ACL。若无法安全验证某项，记录未覆盖范围，不能把扫描零命中当作完整保证。

## 平台限制与回退说明草稿

| 环境 | 本版准确说明 | 当前验收状态 |
| --- | --- | --- |
| macOS 本地 Direct | Seatbelt 原目录/工具链；常规路径和网络约束；准确报告 partial，已知硬链接/同账户竞态/恶意后代限制 | 部分真实场景通过；最终 Mac 门禁待独立闭合 |
| Windows 桌面 | 后续按同一常规契约接入与实机验证 | 缺 Windows 环境，不标通过，不挡 Mac 独立验收 |
| Linux 桌面 | 不属于当前桌面交付目标 | Docker/Linux 历史实验不当作 Mac/Windows 验收或产品迁移授权 |
| 远程 SSH | 隔离必须在目标实施；Host 使用账户权限并明确未隔离；检查不等于执行 | Mac SSH provider、NativeEngine、installedSlot NativeAdapter 的指定正常/拒绝/控制链已有证据；实际 UI 目标验证/可选与更多异常/平台仍需验收。Docker bwrap namespace 失败另记，不以此代 Mac 验证，也不宣称所有远端开放 |
| 普通可视终端 | 既有终端未受限；不注入受限命令 | 受限 Direct 证据不使普通 PTY 自动受保护 |
| TCP 网络代理 | 精确公开 host/port 与实际地址范围；TLS 由客户端验证 | 不承诺 HTTPS 内容、路径或同一目标内 redirect 规则；其他目标须单独授权 |
| 本地服务 | Node 服务经应用 loopback TCP 与 Unix 端点转接 | 只接受已实现的监听模式和授权端口；不宣称任意程序兼容 |

回退验收采用以下顺序，实际执行结果仍待记录：

1. 停止新建和派发受限执行，保留可读失败原因及原策略事实。
2. 对已有任务执行正常取消、代理/本地端口关闭和所属资源清理；只清理明确属于自身的资源。
3. 无法确认停止时保留不确定状态与清理记录，继续阻止新执行；恢复仅做核对/清理，不恢复 grant、不重放命令。
4. 不自动切 Host、不自动续跑受限命令、不自动 sudo；用户选择 Host 后仍需形成新请求并保留审批与审计。

## 后续验收顺序与文件范围

1. 等待阶段 2–4 提供稳定通知及更新报告。阶段 3 的旧网络原型、旧资源拒绝和旧未完成清单与新实现存在时间差，应由所属会话同步；本阶段不修改它们。
2. 保留本次受限 pnpm src/scripts 成功范围，继续核对 cargo 失败分类并补最终受影响质量与协议/IPC 回归；不重跑已中止攻击反例、不使用 mock 模型或 backend。
3. 补真实缓存模型回合、依赖下载、日志诊断、策略切换/记忆、scope/revoke/audit/导出、多会话及恢复不扩权；UI 仅检查已指定区域。
4. 利用已到位的独立 SSH fixture 单独验收 Host 实际部署与远端受限生产执行链；Windows 实机单列后续清单。不得用已有 provider smoke 或传输检查代替目标 admission。
5. 只在证据闭合后更新最终结论和对应阶段清单。本轮专属可编辑范围为本文件；新增验收入口或共享源码修复须先由主会话协调，避免与阶段实现并发覆盖。

阶段 5 五项原清单均保持未勾选。发布说明与回退内容目前为可审阅草稿，尚未执行发布或回退。

### 独立开发工作流追加结果

专属入口 `src-tauri/src/agent_runtime/tests/developer_workflow.rs`，仅在 `tests/macos_direct.rs` 末尾注册；真实 fixture 和使用方式位于 `tests/agent-shell-sandbox-phase-5/README.md`。锁文件由真实 pnpm/cargo 生成，不手工制造解析结果。受限实际执行始终使用已规范化的冻结 cwd，不削弱原生目标或签名检查。前期测试 fixture 不匹配 cwd 和错误手改单字段策略导致的拒绝已修正；实际产品检查保持拒绝语义。

- `/tmp/shellspan-phase5-workflows-v3.log` 中两个下载场景实际通过；整轮仍为 2 passed / 2 failed，不能直接称整文件绿色。另两项经实际 Session/普通命令修正后的成功证据来自 v5 与 recovery-final，未重复公网下载。
- `/tmp/shellspan-phase5-session-diagnostic-v5.log` 两项通过：会话 grant 隔离、真实只读日志读取。
- `/tmp/shellspan-phase5-session-recovery-final.log` 单项通过：重建引擎不仅状态无 grant，而且真实 prepare 后未批准签发被拒绝。
- `/tmp/shellspan-phase5-shutdown-native.log` 单项通过：正常 Seatbelt 后台已实际写 marker；生产 prepare_for_shutdown 清理计数 1、终态和 terminationConfirmed；新引擎无旧活动进程、marker 没有重放、sourcePTY=0、Session 仍为 Workspace。只证明关闭清理组件；它不承担 runtime.stop_admission，也不证明实际版本回退或全应用恢复门禁。

`/tmp/shellspan-phase5-service-shutdown-native.log` 单项通过：真实 Node 本地服务 HTTP 正文匹配项目文件，关闭前端口实际占用；生产 prepare_for_shutdown 清理计数 1，进程终态/terminationConfirmed、代理 closed、所属回环端口可重新绑定；新引擎无旧 localServices 或活动任务、sourcePTY=0。此项为主动正常 shutdown，不称为 expiry/revoke。

`/tmp/shellspan-phase5-multi-session-services.log` 单项通过：同引擎、两个真实 Session、两只独立签发本地服务各先取得实际 HTTP 正文；cancel_task(A) 后 A 终态/terminationConfirmed/代理关闭/端口释放，而 B 继续 running、代理开启、实际 HTTP 可读且端口占用；随后 prepare_for_shutdown 清理剩余 B（计数 1），B 终态/terminationConfirmed/代理关闭/端口释放。仅证明正常任务级取消和主动 shutdown 不混淆所属服务；没有制造清理失败响应或推广全部多会话资源。

最终应用级停止新受限派发、恢复与版本回退仍需真实生产 Runtime/Tauri 路径证据，不通过测试布尔开关或伪后端替代。所有独立场景已将确认清理与尚未确认的路径分开；没有实际执行版本回退、部署或发布。

## 阶段 4 原始工具输出摘录核对

2026-10-07 本轮读取以下证据文件，并核对对应当前测试源码。首轮 stdout 未重定向，文件为注明来源的工具报告摘录，不能称为完整原始日志、本轮重新执行或完整测试过程留档。

| 证据文件（相对仓库根） | 原始来源 | 已核对结果与范围 |
| --- | --- | --- |
| `tests/agent-shell-sandbox-phase-4/evidence/ssh-binding-native-output.log` | unified exec chunks `05515c` / `89918`，completion `9640ad` | 2 passed：真实 SSH reconnect、disconnect、账户/认证/jump reference 变更后旧审批失效；恢复相同账户/认证/reference/timestamp、删除重插相同 ID、新 Database 连接也不恢复旧绑定。Host 原生审批/Direct 取消观察远端真实 PID 残留，terminationConfirmed=false、terminationUnconfirmed，随后自然退出；source PTY 零写入。后端 nonce 仅覆盖当前应用 Database.conn 所有 profile 写入，独立外部 SQLite 连接属于未覆盖宿主竞态范围 |
| `tests/agent-shell-sandbox-phase-4/evidence/ssh-http-native-output.log` | unified exec session `19836`，completion `c9011c` | 1 passed：生产 execute_http_probe_native 经真实 SSH 到目标 loopback，实际 HTTP status=200、body 为目录页、networkScope=targetLoopback；不把远端 loopback 读探测称远端受限执行 |
| `tests/agent-shell-sandbox-phase-4/evidence/ssh-duplex-native-output.log` | unified exec session `70046`，completion `8697e4` | 1 passed：专用 scoped loopback 传输实际双向、半关闭、2MiB payload/backpressure、取消与 deadline；不推广一般用户 forward 或文件/网络隔离 |
| `tests/agent-shell-sandbox-phase-4/evidence/macos-ssh-seatbelt-native-output.log` | unified exec session `18118`，completion `730e57` | 真实 OpenSSH CLI structured stdout：authenticated/realSshSeatbelt/projectReadWrite/outsideReadWriteDenied/liveLoopbackNetworkDenied 均 true。保留自有 OpenSSH 的 BSM audit warning。仅 provider feasibility/smoke，未经过生产 NativeAdapter/远端 restricted admission，不计远端受限门禁通过 |

Host 真实命令与传输的成功证据不等于部署成功，SSH 部署清单仍未完成。阶段 4 新生产后端到位后必须另用实际批准、冻结绑定、签发、派发、结果及生命周期链验收。

## 本轮导出修复验证结果

| 执行 | 真实结果 | 范围 |
| --- | --- | --- |
| `pnpm test src/lib/__tests__/sandbox-phase5-diagnostic-export.test.ts src/lib/__tests__/diagnostic-bundle.test.ts src/lib/__tests__/logger.test.ts src/lib/terminal/__tests__/terminal-output-buffer.test.ts --reporter=dot` | 4 files / 26 passed；`/tmp/shellspan-phase5-export-frontend.log` | 新增 3 项无 mock 的 serializer/formatter 检查；既有 logger 回归使用原有 console spies，不作为真实日志落盘证明 |
| `cargo test --manifest-path src-tauri/Cargo.toml commands::log_export::tests` | 3 passed；`/tmp/shellspan-phase5-export-rust.log` | 生产保存函数真实文件写入/读回，普通日志、JSON 诊断、目录写失败。自有 secret/bearer/prefixed env/CamelCase/cloud 标记均不落盘；诊断 metadata 与 reference 保留 |
| `cargo test --manifest-path src-tauri/Cargo.toml redaction::tests` | 8 passed；`/tmp/shellspan-phase5-redaction-rust.log` | 既有通用脱敏/Markdown/secret reference 兼容 |
| `cargo test --manifest-path src-tauri/Cargo.toml redacted` | 9 passed；`/tmp/shellspan-phase5-event-redaction-rust.log` | 包含 Agent 持久化、模型上下文、artifact 与部署 audit export 的既有专项；不把所有既有测试当作全流程原生证据 |
| `pnpm build` | 退出 0；`/tmp/shellspan-phase5-export-build.log` | 当前共享工作树 TypeScript/Vite 构建；保留已有 chunk/mixed-import 告警 |
| `rustfmt --edition 2021 --check src-tauri/src/log_export.rs src-tauri/src/redaction.rs`、`git diff --check` | 退出 0 | 局部格式检查；不替代全仓 fmt 或阶段 2–4 最终回归 |

真实落盘结果证明最终写入边界的脱敏和诊断保留。Tauri 保存窗口与 UI 发起至实际保存的整体交互本轮未执行，仍不得表述为完整 GUI 导出闭环通过。敏感 env 采用标准命名语义，不能承诺识别无名称、无已知格式的任意秘密文本。

## 全局关闭门禁真实 Wry 验收（指定三个场景通过，Registry 单组件另已核对）

2026-10-07 已读取并执行新增 `shutdown_admission.rs`、Runtime async shutdown 与 AppExit 的生产接口：单向 closed 状态、真实 active lease 与 drain、共享 ShutdownOutcome。首轮公共 create/approve 缺漏已修复并真实复测；子 Agent 直接 Registry attach/driver 的新增保护另待配套验证，不外推当前证据。编译成功不计验收。

独立文件 `native_shutdown_check.rs` 已通过既有 debug-only native_agent_check 的专属早期 hook 注册并运行真实 Wry App，使用隔离数据库、真实 SessionManager 和生产 NativeToolAdapter，与 Runtime 共享同一原生引擎；完全分流到模型配置初始化之前，不读取真实模型凭据、不调用模型或伪 provider。独立检查 credential manager 仅用于自身原生签名条目，不打开用户共享 credential vault，不改 ACL。普通真实 MiniMax provider 元数据仅用于验证关闭 guard 在 start 前拒绝，没有 API key 或请求。

| 场景 | 必需的真实可观察结果 |
| --- | --- |
| 正常全局关闭 | 已批准后台与 Node 本地服务先实际启动、HTTP 正文正确；生产关闭确认全部所属进程/代理/端口清理；源 PTY 零注入、项目 marker 不重放、策略不转 Host |
| 新建、start、审批、派发 | 包含其他 Session 与新 Session，关闭后各入口返回明确关闭拒绝；不能用“一个结束 Session 拒绝 submit/start”代替全局验证 |
| 已准备与已签发请求 | 关闭前通过实际批准链准备和签发，关闭后生产 NativeAdapter execute/低层 signed launch 均无新 marker；opaque token 只在内存中使用，不写报告 |
| 启动与关闭并发 | 对真实 lease/start/dispatch 与关闭的竞争记录事实；关闭前已经获准的操作最终被清理，关闭后的操作不得产生新资源；不用测试布尔变量替代门禁 |
| 未确认 drain/cleanup | 用实际持续 lease 或正常未结束操作触发真实确认超时，不伪造操作系统结果，不重试历史攻击；结果必须为未确认/失败且 gate 仍关闭 |
| 幂等与恢复 | 相同关闭过程的重复调用共用结果，失败也不重开；引擎重建无旧授权只是组件证据，完整应用恢复与版本回退另验，不实际部署旧版本或执行发布命令 |

### 首轮实际结果

| 实际 Wry fixture 与报告 | 结果 |
| --- | --- |
| `/tmp/shellspan-phase5-wry-normal-v2-zERc9c/shutdown-check.json`；`app-exit-events.json` | passed=false，模型请求 0、源 PTY 写入 0；14 项 checks true，newSessionRejected 与 approvalEntryRejected 为 false。正常 shutdownOutcome confirmed=true、cleaned=2，重复关闭同结果。真实 PID 19706 两次 ExitRequested 后 Exit，进程退出 1 |
| `/tmp/shellspan-phase5-wry-undrained-ZsRlvx/shutdown-check.json`；`app-exit-events.json` | passed=false，同两公共入口 false，其他 14 项 true。真实 lease 保留到生产 drain 超时，shutdownOutcome confirmed=false、error=Shutdown dispatch remains unconfirmed；lease 释放后重复关闭仍返回相同错误，gate 仍关闭。模型请求 0、PTY 0；真实 PID 20386 两次 ExitRequested 后 Exit，进程退出 1 |

已确认范围：start、新 NativeAdapter prepare、关闭前实际准备的 Adapter token、关闭前实际批准签发的低层 capability 在关闭后都被 gate 拒绝；没有新副作用 marker、没有 Host 自动续跑；实际已运行后台与 Node HTTP 服务经过生产 Runtime.shutdown 后终态/terminationConfirmed、代理关闭、所属回环端口释放，策略保持 Workspace。持有真实 admission lease 与关闭 worker 并发，仅证明该租约/drain 场景，不外推所有启动竞争组合。

首轮不足：关闭后 create_session 仍成功；公共 approve_tool 入口没有在 lookup 前返回统一关闭错误。后者输入为公共审批 API 请求，没有伪造模型注册审批事件，不能据此宣称真实 model pending approval 越权执行；有效 pending 请求证据由独立 Adapter token 和已签发 capability 提供。两处已交对应生产 source owner 最小修复。

create_session、approve_tool / approve_tool_scoped 的保护已加入生产源码。专属 hook 补实际第三 Session 的有效 Adapter 派发与关闭 Barrier 竞争，保留 racedDispatchOutcome，不用手持 lease 替代全部启动竞争。`/tmp/shellspan-phase5-wry-shutdown-check-v5.log` cargo check 7.08s、`/tmp/shellspan-phase5-wry-shutdown-build-v6.log` build 51.55s 成功，仅为编译证据；对应真实复测如下。

### 修复后的两个真实场景

| 实际报告 | 结果与证明范围 |
| --- | --- |
| `/tmp/shellspan-phase5-wry-normal-final-P3z5Rm/shutdown-check.json`；同目录 app-exit-events.json | passed=true，17 checks true；modelRequests=0、sourcePtyWrites=0；正常生产 shutdown cleaned=2 / confirmed=true；旧 pending Adapter token、旧已签发 capability、新建、start、prepare、公共 approve 入口全部关闭拒绝；两个实际资源终态/confirmed、代理关闭、端口释放、marker 不重放、策略仍 Workspace、重复结果相同。PID 23709 两次 ExitRequested 后 Exit，进程退出 0 且 ps 确认不存在 |
| `/tmp/shellspan-phase5-wry-undrained-final-FMSCDT/shutdown-check.json`；同目录 app-exit-events.json | passed=true，17 checks true；modelRequests=0、sourcePtyWrites=0；实际租约未及时释放引起 confirmed=false / Shutdown dispatch remains unconfirmed，重复调用保留相同错误，gate 不重开；正常资源清理与所有入口拒绝同上。PID 23708 两次 ExitRequested 后 Exit，进程退出 0 且 ps 确认不存在 |

两次 racedDispatchOutcome 实际均为 gateRejected；这两次排程证明该实际竞争中的拒绝且无 race marker，不冒充“所有已获准后并发启动分支”或复杂并发压力证明。场景中原先两个已运行资源实际被清理，不能将此替代未发生的 raced nativeStarted 分支。

上述两个 App 的首次资源清理由显式 Runtime.shutdown 发起，AppExit 是后续实际退出事件与幂等复用，不能称为“AppExit 首次触发活动资源清理”。此项已由新场景单独补验，未重跑两个已有 17 checks 或七个独立场景。

### 真实 AppExit 首次活动清理

`/tmp/shellspan-phase5-wry-exit-active-final-9RaEiz/shutdown-check.json`：passed=true、19 checks true、shutdownInitiator=productionAppExit、modelRequests=0、sourcePtyWrites=0、shutdownOutcome cleaned=2 / confirmed=true。两个资源被确认实际 running 后才调用 handle.exit；生产 AppExit 首次关闭 gate 并开始资源清理，在观察实际 gate 关闭和两个资源终态之前验收代码没有调用 Runtime.shutdown，之后仅 join 已发起的同一结果。旧 pending token、旧已签发请求和新建/start/prepare/公共审批均被拒绝；实际进程/代理/所属端口结束、无 marker 或 Host 重放、策略仍 Workspace、重复结果一致。

同目录 app-exit-events.json：真实 PID 33568 两次 ExitRequested 后 Exit；Tauri run_return 返回 0、验收进程退出 0，后续 ps 确认 PID 不存在。racedDispatchOutcome 仍为 gateRejected，仅记录这次真实竞争分支，不声称所有已获准启动或复杂并发压力覆盖。

首轮真实 PID 26503 已收到 ExitRequested/Exit 并退出，但 Tauri run 在 Exit 直接退出，报告 writer 尚未交付，该轮不计验收；修复只使用本仓库锁定 Tauri 2.12.0 的成熟 run_return API 和原子报告写入，保持同一生产事件回调并等待自身 writer，不修改生产 AppExit/gate/UI 或制造状态。`/tmp/shellspan-phase5-wry-shutdown-build-v8.log` build 26.17s 成功为编译证据，最终通过来自实际 JSON、事件和进程结果。

当前三个 Wry 场景均没有注册模型审批 pending 事件、调用模型或创建子 Agent driver；公共审批入口检查与实际 Adapter pending token / 已签发 capability 是各自的范围。最新 Registry 直接 attach/try_acquire_driver 与同一 gate 的保护及真实单组件 1 passed 已在本节后的原始证据表核对；不是这三个 Wry 的子 Agent 路径，也不是模型 child业务或权限继承全链。Builder/Registry 源码变化影响注册时，仅对相应路径做最终收尾复核。

## 主计划第 1–6 节完整要求审计

本节是 2026-10-07 当前工作树的只读审计，覆盖主计划的策略、流程、边界、契约、每阶段清单及交付标准；不是只核对阶段 5 五行。源码仍在并发实施，以下按可观察当前内容区分：

- **实现缺口**：确切要求没有接通，或源码明确拒绝该功能；不能用较容易通过的现有子项替代。
- **已实现待验**：已看到对应实现，但尚缺匹配当前修订、场景和执行链的实测。
- **证据偏窄**：已有通过结果，只能证明组件、单个原生入口、前端断言或 provider smoke；原要求的其他范围仍未闭合。
- **匹配子项已验**：此报告已核对匹配的原始证据，仍受列出的平台、资源及执行链范围限制。

Mac 首版是用户已批准的常规原目录 Seatbelt、正常进程组、准确 partial；既有硬链接、同账户恶意竞态及恶意后代限制只披露，不重新设立完整对象保护、ES、FDA、root、Linux 产品迁移条件，不重试已中止攻击。Windows 后置不阻止 Mac 独立完成，但 Windows 未验证内容不写通过；远端系统独立判断。

### 策略与便利性要求（计划第 1、2 节）

| ID / 原要求 | 当前实现位置与匹配证据 | 当前结论 / 尚需完成的原场景 |
| --- | --- | --- |
| R01 三策略文件/网络语义，readonly 最小临时写入，host 账户权限且不自动 sudo | `sandbox.rs::freeze/authorize_dispatch`、`native/macos_sandbox.rs::command_tracked`、`AiSandboxSettings`、双语 locales；真实 readonly 日志与普通 workspace 场景见前文 | 匹配 Mac 基线已验。Host 未隔离说明与 no-sudo 不应解释为 root；新策略切换后的 Host/readonly/workspace 实际 UI/执行结果一致还待验 |
| R02 审批与沙箱独立，选择 host 不改变 permissionMode | `runtime.rs` 独立设置、`sandbox_policy_switch.rs::set_sandbox_policy` 不改 permission_mode，前端 separate controls；旧 Header/controller 回归及 switch 测试源码 | 已实现；现有前端回归证明请求/投影，不能代替最新真实 switch 与审批组合。不能因选择 host 自动升级 scopedAutopilot/operator |
| R03 新本地项目默认 workspace、缺 root 先选择，新远程默认 host；历史保持事实 | `runtime.rs::create_session`、controller `newSandboxPolicy/resolveProjectRoot/createInputWithFrozenTargetRoot`、`session-target.ts::freezeCreationProjectRoot`；新 root 通过后端规范化，历史续接保留 source policy | 基线已实现。已有 `use-file-completion` root Dialog、`ai-project-directory-input` 和 `ensureProjectSession/skillRoot`，不能说无选择控件；普通首次 send 在 CWD 发现失败时怎样引导既有 chooser、明确选择后再新请求尚缺闭环实测。发现失败 `root:null,ready:true` 后 freeze 拒绝是安全门禁，不等于便利性已完成 |
| R04 远程 readonly/workspace 仅经过验证后可选 | remote provider/engine/installed Adapter有实际链；最新AiSandboxSettings移除hard-local事实，controller/useRemoteSandboxVerification接typed current-target-only verifier，key绑定source/target/root/policy并过期清理 | 前期hard-local缺口已接源码，状态为已实现待验。必须匹配当前source字段的真实verify/UI选择/创建及stale清理，不从infrastructureProbe猜available，也不能由能点击选项就算verified；3仍在实施/实际显示验证 |
| R05 设置摘要显示实际主机、root、网络，详情/历史清楚且不改其他页面 | `AiSandboxSettings`、`AiWorkspaceController`、`sandbox-presentation.ts`；已有双语/宽窄/键盘截图、真实 revoke IPC | 既有本地显示匹配已验。远端 partial gaps 尚未进入双语映射，network/process 文案仍由 local-only `nativeAvailable` 决定；新增默认配置/切换/审计控件的实际显示、焦点、窄容器待验，不以 99 前端 tests 替代 render |
| R06 scopedAutopilot 在实际沙箱自动普通修改/构建/测试，敏感/破坏/外部副作用保留审批 | `native/auto_review.rs::review_workspace_call/ordinary_workspace_commands`，`tests/macos_direct.rs::native_workspace_scoped_autopilot_executes_ordinary_build_test_and_modification` | 仅已识别本地 workspace Direct 命令。小项目普通行为有报告；phase5 实际 install/fetch 是显式批准，不是自动审批证明。未知命令仍 ask；不将有限普通规则推广为任意写代码方式或真实模型长期无需重复审批 |
| R07 具体资源、once/session 默认 once，操作与资源一次批准合并，去重 | `AiApprovalPanel`、typed approve resourceScope、NativeAdapter/authorization；实际文件、网络/服务、cache/native/多会话及最新M3 cache5请求2native结果 | 四类支持资源各按匹配证据；最新cache模型复用/撤销正面通过，旧requests0不算通过。最新审批/配置/审计真实主工作台/UI仍待验，单类不能推广其他类别或全部审批模式 |
| R08 只有可信越界事实才扩权，非零/EPERM/模型解释不能自动提高权限 | `execution_failure.rs`、Native runtime admission 分类；typed resource request 经规范化/批准/签发，普通非零不变成 policyRejected | 创建前拒绝与命令失败分离已实施。可信运行期越界诊断仍不足，不能把 stderr 文本当操作系统证据，也不能把用户显式请求资源解释为已获得授权；必要扩权提示与真实运行期诊断待闭合 |
| R09 已执行/unknown 不自动重试；notStarted 才可重新派发，其他先检查副作用/新请求 | 正常两App13/17、实际M3 waiting8、protocol-native unknown10、真实M3 generated unknown/residentDriver11；生产recovery/uncertain/notStarted同源 | 指定queued/pending/dispatched与resident driver默认恢复流程已验：unknown先停，真实效果/PID核实→公开reconcile→新模型请求brief完成不重复效果。protocol10仍非生成回合，model11独立闭合该范围；不推广全部queued lanes/资源/child/remote/UI、所有退出方式或复杂并发 |
| R10 项目/连接可记忆确认的默认策略与非敏感目录；配置不是 authority | defaultsStore仅policy/cacheDirectories，新会话controller latest createInputWithFrozenTargetRoot携带cacheDirectoryCandidates；真实twoAppDB prefs恢复不authority已有13/17 | 配置hint使用链前期缺口已有新增源码，当前已实现待匹配真实提示/批准/UI与driver验证，不能把候选变write_allow/grant。DB正常恢复证明持久与旧Header不变，不代表frontend操作全部成功；敏感目录/canonical scope仍需精确边界 |
| R11 关闭、重绑、账户变化、恢复后临时授权失效 | 内存grant/digest/bindingRevision、文件revoke/cache两Session；真实same-root两App13/17恢复无authority；M3实际waiting审批硬中断后取消/拒绝；SSH nonce同timestamp不复活 | 精确正常重启/待批中断及绑定场景已验；bearer不跨文件移交，old签发在seed内关闭对照，新App不恢复sessionauthority。不能推广所有资源/目标/外部SQLite竞态或完整UI/child/remote崩溃恢复 |
| R12 空闲且无后台/child/pending/uncertain/terminal lease 才切换；撤销先停止，unknown 暂停新执行 | `sandbox_policy_switch::set_sandbox_policy` 检查以上条件、common transition Mutex，start/adapter 审批派发交叉保护；`runtime::revoke_sandbox_reads` 与 audit失败 pause | 源码已新增，不能再称无 switch。当前 99 前端 pass 不证明内核/GUI切换；`policy_switch_serializes_unregistered_session_with_real_background_launch` 源码存在但本轮未确认其命名运行日志。需实际空闲成功、后台/child/待批拒绝、并发 startup、旧已准备请求失效、暂停/未知清理和 UI事实一致 |

### 执行边界与后端契约（计划第 3、4 节）

| ID / 原要求 | 当前实现位置与匹配证据 | 当前结论 / 尚需完成的原场景 |
| --- | --- | --- |
| R13 实际执行主机规范化并冻结 root；临时/cache 有范围，deny 优先，敏感路径/项目敏感文件拒绝 | local freeze/target normalize/OSprofile与cache真实链；最新project_read_requests允许具体regular外部file并拒敏感/受保护路径/凭据，仍本地最多8明确文件 | 原project-only缺口已有源码扩展，外部readonly状态改已实现待验。必须真实未批拒/明确批准读取/只读不写/敏感存储仍拒/恢复去权，不能以cache/net代；root.env.local仍只读例外，Mac alias/race partial不变。远端R22独立 |
| R14 正常读写/符号链接/多层子进程继承/后台由 OS 后端约束；已批准 alias/race 限制一致披露 | Seatbelt deny default、profile继承；真实 links/nested shell/temp/cache/signal/独立 sandbox 场景；UI local gap映射、模型 `sandbox_capability_for` | 正常匹配已验。partial 限制不是失败门禁，也不是 full 保证；远端新 gap 中文、每个 tool result 同源事实及最新 docs仍需同步，不重试历史攻击 |
| R15 环境最小传递，模型/SSH 凭据不注入；需要凭据走明确代理/reference及生命周期 | `macos_sandbox::env_clear` 限定 env，SSH 层 `connection_for_remote_target` / pinned helper、jump reference / inline secrets拒绝 | 局部 env 真实断言只覆盖 SSH_AUTH_SOCK/OPENAI_API_KEY 等明确项，不能说扫描了所有变量。未提供任意私有包 registry credential bridge，不应当公开 npm/cargo 下载已证明 credential用途限制；远端 token stdin/receipt 私有字段不等于所有secret transport已验 |
| R16 禁止网络约束任意程序及子进程，不能只靠 HTTP_PROXY，协议/host/port/redirect事实准确 | Seatbelt deny network* + 仅精确 Unix socket，`network_proxy` HTTP/SOCKS库，typed protocol tcp；Node/pnpm/git/curl与真实依赖下载 | user已批准 TCP host/port，TLS 由客户端验证，同目标 HTTPS路径/内容/redirect不检查，不重新要求 MITM。跨目标 redirect 仍须新的目标权限；不把有限客户端成功推广所有 runtime。普通 OS deny/继承证据与代理分开记账 |
| R17 DNS、IPv4/IPv6、localhost、Unix、SSH forwarding、云元数据分别定义/验收 | `network_proxy::Policy::connect/public_address` + 实际owned IPv4/IPv6/mapped/Unix/child baseline→restricted deny 2pass；metadata/local literal生产network_requests启动前拒1pass（不dial）；ownSSH -W同参数baseline成功→restricted未到1pass | 匹配这些网络域已有真实证据，不再写“完全无矩阵”。已授权公网代理、DNS重解析/更多IP域、SSH其他forward形式/Unix授权扩展等仍不由此泛化。Metadata只启动前校验，无真实cloud连接；HostHTTP不等于受限代理，socket stderr不当可信policyRejected |
| R18 本地服务明确地址/port，结构化 probe_http，非所有网卡、非任意外连；下载展示实际源集合 | Node FD→Unix→应用 loopback TCP，`http_probe` 所属 service检查；Vite与phase5两个服务、AppExit proxy/port终态；真实 npm / crates targets+resolver审批 | 已支持 Node 127.0.0.1:port 精确模式，实际实例匹配通过。任意语言/listen模式、IPv6监听未支持；不得靠低层 loopback规则宣称仅监听地址。多源真实下载已列具体 targets，不因失败开放全网 |
| R19 Shell统一 Direct、实际成功后才available；成熟OS能力，不拿cwd/worktree/分类当隔离 | `NativeToolAdapter` 冻结/复核，`NativeToolEngine` local固定 Seatbelt，预检真实；source PTY0；typed unsupported失败 | local pipeline已接。native 调用与初始预检事实不能代替生产签名 App/release binaries的适用性；native集成之外入口另列 R24，Windows unavailable保留 |
| R20 普通可视终端冲突先处理，闲时明确切Direct，不注入现有终端；专用受限PTY另行 | UI restricted boundTerminal禁用/notice、controller `selectExecutionSurface`、`runtime::set_execution_surface`、native边界 | 拒绝冲突和 sourcePTY0 有证据。原 checklist 明确未勾选；目前不自动选择Direct，需用户明确操作，最新真实启动/切换确认链仍待验，不把某个selector禁用当整个冲突流程闭合 |
| R21 远端隔离在目标执行，验证文件/网络/取消/结果才开放；不自动安装/修改安全/root服务 | `remote_backend_commands` readonly probe、`remote_seatbelt::verify_header` 既有 Python/Seatbelt preflight、pinned SSH/controller stdlib；NativeEngine1pass及真实 Wry installedSlot NativeAdapter JSON通过 | 普通Mac SSH实际链已到Adapter级：审批/签发/读写partial/非Shell拒/stdin/kill/断线旧审批拒/PTY0。UI可选、真实SSH部署、更多异常残留/timeout/recovery并发和其他平台仍待匹配验证；不升级为remote网络grants或模型回合通过。未提供依赖时fail-closed，不自动安装；启动自有preflight与readonlyprobe分别说明 |
| R22 冻结SSH主机/账户/auth/jump/hostkey/canonicalroot/UID及加密签名绑定 | `RemoteExecutionBinding` connection generation/backend nonce；`remote_seatbelt::verify_header/authorize/stamp/dispatch_digest` canonical root/home/tempBase、UID非0、hostkey pin、HMAC receipt及完整digest；新AdapterJSON验证sftpCanonicalRoot与signedNativeControls | binding2pass、engine1pass与Adapter真实normal/断线旧token覆盖各自范围。外部SQLite连接宿主竞态不覆盖；UID/canonical/mismatch/hostkey/jump各异常组合和重启恢复不可用仍需匹配实测，不由normal root或一次auth改回代全部字段 |
| R23 每次调用策略版本/host/root/allow-deny/network/expiry/source，不能相信自报grant；子Agent不扩大 | `sandbox::authorize_call/validate_session`、`contract_digest` / native签名，`subagent::create_child` 继承policy、Session `validate_sandbox_inheritance` 比較permission/target/effects；resource grants不继承 | 契约与历史回归已实施。实际 child委派/native dispatch 与scope资源隔离的证据偏窄；新 Registry shared gate 的1pass仅attach/driver关闭，不是子Agent业务、权限继承全链或模型行为证明 |
| R24 全部非Shell/独立入口不能替代越界；有实际边界才可用，否则拒绝/显式切策略 | `tool_boundary::require_native_tool_boundary` 被Native prepare/execute/MCP独立入口调用；pipeline/adapter/header检查；file_refs、skills、自带session/fleet/internal工具另有sandbox checks | 安全拒绝属于符合“未支持则拒绝”，不要求擅自开放。当前结构化read/write/list/search/edit/patch/trash/transfer、inspect/service/log/endpoint、MCP、普通terminal均未声明受限可用；local probe限所属服务，remote probe仅Host。独立Tauri IPC、恢复prepare、skills/file refs、subagent/fleet边界须最终逐入口验收，不能只看 exec 或拒绝列表unit |
| R25 capability各字段/partial缺口、UI/model/toolresult同源，无Host降级 | prompt/snapshot capability_for(header)；最新pipeline record_sandbox_rejected_call与recovery结果均用实际Header的capability，不再remote generic unavailable | 原generic事实缺口已有源码修复，实际per-tool unsupported与verified partial同时准确呈现仍待当前回归；remoteUI/双语新gap/失效事实R05/R04。预检失败拒绝不转换Host，各平台异常不泛化 |
| R26 审计策略/资源变化、host/surface/reason/result且脱敏，审计不是授权 | `sandbox_audit` Approved/Reused/Revoked/RevocationFailed，`native_adapter` audit提交失败pause，Runtime revoke记录结果、event/schema投影；实际export保存边界3pass+事件9pass | 新audit源码已接；`phase3-audit-native.log` 1pass但dot输出未保留具体过滤名，本轮只确认日志数量，不冒充完整Adapter/GUI审计验收。需实际批准/复用/到期/撤销成功与失败、恢复/audit写失败暂停和完整序列化审阅。日志producer/导出正常JSON都复用redaction，GUI保存窗口仍未验 |

### 交付、平台门禁与每阶段清单（计划第 5、6 节）

| 原 named item / 原状态 | 对应审计与当前结论 |
| --- | --- |
| Phase0 入口盘点、威胁模型、cfg(test)审查三个[x] | R14/R19/R20/R23/R24；历史交付可保留，不因为新remote/Registry入口存在就假定旧盘点覆盖新增代码，最终需更新差异 |
| Phase0 后端选择/macOS/Windows真实能力[ ] | Mac常规partial具备当前原生证据；Windows后置缺环境/实现与实机支持记录保持未完成，不阻Mac独立门禁；不以历史Linux容器实验代桌面产品 |
| Phase0 必要系统读/项目/敏感拒绝/网络/cache/temp[ ] | R13–R18 真实子项已验；全地址族/客户端边界与平台汇总未齐，先按Mac当前declared scope闭合，而不是重加撤回对象保护条件 |
| Phase0 平台支持矩阵/依赖/缺口/可执行方案[x] | 已有历史文档及本报告matrix、phase5 README复现；须交付当前Mac Seatbelt/工具链、Node relay、远端现有Python/Seatbelt条件和不支持行为。首版不要求 Endpoint Security 服务或权限；已清理退出当前路线的候选安装文档与符号探测程序 |
| Phase1 独立类型/IPC/events/recovery[x] | R01/R02/R23/R25/R26 已实现；新policyChanged/resourceAudit/remote/probe字段继续需schema/IPC/双语key最终专项 |
| Phase1 按调用freeze/expiry/继承/目标失效[x] | R11/R22/R23；旧contract tests证明对应边界，当前新增remote stamp/Registry/transition需要最新相关回归，不恢复livegrant |
| Phase1 历史保留/local默认[x] | R03/R10；不把从prefs载入配置变成历史session policy改写或已批准cache；当前首次send缺root链待验 |
| Phase1 intent/capability/context[x] | R05/R25；local事实一致子项通过，remoteUI/result事实仍有具体接入/文案差距 |
| Phase1 protocol同步/contract回归[x] | 已有schema/规范/脚本与历史结果；部分sandbox-policy/remote-backend说明还混用历史“未来/尚未开放”措辞，收尾须明确日期/当前实现与缺口，不改变历史失败事实 |
| Phase2 统一后端先落实[ ] | R19；Mac真实Direct闭环已验，remote/Windows分别判断；目前最终源码仍改，不整体勾选 |
| Phase2 temp/cache/env/sensitive[ ] | R13/R15；匹配路径/环境项已有真实证据，不说所有可能secret变量逐项覆盖 |
| Phase2 handles/stdin/wait/kill/timeout/group/unknown暂停[ ] | 普通及Wry17/19通过指定范围；unknown lease真实失败保留。Registry最新真实1pass只组件；真实模型活动shutdown/全部恢复分支、远端残留另验，正常group范围保留partial |
| Phase2 failure类型/noHost自动回退[ ] | R08/R09/R25；创建前/已启动/未知分类与多条真实chain，不掩盖Host SSH取消不能确认或复杂运行期诊断不足 |
| Phase2 正常路径/symlink/继承/network/日常build[ ] | links/temp/signal、pnpm受限src/scripts、普通Rust crate及build、实际依赖成功；ShellSpan宿主系统能力suite在外层仍1079/124fail，不能用普通crate或宿主全绿覆盖，不强行放宽全套运行权限 |
| Phase3 现设置/审批三策略摘要[x] | R01/R05；既有UI范围已交付，新remote/default/switch/audit控件回归与实际显示仍需对应验收 |
| Phase3 once/session合并/不持久grant[x] | R07/R10/R11；已支持资源按各证据，最新M3 cache请求5/真实native2正面联动，旧requests0仍不计通过。外部readonly允许列表与最新UI/audit由R13/R26 owner当前实现逐项核对，不由cache替代 |
| Phase3 network集合/services/revoke树[x] | R16–R18/R12；Node/TCP/正常group匹配，所有地址域/异常组合不据此全完成 |
| Phase3 scopedAutopilot ordinary[x] | R06；以当前明确限定普通可识别命令记，不解除敏感/破坏/unknown审批 |
| Phase3 visual-terminal startup/switch冲突[ ] | R20 原项仍保留，不能用空闲检查替代启动前明确选择/后端真实拒绝 |
| Phase3 双语/focus/keyboard/dedupe/restore/narrow[x] | 旧功能已有render；transition4files99是相关前端，不代表最新controls真实render或switchkernel。新增prefs/audit/currentUI闭环为原要求补项，不能缩成只组件test |
| Phase4 Host显示未隔离/身份/审批/cancel[ ] | R01/R22；Host actual SSH2tests含残留准确性，不是SSH部署或远端restricted保证；UI host说明保留 |
| Phase4 remoteBackend/target冻结/verified才开放[ ] | R21/R22/R04；provider→engine→Wry installedSlot Adapter指定链已验；UID/root异常、current target-only verify与实际可选UI/目标失败行为仍逐项验 |
| Phase4 reconnect/account/unavailable/disconnect/residue/失效不复用[ ] | backendnonce2pass及engine重verify1pass已列；Host残留未确认不是误通过，但全restricted生命周期/recovery并发尚未齐 |
| Phase4 structured/files/HTTP/SFTP/deploy/MCP能力检查[ ] | R24；当前拒绝是正确scope，但要验证每个独立入口不成为替代通道，HostHTTP不能代remoteproxy |
| Phase4 安装/权限独立授权、probe不改服务器[ ] | R21；readonlyprobe和启动自有preflight/temp/实际controller分开；现无自动安装，不因此假定独立安装流程或权限变更已交付 |
| Phase5 日常read/pnpm/cargo/download/service/log/SSHdeploy[ ] | 前六类指定链有证据，模型诊断解释及真实SSH部署尚缺；不把Hostsleep取消或HTTP读取当部署 |
| Phase5 Rust/frontend/build/fmt/protocolIPC[ ] | 历史广泛回归/本轮局部质量通过；源码稳定后做最后受影响检查，全仓fmt既有mcp差异单列不伪造绿色 |
| Phase5 cancel/timeout/recovery/revoke/background/unavailable/multi[ ] | 前文全部对应真实证据+R09/R11/R12/R22/R23；17/19只实际范围，不含所有modelChild/恢复/远端异常或复杂race |
| Phase5 settings/approval/results、logs/export无secret[ ] | R02/R05/R07/R26；真实文件grantGUI撤销+落盘通过，最新policy/default/auditUI与整GUI导出/任意secret文本不能由regex测试外推 |
| Phase5 发布说明平台限制、回退停新/先清理/noHost续跑[ ] | R01/R19/R21/R25；真实Wry关入口/cleanup/unknown不确认/noHostmarker已验，支持说明草稿仍需当前完整矩阵；没有执行版本回退/发布/部署动作 |
| Phase6 Mac先/Windows后/remote独立，全部完成条件同时成立 | 各表所列partial限制准确接受，但仍须连续任务便利性、权限去重/可理解、失败/恢复不扩权和所有通道准确事实共同闭合。任一未支持通道必须准确拒绝；Windows后置不挡Mac，但不是已通过。全goal仍未完成 |

最新 source busy 补充：controller 缺根分支已保存 pendingProjectDraft、递增 projectRootRequest 来复用现有目录选择，然后形成明确新请求；R03 仍缺真实首次send到选择继续的匹配显示证据，但不能再说没有引导实现。R04/R10/R13/R25 上述新增实现来自本轮只读检查，不按编译或旧前端测试自动勾选；收到owner实际新UI/授权数据后再更新结论。

### 本轮新增原始证据核对

| 原始日志 | 实际结果 | 不应外推的范围 |
| --- | --- | --- |
| `/tmp/shellspan-shutdown-registry-native-test.log` | `actual_registry_child_admission_shares_native_shutdown_and_allows_cleanup` 1 passed / 0.29s；已读当前fixture为真实Registry/sharedengine/production HTTP adapter构造，无fakeprovider响应或模型请求；attach/driver关闭、cancel、interrupt/detach清理可用 | 不是实际子Agent模型委派业务、文件/网络资源继承全链或新Wry最终修订复测；最新Builder/Registry注册变化后需对应收尾检查 |
| `/tmp/shellspan-phase3-transition-focused.log` | 4 files / 99 passed，已读取摘要 | 前端请求/状态组合，不是实际新控件render、保存到preferences真实链、策略switch kernel或并发全部路径 |
| `/tmp/shellspan-phase4-macos-native-engine.log` | `remote_native_engine_signed_approval_and_reverification_never_revive_old_grants` 1 passed / 5.44s | 生产NativeEngine approve/sign→真实SSHrestricted读写/拒绝/partial、非Shell拒绝、旧timestamp auth恢复+reverify旧签名拒绝/no marker、target mismatch/PTy0；此日志不等于Adapter，Adapter新增原始JSON单列，UI仍待验 |
| `/tmp/shellspan-phase4-wry-a0csD1/remote-check.json` | passed=true、targetPlatform=macos、capabilityFacts=partial、sourcePtyWrites=0；restrictedDirect/sftpCanonicalRoot/operationApproval/signedNativeControls/filePersistence/nonShellRejected/stdin/cancelCleanupConfirmed/disconnectedApprovalRejected均 true | 已读 `remote_native_check.rs`：真实App中安装native slot和共享engine；先prepare_sandbox，未批准状态改动拒绝，实际SSH文件stdout与SFTP持久内容一致，所属后台stdin真实输出、签发kill确认清理、源连接断开后旧prepared token拒绝。No LLM/no UI render，不等于部署、恢复全链、远端resource/network扩权或所有平台 |
| `/tmp/shellspan-phase4-wry-reconnect-DbUTIz/remote-check.json` | 原始JSON passed=true、sameIdentityReconnect=true、其余上述Adapter正常/control/旧审批拒绝facts=true、sourcePtyWrites=0 | 本轮读JSON并与phase4报告对应：同身份真实源SSH PTY重连，断线与未消费reconnect token拒绝，新冻结调用正常。Mac-only/noLLM/render，不升级server部署、全部账号/平台/并发或任意资源grants |
| `/tmp/shellspan-phase3-defaults-focused.log` / `phase3-switch-focused.log` | 当前日志分别4files98、4files97 passed | 这些都是前端旧轮次，不能代替最新99或actual switch/preference/恢复 |
| `/tmp/shellspan-phase3-audit-native.log` | 1 passed / 0.32s 的dot报告，未在日志保留filtered test名 | 当前只能确认该轮单项成功；需要owner命令/对应源码证明准确identity和audit范围，尤其不能由手工record方法测试推出完整NativeAdapter/GUI写失败行为 |

本轮只读取源码、主计划、原始证据并扩充本专属报告；没有更改共享源码、阶段3/4报告或主计划，没有重新执行七个独立场景、公网下载、17/19 Wry或全量测试。

### 原 named 恢复/部署场景及责任范围

| 原要求 | 可复用的生产入口 / 责任范围 | 需形成的真实证据；不能替代它的现有证据 |
| --- | --- | --- |
| 完整应用恢复、临时授权失效、未知效果不重放 | Phase2 生命周期：`AgentRuntime::configure` / `AgentSessionStore::configure` / `pause_restored_inputs`、`Runtime::resume/resume_recovery`、`ToolPipeline::resume_authorized` 与 restricted recovery；Phase3 主工作台恢复/审批；Phase5 独立 Wry 验收 | 必须两个实际独立 App 进程使用同一自有 app-data/project，而非同进程重建 engine。A 中真实批准 once/session 资源并执行，B 实际回放 policy/binding/audit/prefs，旧 authority 不可复用，同资源须重新批准；恢复的 queued input保持暂停，旧 prepared审批不执行。WaitingApproval / dispatched但无 durable result 分支要来自真实 pipeline 与实际中断，不手工写假的 ToolApproval/ToolDispatched JSON，不用 fake provider。必要模型调用复用已授权真实模型/只读reference，凭据不导出。已开始的不确定命令用自有目录、有界普通任务与实际 marker/PID核对，B 保留 uncertain gate，不自动重放或 Host续跑；明确检查后新请求单列。现有 cache新engine、Registry组件、容器GUI旧5/5、Wry关门禁都不能代这一场景 |
| 真正 SSH 部署场景 | Phase4 SSH身份/NativeAdapter/Host或真实部署通道；Phase5 指定部署验收。已有 `deployment/run_coordinator.rs::approve_run/begin_start_run/execute_approved_run` 供匹配部署中心范围；也可用明确 Host NativeAdapter + 生产传输/命令，不能隐式把 restricted 转 host | 使用已有独立普通账户 SSH fixture、明确目标项目目录与自有真实小应用 artifact；实际批准后上传/校验远端内容与哈希、按 frozen host/account/root 启动真实应用、通过目标 loopback获取实际健康/版本结果，再真实更新 artifact并核对新版本。只清理自己的项目/有归属事实的进程与端口，保留 SSH取消无法确认时的真实失败，不用“channel已关”作清理确认；目标、审批、审计与配置变更漂移拒绝列证据。无 sudo、系统service/ACL/网络更改、真实版本发布或用户服务器依赖安装。现有 Host sleep、目标目录HTTP、remote adapter写普通文件不等于部署；部署中心其他发布类型未执行则单列，不由一个 owned应用推广全部 |

现有 `scripts/verify-deployment-e2e.mjs` 和 `tests/deployment-e2e` 可以提供受信路径/产物组织参考，但其中 `systemctl-fixture` 仅将 reload nginx 记入 counter，不能作为真实 service reload 的结果或本轮无替身部署验收。不能通过复用该计数器、模拟 health/progress/backend 让缺项变绿；采用真实账户可运行应用和真实 HTTP/PID/文件事实，明确测试的是哪一种部署。

正常两App恢复、真实M3 WaitingApproval及真实protocol-native unknown 的指定子范围已经执行，结果另列。SSH部署及其余恢复范围仍按本表要求补验。硬中断仅限身份核对后的新自有App，没有信号到用户/其他 fixture 或 descendant；未部署/回退版本。R13/R17/R25 的owner/source busy项保持各自状态，已有通过场景仅在关键源码改变时相关复核，不泛化整体通过。

### 正常退出后两个真实 App 的同状态恢复（已执行的精确子范围）

独立 `native_restore_check.rs` 经已协调的 native_agent_check early hook，两个实际 Wry 进程先 `restore-seed` 再 `restore-reopen`。同一自有 `/tmp/shellspan-phase5-app-restore-final-Ly2DtW/state` 是真实 AppDirectoriesOverride / Runtime.configure / DB / journal / checkpoint / preferences；`project` 与 `cache` 是兄弟目录，Agent 不写应用状态目录。reopen 在源码内用实际进程查询检查原 seed PID 已结束，验收调用方也先 ps 核实才启动第二阶段。

| 原始报告与事件 | 实际结果 |
| --- | --- |
| `/tmp/shellspan-phase5-app-restore-final-Ly2DtW/restore-seed.json`、restore-seed-events.json | passed=true、13 checks true；PID 61787，真实 once/session 授权读取，关闭前 sessionAuthority active、真实未暂停 receive_submission 用户队列、真实 preferences 保存；原生后台实际写 seed-started 后由真实 AppExit 清理确认；关闭后有效 old prepared / old signed 只在内存作拒绝对照，session authority 已撤销、无旧 marker 副作用；Workspace/ReadOnly 意图、API0/PTY0。两 ExitRequested+Exit，进程退出0并 ps 确认不存在 |
| `/tmp/shellspan-phase5-app-restore-final-Ly2DtW/restore-reopen.json`、restore-reopen-events.json | passed=true、17 checks true；PID 83605，第二个实际进程生产 configure 回放相同 createdAt/binding 与两种策略，读取真实 audit journal 和有效版本1 defaults 配置；seed 的 unpaused queued input 被实际 pause_restored_inputs 暂停，旧 session/resource authority 为空，无旧 running process、原 marker 未重放。once/session 新读取均 requiresApproval 且 false execute 被拒绝；新 explicit approval 读原文件成功、新 workspace 请求才写 fresh marker；API0/PTY0。两 ExitRequested+Exit，进程退出0并 ps 确认不存在 |

报告只是非敏感事实、PID 和 Header 版本基线；没有 live bearer、签名 token 或模型/userkeychain secret 跨进程文件。原生 capability store 为进程内 registry，reopen 使用生产 App 的新实例；旧 signed capability 不通过文件移交，而以 seed 关闭后拒绝、真实 shutdown revoke-all 与新 App 实际无可复用 session authority/要求重新批准共同限定证明范围。不是用同进程 new empty engine 代替 App 恢复，也没有手写 journal 或假的 Model/ToolApproval 事件。

新进程调用实际公开 `agent_runtime_probe_native_sandbox` async 方法，运行生产固定临时输入的 OS preflight，再由 installedSlot 对恢复的实际 Header prepare_sandbox；没有把测试 bool 或旧进程 cache 当 available。有效 defaults 格式来自现有 schema，配置仅作为保存/恢复数据，不能覆盖现有 ReadOnly Header 或恢复权限；这里不证明前端 defaults 控件或模型 hint 的完整使用链。

保留的失败归因：旧 `/tmp/shellspan-phase5-app-restore-km3RLX/restore-seed.json` CriticalOperationDenied 是初始 fixture project 位于 app-data 内，生产保护正确；PID 60144 已退出，失败 journal 未改。正确布局的首个 reopen PID 71112 因 fixture 漏了新进程启动 preflight 得到 unavailable，原始 report/events 已保存为 `restore-reopen-no-preflight.json` / `restore-reopen-no-preflight-events.json`；没有改生产拒绝，也没有重 seed 的真实记录。仅修 dedicated helper 与成熟公共方法后重试已结束的 reopen。

本正常退出场景本身不覆盖模型WaitingApproval、unknown或硬中断；这些由后续独立场景单列，不合并误报。真实child模型恢复、远端重启/连接恢复、UI恢复与所有queued lanes仍未完成。旧seven/public download未重复；新增critical storage保护影响旧shutdown Wry嵌套布局，因此只做以下受影响路径复核。

### 新应用数据保护下的关闭场景复核

专属 `native_shutdown_check` 改为 `root/state` 与 `root/project` 兄弟布局，数据库位于 state。生产 critical data deny 未改；对应 17/19 基线因关键源码影响而复核，未重复无关七个场景或公网下载。

| 当前匹配的实际报告 / events | 结果 |
| --- | --- |
| `/tmp/shellspan-phase5-sibling-normal-YuOzub/shutdown-check.json`、app-exit-events.json | passed=true / 17 checks；cleaned=2、confirmed=true、API0/PTy0、race=gateRejected；PID85321实际ExitRequested两次+Exit、退出0并ps不存在 |
| `/tmp/shellspan-phase5-sibling-undrained-RrA14A/shutdown-check.json`、app-exit-events.json | passed=true / 17 checks；confirmed=false与真实unconfirmed错误保留，重复同错误/gateclosed，API0/PTy0、race=gateRejected；PID85322实际ExitRequested两次+Exit、退出0并ps不存在 |
| `/tmp/shellspan-phase5-sibling-exit-active-EJlgRP/shutdown-check.json`、app-exit-events.json | passed=true / 19 checks；productionAppExit在资源running时首发cleanup，cleaned=2 confirmed=true，API0/PTy0、race=gateRejected；PID85323实际ExitRequested两次+Exit、退出0并ps不存在 |

原先17/19报告保留其修订和布局含义，当前采用以上匹配新保护的证据。race只观察到拒绝分支，不泛化已获准启动的所有竞争或模型业务；未确认错误不改写为成功排空。

### 新实际 MiniMax-M3 driver 的 WaitingApproval 中断与恢复

专属 `native_model_recovery_check.rs` 使用当前开发默认选择，要求仍为用户明确选定的 MiniMax-M3；只读开发 routes 文档、仅所选 credential reference 的 readonly backend，不读取其他 secret、导出key/token、修改ACL或操作系统认证窗口。新请求的固定 prompt 只允许自有项目的精确 marker 命令，实际 Runtime.start/receive_submission/driver 构成 journal；不是旧响应重放或固定 protocol 输入冒充 LLM。

原始 `/tmp/shellspan-phase5-pipeline-model-waiting-0HdsYS/pipeline-ready.json`：ready=true、modelRequests=1、modelId=MiniMax-M3、actualDriverAssistantCall=true、recoveryKind=waitingApproval、sourcePtyWrites=0；旧 marker 不存在。身份核对的 App PID22377 / startTime1791355640 / 完整 argv 与 fresh root / 实际 identifier 匹配后，`interrupt_owned_pipeline.py` 只 SIGKILL 该 App（工具退出137）；记录的 source bash22379 cwd 属于该项目，随后实际 ps 已确认 App/child都结束才 reopen，没有给 child/别人PID发信号。ready是等待状态证据，不单独称seed完整通过。

同根 `model-recovery-result.json`：passed=true、8 checks true、PID22646、seedModelRequests=1、sourcePtyWrites=0。第二实际Wry configure读取真实driver AssistantMessage/ToolCall/Approval后，生产 recover_waiting取消旧restricted pending，旧approve拒绝、原 marker从未执行、Workspace保持；只有新explicit NativeAdapter批准请求写fresh marker。恢复阶段没有新增模型请求，不声称第二个生成模型回合。`model-recovery-events.json`有两次实际ExitRequested+Exit，runner成熟run_return/source结果校验和空错误日志匹配成功，ps PID22646不存在。

直接 `process_model_calls` 的早期 waiting fixture `/tmp/shellspan-phase5-pipeline-waiting-final-z6i7lV/pipeline-result.json` 保留false：未有driver AssistantMessage，实际recover返回 Recovery found no model call for the durable native call。没有通过手append事件/伪造ModelResponse修这个不完整协议fixture；以上真实新M3请求提供缺失的实际driver记录。另35秒观察窗过期的旧fixture只正常失败/退出，安全脚本因PID已消失拒绝kill，不计硬中断成功。

### 真正 native pipeline 已派发但无 durable result 的未知恢复

专属 `native_pipeline_recovery_check.rs` 使用 Runtime真实privateparts的cfgMacdebug子module桥（实际共享sessions/registry/tools/models，非替换工厂/transport）。公开receive_submission→生产begin_turn_step→实际Registry/生产HTTP adapter构造（不stream）→process_model_calls注册真实pending→真实decide批准调用；fixed structured protocol输入不称模型生成回合。未知命令仅在自有项目 `printf started` / `sleep 6` / `printf ended`，没有网络或用户文件。

`/tmp/shellspan-phase5-pipeline-unknown-final-Q6xL22/pipeline-ready.json`在实际ToolExecution已持久化且实际marker仍started时才ready（executionInFlight）；PID22319 / startTime1791355603 / 全argv/root/identifier 核对后只中断此App，退出137。actualready记录own descendants bash22344/22348、sleep22349及startTime/cwd；命令按6秒自然完成，ps全部消失，marker实际startedended一次，之后才同根恢复，未向descendant或重用PID发信号。

同根 `pipeline-result.json` passed=true、10 checks true、PID22645：实际恢复executionInFlight与uncertain gate，oldapproval不可执行、resume必须先reconcile，marker不重放。验证原App/同startTime descendants已结束和实际文件单次效果后，清理本fixture无active model-driver的idle registry residency（真实stop_admission/cancel/await_idle/detach，不改journal/Header），调用公开reconcile_recovery ConfirmedApplied记录真实证据；不让人为protocol entry自动wake成不存在的LLM driver。之后新的explicit NativeAdapter请求才写fresh marker、实际Seatbelt，Workspace保持，sourcePtyWrites=0、无模型请求。实际两ExitRequested+Exit、工具退出0、ps PID22645不存在。

旧 unknown root `/tmp/shellspan-phase5-pipeline-unknown-TqS25A/pipeline-result.json` false保留：人工protocol entry缺modelRegistry binding，公开reconcile自动wake造成真实MODEL_REGISTRY_UNAVAILABLE并ended，后续新prepare正确拒绝closed。只修fixture清理自己的idle residency后fresh自有case，不回滚/改failed journal或产品wake；不将这归因为效果重放漏洞，也不冒称完整resident LLM自动恢复。

该protocol10本身不覆盖生成模型/常驻driver自动继续，已由下面独立真实模型11场景补验；所有结果/资源/queued lane组合、child/fleet、远端、UI及更多退出/平台仍各按原要求验证。具体WaitingApproval/unknown强证据不当全部business覆盖。硬中断只自有新App，未执行历史中止反例、用户server安装或sudo，bearer不写report/config移交。

### 原要求 R17 新普通网络证据（只读核对，未重跑）

| 原始日志 / 实际source | 已确认范围 |
| --- | --- |
| `/tmp/shellspan-phase2-network-matrix.log`：2 passed / 0.44s；`native/macos_network_acceptance.rs` | actual owned IPv4/IPv6/IPv4-mapped `::ffff:127.0.0.1` TCP 和 Unix listener；先相同宿主Node baseline真正连接，再production默认restricted Node与普通子Shell连接失败且server无新连接。不是模拟网络错误，也不以不可达baseline冒充隔离；只这些端点/子程序范围 |
| `/tmp/shellspan-phase2-network-request.log`：1 passed；同专属source `phase2_network_request_rejects_metadata_and_local_literals_before_dispatch` | 生产network_requests对元数据类v4/v6、loopback/mapped字面量实际校验拒绝。无DNS/网络dial，不连接真实cloud metadata；不是 Engine实际派发或全部域名解析证明 |
| `/tmp/shellspan-phase2-ssh-forward.log`：1 passed / 0.64s；`native/macos_ssh_network_acceptance.rs` | 普通账户独立OpenSSH、自生成fixture host/client keys和专属known_hosts，真实宿主 `ssh -W`转发到ownserver并回传marker；相同参数restricted默认network deny未到own服务。不读userkeys、不改user/systemSSH配置。只 -W形式/默认拒绝，不升级为已授权公网proxy中的SSH或所有forward形式 |

这些ordinary网络结果不重跑历史中止的安全反例，不制造fakebackend，不向第三方内网/真实metadata发请求。Root最新 source忙项与所有缺口仍按其范围验证，不能据 2+1+1 就写所有网络协议完整通过。

### 当前选定真实模型的缓存授权联动（新正面证据）

仅复用既有 `native_agent_check::check(cache_writes=true)`，没有新增或替换模型/私钥/后台，没有改用户data、系统认证UI、keychain ACL或生产允许范围。只读开发默认routes，要求仍是已明确选定MiniMax-M3，credential backend限该reference；缓存为新的account-owned TempDir，在应用Root之外。此次无需修改helper，因为实际写入只涉及明确批准的独立cache。

`/tmp/shellspan-phase5-cache-model-6nNARJ/model-check.json`：passed=true、mode=cache-writes、modelId=MiniMax-M3、requests=5、nativeResults=2、sourcePtyWrites=0、initialApproval=true、reusedWithoutApproval=true、approvalRequiredAfterRevocation=true；统一exec退出0，按确切fixture argv核对无活App。实际模型首次请求由client批准session范围，经生产签发/Seatbelt写入并读回ownedcache内容；第二回合同目录资源复用不重复审批并获得真实原生结果；实际Runtime撤销/停止与显式恢复后，第三次模型请求再次要求审批，验收拒绝该请求。

旧 `/tmp/shellspan-phase3-cache-model-CHEx7a` requests=0 尝试仍未通过，保留原日期/失败含义；本次5次真实新请求提供独立正面闭环，不能把旧无请求结果改成通过，也不推广任意模型、cache目录、UI或secret用途。原正常恢复13/17、当前关闭17/19、七个场景、公网依赖下载没有因这个新case重复。

### 真实模型生成未知派发与常驻 Driver 的默认恢复路径

只在专属 `native_model_recovery_check` 增加 finite `model-unknown-seed/reopen` 分支，用同一当前已授权 MiniMax-M3、readonly default reference，不读其他用户secret或改变模型/key/ACL。真实 Runtime.start/receive_submission 让 driver 生成精确自有 `printf started >> unknown-marker; sleep 6; printf ended >> unknown-marker` foreground 调用，只批准该操作一次；没有额外资源、网络或用户文件。

`/tmp/shellspan-phase5-pipeline-model-unknown-O9WZbn/pipeline-ready.json`：modelRequests=1、actualDriverAssistantCall=true、executionInFlight、sourcePtyWrites=0。只有实际 ToolExecution/journal 和实际 marker仍started 才ready；original App PID28303 / startTime1791357668 / full argv/freshRoot/实际identifier匹配后仅该App SIGKILL，退出137。记录的 source bash28310、native bash28351、sleep28352带真实startTime/cwd，命令按6秒自然完成，ps全部消失且 marker实际startedended一次才reopen；没有信号到child或别的App。

同根 `model-recovery-result.json`：passed=true、11 checks true、PID28450、MiniMax-M3 seedModelRequests=1、totalModelRequests=2、sourcePtyWrites=0。第二实际Wry通过公开 Runtime.start 恢复真实 selected-model binding / 常驻driver，不手动替换或detach它；uncertain保留、旧approval拒绝、resume要求human reconciliation，在人工证据核对前新增模型请求数为零。确认实际单次文件效果和原App/descendant终态后，公开 reconcile_recovery ConfirmedApplied 使真实driver继续；after-cursor实际 RequestStart 与 TurnEndCompleted 证明新生成回合简短完成，noAdditionalToolSideEffects=true、oldEffectExactlyOnce=true、Workspace不变、uncertainty只由证据解除。

`model-recovery-events.json`有两次实际ExitRequested+Exit，统一exec退出0，ps PID28450及原全部PIDs不存在。额外tool/side effect一律不批准，若模型偏离则本scene会false并区分安全拒绝与目标未达；此次真实结果没有发生偏离，不通过mock/fakeCompleted或私改wake/recovery/journal让通过。

这一新增场景闭合原 R09 正常常驻模型上下文的 unknown-reconcile-autoWake 路径，保留protocol10/真实waiting8各自证明范围，不继续擅自增加无限压力或全模型业务要求；各named其他平台、UI、SSH部署、全部entry能力与最终匹配回归仍按原计划完成。其他已过7/normal13+17/关闭17+19/模型waiting8/cache5没有重复。

上述首轮报告不计全局门禁通过，更不计实际版本回退、远端 restricted admission 或整个阶段完成。验收 helper 的早期 HTTP 客户端问题已改为真实 async reqwest，并增加失败/panic 时经生产 shutdown 的自身清理；未以模拟失败或改变预期结果制造成功。

### 2026-10-07 分阶段提交前回归

当前完整工作树执行 `pnpm test`：296 个文件通过、1 个跳过，2581 项通过、2 项跳过；`pnpm build` 退出 0。`cargo test --manifest-path src-tauri/Cargo.toml`：1228 项通过、76 项忽略，另 5 项集成测试通过。忽略项不计验收通过。

`pnpm check:rust:includes`、`pnpm check:ai-styles`、`pnpm check:llm:catalog` 均退出 0；以 Vitest 执行协议契约测试，3 项通过；设置界面 WebKit 双语宽窄渲染脚本退出 0。该渲染结果仅证明脚本覆盖的界面行为，不证明真实远端执行或平台安全边界。

`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 未通过：当前修改文件及未修改的 `native/mcp.rs` 存在格式差异，未整体格式化工作区。代码按策略契约、本地执行与关闭清理、授权与界面、远端执行、验收与文档组织为五个相互依赖的提交；上述检查针对完整工作树，不表示各中间提交可独立构建，也不改变 Windows 实机及其余平台验收缺口。
