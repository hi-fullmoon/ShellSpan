# Agent Shell 沙箱阶段 3 实施与验收记录

当前状态：2026-10-07（Asia/Shanghai）。**阶段 3 尚未整体验收。macOS 原生 Direct 为 partial，已接入一次／会话的项目及非敏感外部普通文件读取、明确缓存目录读写、公网 TCP 目标代理和 Node 回环服务授权；策略切换、配置记忆和资源审计已实现。** 已验证 macOS SSH Direct 的实际能力可以在设置中显示，远端资源扩展仍不支持。硬链接别名、同账户恶意竞态及恶意后代进程不承诺完整隔离；Windows 实机仍待提供。阶段 4／5 的完整门禁不因本报告完成。

证据保存限制：宿主 `/tmp` 在收尾期间被清理，下文原始临时路径目前不可用；路径保留作为当轮记录，不冒充当前可下载文件。已读取报告的范围与结果整理在 [工具记录摘录](../../tests/agent-shell-sandbox-phase-3/evidence/observed-reports.md)。后续本阶段相关检查日志保存在 `tests/agent-shell-sandbox-phase-3/evidence/`，不因此重复已经通过的真实模型场景。

## 本轮已完成的子项

- [x] 普通审批恢复单参数调用。无资源时 adapter.approve 与 agent_runtime_approve_tool 不再多传 undefined；资源请求显式传 once/session，Rust Option 缺省仍为 once。没有放宽旧断言或伪造 IPC 成功。
- [x] 顶部会话设置及摘要显示 readOnly/workspace/host 可读双语名称、实际主机、根目录、能力与限制。当前完整 native gap 已翻译，保留历史能力说明含义，不把 partial 显示成 full。底部仅保留操作审批与执行方式，保留用户其他 UI 改动。
- [x] 创建受限会话的目录冻结与 permissionMode 独立；requestApproval/scopedAutopilot/operator 都需要确定项目根，缺少根时明确拒绝，不切换 host。既有历史会话保持原策略。
- [x] 一次／当前会话资源选择与原操作审批合并，默认本次。具体文件、缓存目录、网络目标／DNS 选择与本地端口同屏显示；新调用重置范围，等待决定时锁定控件。
- [x] 审批同步引用去重，不等待 React 状态更新才锁定；无资源回调也保持无额外参数。错误去重沿用现有 Toast／上下文状态机制，撤销成功只在真实 IPC 与刷新成功后通知。
- [x] 会话设置经只读 agent_runtime_get_sandbox_authorizations 查询真实内存资源、到期时间和运行中／未确认结束的进程数。失败显示尚未确认，不从历史事件、配置或旧结果推断仍有授权。
- [x] 临时授权不持久化；会话记忆最长一小时且绑定创建时间、目标、规范化根和 bindingRevision。每次执行重新签发有限期原生能力，取消同时撤销任务的已签发能力；恢复、重绑、到期和撤销不能复用旧授权。
- [x] scopedAutopilot 在已验证的本地 workspace Direct 中，自动审核现有 tree-sitter 能识别的 pnpm/npm 构建测试脚本、Cargo 检查及基本文件修改。没有给 unknown 命令开白名单；Host、远端、readOnly、MCP 不适用。requestApproval、敏感读取、破坏性／提权／外部副作用继续按原规则审批。
- [x] 受限执行方式不能选普通可视终端；服务端也拒绝该请求，保持绑定不变。执行方式切换检查空闲、终端租约及本任务后台／未确认进程。
- [x] 会话策略切换与 Runtime.start、NativeAdapter execute 共用转换锁及共享关闭 admission。检查空闲、队列、审批、子会话、终端租约、后台及未确认进程；提交时与子会话创建共用 store 锁复查。成功后更新 bindingRevision、清除旧记忆和已签发能力，远端新策略走真实预检，没有 Host fallback。
- [x] 项目／连接默认策略及非敏感缓存目录候选保存为版本化偏好。配置读写串行；损坏配置明确阻止默认启动，并提供重新加载、清除或显式本会话策略恢复。候选进入启动前 Header／模型上下文数据段，必须重新申请 writePaths，不是授权。
- [x] sandbox/resource_audit 记录批准／复用／撤销的 once/session、精确资源、实际期限、绑定版本及清理结果，不保存 bearer。审计失败执行暂停、撤权和取消，并保留清理错误。
- [x] 缺少根目录时，生产控制器首次发送打开现有目录弹框，使用实际本地目录元数据规范化根；选择后恢复草稿，等待新的明确发送，不提前创建会话或重放操作。目录查询按实际连接代次缓存，提示符／集成元数据更新不会反复清空根。
- [x] 新远端意图使用真实 agent_runtime_verify_remote_sandbox_target，结果须与最新请求、目标、目录、策略及连接代次／配置一致；30 秒或身份变化后失效，启动继续重验证。UI 不把本地探测能力用于远端，展示规范化根和远端限制。

## 工作区外普通文件读取

readPaths 最多 8 个已有普通文件；项目外必须不是敏感／系统／凭据路径，也不能属于应用运行时存储。整个 HOME、目录及末级符号链接拒绝，项目内配置文件审批仍沿用原规则。批准仅增加精确文件 literal 的读取，不增加目录读取或写入；单次及会话范围使用现有签名、期限、撤销和绑定校验。

external_ordinary_file_requires_read_approval_without_sibling_or_write_access 实际验证了：无授权不能读；Operator 初次仍需审批；单次读取真实内容而不形成会话授权；批准文件不能写、兄弟文件不能读；会话授权可复用相同文件，新增兄弟文件重新审批；撤销使已经签发的复用令牌失效，后续重新审批；目录、整个 HOME、私钥名称、dotenv、末级链接及真实运行时数据库请求拒绝。源 PTY 写入 0。模型工具字段、运行时提示、UI 通知及协议均使用同一范围，不声称支持任意外部资源。

## 缓存目录授权的真实范围

writePaths 仅接受本地 workspace 模式、最多 8 个现有且属于当前账户的具体缓存／临时子目录。使用标准文件系统元数据与 canonicalize，冻结规范化目标；不提前读取目录内容。公共临时／缓存根、整个 HOME、项目目录／祖先、系统／敏感目录、运行时存储及软链接目录拒绝。ReadOnly 不接受该扩展。

WritePath 的类型和精确目录进入既有完整策略摘要与 HMAC，表示该目录的读写权限；内核核对后才向 Seatbelt 添加对应目录规则。独立凭据拒绝和 dotenv 写入拒绝保留，不授予任意 HOME 写入。此为已声明的部分路径边界，不声称抵抗硬链接或同账户恶意竞态。

真实原生测试已验证：无授权写入失败；Operator 初次仍需人类批准；批准后实际创建、读取缓存文件；单次不变成会话授权；会话复用仍签发独立令牌；未授权相邻目录不能写入；短有效期停止真实后台进程；撤销使已签发的旧原生能力也失效；后续重新要求审批；只读、HOME、系统及运行时目录拒绝。源 PTY 写入为零。

## 当前证据

以下表中的早期最终批次保留当时范围；后续策略／配置／审计／外部读取和 GUI 的新证据见表后补充，不将较早数字称为本次最终修订结果。

| 检查 | 实际结果／证据 |
| --- | --- |
| 原 adapter 回归与资源参数契约 | 35 passed；无资源单参数、有资源 once/session 显式参数；IPC 拒绝路径验证序列化，不使用成功替身证明后端 |
| 最终 pnpm test --reporter=dot --silent | 294 files passed / 1 skipped；2573 passed / 2 skipped；/tmp/shellspan-phase3-frontend-final.log |
| 最终 cargo test --manifest-path src-tauri/Cargo.toml -- --quiet | 1199 passed / 66 ignored / 0 filtered；另 5 项集成测试通过；/tmp/shellspan-phase3-rust-final.log |
| pnpm build | TypeScript strict 与生产构建通过；原有体积／mixed-import 告警；/tmp/shellspan-phase3-build-final.log |
| 原生自动审核执行 | 实际 pnpm build/test、cargo check/test --offline、touch/mkdir；签名与 Direct 派发真实运行，保留原审批负例；/tmp/shellspan-phase3-autopilot-native.log 与最终 Rust 回归 |
| 缓存授权 | 真实 NativeEngine／Session store／PTY／签名／Seatbelt；/tmp/shellspan-phase3-cache-native.log |
| 状态、到期、重绑、恢复 | 真实授权存储及绑定测试；/tmp/shellspan-phase3-status-tests.log；真实读授权后查询 active、撤销后 none：/tmp/shellspan-phase3-grant-status-native.log |
| 真实后台状态 | sleep 进程创建后计数 1，取消并确认结束后 0；/tmp/shellspan-phase3-background-test.log |
| 最终实际审批显示 | Chromium/WebKit，中文／英文，360/760px；文件、网络与缓存范围、键盘选择、标题焦点、滚动与固定操作栏；/tmp/shellspan-phase3-approval-final-browser.log |
| 最终实际设置显示 | 真实 native check JSON，WebKit，双语 × 1280/400/320px；/tmp/shellspan-phase3-current-native-capability.json、/tmp/shellspan-phase3-settings-final-browser.log |
| include/style/catalog | 47 个 include 文件格式、AI 样式、55 个模型 catalog 检查通过；/tmp/shellspan-phase3-includes-final.log、/tmp/shellspan-phase3-styles-final.log、/tmp/shellspan-phase3-catalog-final.log |
| cargo fmt --check | 本轮改动已格式化；仍仅未修改 native/mcp.rs:754 既有差异；/tmp/shellspan-phase3-fmt-final.log |
| git diff --check | 通过 |

设置的真实原生 IPC 验证：独立 Wry 窗口加载生产 AiSandboxSettings；实际显示有效文件资源、到期时间、后台数 0、partial 与限制。撤销后原实例停止，MiniMax-M3 再次请求同文件时重新要求审批；/tmp/shellspan-phase3-native-gui-ImtKDG/model-check.json：passed=true、requests=5、nativeResults=2、sourcePtyWrites=0。此证据属于本轮缓存扩展前的文件授权／状态／撤销路径，不冒充缓存模型联动验收。

阶段 2 已有真实公网／服务证据已核实：/tmp/shellspan-network-model-B6Fhyg/model-check.json（MiniMax-M3，2 requests、1 nativeResult、proxyClosed=true、sourcePtyWrites=0）；/tmp/shellspan-network-production-acceptance.log（生产网络原生命令与清理）；/tmp/shellspan-local-service-acceptance.log（真实文件服务、scope／probe／取消／到期）；/tmp/shellspan-vite-service-acceptance.log（真实 pnpm dev／Vite）。本轮不重复这些已通过单项，不把组件输入／渲染检查当后端授权证明。

历史缓存模型尝试：/tmp/shellspan-phase3-cache-model-CHEx7a 的事件仅 session/created、agent/created，模型请求数 0，没有最终报告；该进程已结束，这次尝试没有验收通过。电脑操作工具拒绝读取系统凭据窗口，未确认是否存在权限提示；没有处理该系统窗口或修改凭据配置。

后续同范围真实模型证据已核对：/tmp/shellspan-phase5-cache-model-6nNARJ/model-check.json 为 passed=true、MiniMax-M3、requests=5、nativeResults=2、sourcePtyWrites=0，initialApproval、reusedWithoutApproval、approvalRequiredAfterRevocation 均为 true。该证据补齐缓存请求→显式批准→真实读写→会话复用→生产撤销→重新要求审批；不把旧请求 0 的记录改算通过，也不外推 Windows 或其他运行时。

### 2026-10-07 后续修订证据

| 检查 | 实际范围与路径 |
| --- | --- |
| 工作区外普通文件读取 | 上述真实 NativeEngine／HMAC／Seatbelt case，/tmp/shellspan-phase3-external-native.log，1 passed；包含 once/session、精确读、拒写／兄弟／敏感／目录／链接／运行时存储、撤销及源 PTY 0 |
| 策略并发 | policy_switch_serializes_unregistered_session_with_real_background_launch，/tmp/shellspan-phase3-policy-concurrency-native.log；实际 Runtime.start 与策略共锁拒绝，真实 sleep 存在时拒切换，确认取消后允许，旧绑定失效、审批不变、PTY 0 |
| 审计与实际 IO 失败 | resource_audit_records_actual_once_session_expiry_and_revocation_without_bearers，/tmp/shellspan-phase3-audit-failure-native.log；实际 grant、缓存文件执行及审计，临时 journal 只读导致真实 append 失败，同一生产回滚方法停止既有 sleep、清除会话资源和已签发能力，待执行 marker 未创建。不是 fake append 成功／失败，也不替代完整 Wry 审批故障注入验收 |
| 配置持久化／候选 | 同日志 3 passed：真实 SQLite 偏好 reopen、Header cache candidates 回放且没有 live authority；/tmp/shellspan-phase3-cache-prompt-native.log 验证候选是数据并要求新资源审批 |
| 项目目录规范化 | canonical_directory_preview_matches_freezing_and_rejects_files_and_relative_paths，/tmp/shellspan-phase3-root-native.log；真实目录及正常目录别名与同一 freeze 计算一致，拒绝相对路径和文件，不创建会话或授权 |
| 真实远端设置 GUI | /tmp/shellspan-phase3-settings-wry-NQgJFL/settings-review.json；独立 Wry＋生产验证 IPC，实际工作区／只读验证均从 unavailable 更新 partial，展示 SFTP 规范化根及已翻译限制。切换策略立即清除旧事实，30 秒失效；关闭 exitCode=0、源 PTY 0。实际界面由电脑操作检查，没有模型或资源扩权 |
| 真实首次发送／目录 GUI | /tmp/shellspan-phase3-root-wry-eRp0IT/settings-review.json；真实本地 PTY、生产 AiWorkspaceController／adapter／IPC、真实 SQLite 与目录元数据，中文和英文首次发送打开原 Dialog，确认后恢复草稿并采用记住的 readOnly，仍未发送。sessionsCreated=0、sourcePtyWrites=0、exitCode=0；只证明未派发的草稿恢复，不冒充后续模型／工具执行 |
| 最新真实 GUI 状态修复 | /tmp/shellspan-phase3-root-stable-XOvRdF/settings-review.json：同一生产控制器／真实 SQLite／PTY／目录 IPC；确认目录后只清理匹配的旧根错误，草稿不发送；中文和英文实际忘记配置后当前 readOnly 保持，实际 Toast 与配置 UI 更新，随后重存／再次移除及目录建议 Esc、取消焦点均检查。modelRequests=0、sessionsCreated=0、sourcePtyWrites=0、exitCode=0，最终偏好 defaults={}；自有应用已退出 |
| 本次 UI 回归 | /tmp/shellspan-phase3-current-browser.log，WebKit 双语 × 1280/400/320px 设置与菜单，加 360px 目录弹框和实际无 IPC 时的远端失败显示；同源 native check JSON 只作渲染输入，不代替上述实际 Wry IPC；/tmp/shellspan-phase3-default-policy-focused.log 92 passed |
| 本次共享基线 | /tmp/shellspan-phase3-current-frontend-full.log：2581 passed / 2 skipped，296 files passed / 1 skipped；/tmp/shellspan-phase3-current-rust-full.log：1228 passed / 75 ignored / 0 filtered，另 5 项集成；/tmp/shellspan-phase3-current-build.log 通过；后续小修订仍需最终汇总检查 |
| include／样式／catalog | /tmp/shellspan-phase3-current-includes.log：50 include 文件；/tmp/shellspan-phase3-current-styles.log、/tmp/shellspan-phase3-current-catalog.log 均通过 |

最后状态：完整 `pnpm test`、`pnpm build`、`cargo test` 和 include 检查的 exec session 最终退出码均为 0；前端已实际读取 2581 passed／2 skipped。Rust 最终汇总在临时日志清理前没有读取数字，不推算，较早 1228／75 仍仅是对应基线。保存到仓库的后续相关前端／协议／默认配置检查 `current-focused.log` 为 102 passed；`current-audit-native.log` 为 3 passed，包含真实 journal IO 失败回滚；`current-external-native.log` 保存完整的外部普通文件授权 case。`current-types.log`、`current-styles.log`、`current-catalog.log` 通过。本阶段 source 已稳定；全局 fmt 仍有共享修订差异，独立新增模块及本阶段对应小段已整理，不整体覆盖其他会话代码。

目录复查窗口 /tmp/shellspan-phase3-root-wry-gU4X36 的验收条件被交互改变，实际创建了 Host 会话并有本地模型连接尝试；没有工具执行，源 PTY 为 0，但不能记为零请求目录验收。保留该轮日志及结果，不改写事件。当前修正会在选择有效目录后仅清除匹配的旧根错误；忘记默认配置保留当前已选策略，改变的只是后续默认配置。并发输入时先停止窗口提交；独立无热更新源服务器避免其他会话编辑替换正在检查的界面。

## 原计划仍须补齐

- [x] 策略切换、配置记忆及资源审计已实现，并有上述对应真实／回归证据；后续共享修订及 UI 小修复仍须汇总验证。
- [ ] 可信运行期越界诊断与基于该证据的权限扩展建议。现在按明确资源请求做审批与元数据校验；普通非零退出、stderr 或模型解释不提供该证明。不得自动重放有副作用或执行状态不确定的命令。
- [x] 缓存真实模型联动，限定上述 MiniMax-M3 正常读写／批准／复用／撤销场景。
- [ ] Windows 实机、用户主工作台全部组合及完整 Wry 审批审计 IO 故障注入验收。
- [ ] 阶段 3 整体门禁与全计划验收。

后续本阶段只编辑对应 UI／协议／诊断及验收小段。阶段 4 的远端执行／绑定实现、阶段 5 的恢复专属模块和 native_agent_check 早期 hook 保持其专用会话负责，不做共享文件整体格式化。

## 历史证据说明

2026-10-05 首轮只有独立界面工作，生产受限后端当时 unavailable；其 125/144 项相关 UI 检查和 2556 项应用回归不表示当时完成原生授权。未限定目录的 Vitest 曾误收集阶段 2 Node 示例，报 No test suite found；阶段 2 将它改名 sum.node-check.mjs 并更新 node --test 脚本后，全量通过。原失败日志及阶段 2 记录保留，不据当前结果改写历史。

随后文件一次／会话授权及真实模型／GUI：/tmp/shellspan-grants-native-final.log、/tmp/shellspan-session-model-CGfafR/model-check.json、/tmp/shellspan-native-revoke-tuQiHq/model-check.json 均保留原日期和覆盖含义。早期 Unix 网络兼容原型不曾授予生产权限；当前生产网络／服务闭环以后续实际证据为准。

没有创建 commit、tag、推送或新的 Codex 会话；测试仅创建自身临时 Session／应用／PTY。没有修改 titlebar、用户其他 UI、系统安全设置、用户模型凭据配置或安装特权组件。
