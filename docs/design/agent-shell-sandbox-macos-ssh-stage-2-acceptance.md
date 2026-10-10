# macOS 与 SSH 完善阶段 2：主工作台链路修复与验收

日期：2026-10-08；状态更新：2026-10-09。状态：**阶段 2 局部修复与分项验收完成，整体待完成**。以下当前记录不把组件、真实资源层和工作台模型执行相互替代。

## 2026-10-09 当前前置复核与范围

阶段 1 的用户完成决定与延期账户范围已读取。合并核对 `stage1-local-controller-final-r9-2026-10-08/report.json` 和 `stage1-running-preflight-final-2026-10-09/report.json` 中最新覆盖的 59 个源码哈希：本次开始只有 `verify_stage1.py` 与旧快照不同，该脚本已接入阶段 1 收尾入口；生产恢复源码匹配。之后本阶段只修改明确的前端预检／键盘行为和 debug 验收入口／隔离名单。生产恢复、债务、审批、取消及 SSH 归属契约继续保留。HEAD 为 `0bfc32af6dd65a4aa5c8aff457bb0a9d939e6260`，保留本次开始时全部未提交改动，不创建提交或推送。

## 本轮修复

当前继续记录见本文末尾的“继续实施：真实模型、队列与公共 IPC”。前述钥匙串阻塞已在只读验收路径处理，真实模型与本地命令不再处于原先的 0 请求状态；历史失败和当时统计仍保留，不覆盖原始证据。

- `useRemoteSandboxVerification` 原先以 JSON 值相等判断结果是否属于当前来源。真实 `workspace → readOnly → workspace` 会重新显示旧结果，也会接纳在途旧结果。现在每次绑定值变化产生新的内存代际，结果、pending、返回校验与到期清理使用同一代际；卸载使旧请求失效，StrictMode 的重新 setup 仍能正常预检。没有扩大后端能力或恢复执行授权。
- `ProjectDirectoryInput` 原先对全部按键 stopPropagation，候选关闭后 Escape 仍不能到达外层 Dialog。现在仅在实际候选／状态面板打开时消费 Escape，之后交给 Dialog；输入、目录完成和确认方式保持不变。未调整布局、尺寸、颜色或控件类型。
- debug 设置 App 加入精确 known_hosts 隔离名单，fixture 安装前再次校验信任文件处于本次 app 数据根。新增真实 SSH hook 回归入口、完整远端 controller 入口和可选现有默认模型入口；前端 fixture 按 TerminalStore 的真实 API 传入 profileId。所有结果 IPC 只接收固定布尔字段，不允许写任意模型／凭据文本。
- 真实模型入口只读开发数据库中现有选定的 MiniMax-M3 路由，将该配置及原 credential reference 初始化到独立 fixture；凭据管理器只读该引用，不改用户路由、不复制 secret、不迁移凭据。初始化失败使用诊断报告，不访问尚未 manage 的 Runtime。

## 当前真实证据

| 场景 | 结果与证明范围 | 证据 |
| --- | --- | --- |
| 远端预检结果的策略往返 | 修复前两个失效断言均 false；修复后完成结果和在途结果均丢弃，新的实际 SSH 预检仍成功；StrictMode 包含真实 setup/cleanup。没有替换 IPC、模型或 backend | `.phase4-acceptance/stage2-verification-before-2026-10-09/` 保留失败；最终新修订使用本记录末尾报告 |
| 实际本地完整 controller | 自有真实 PTY，键盘输入并绑定临时目录；保存的只读配置在摘要与设置一致，partial 限制可读，空态正常。宽窗口 620×680、窄窗口 360×530，中英文均实看；Tab 能访问滚动底部限制详情，Escape 后焦点回设置按钮。0 session、0 model request、PTY writes=0 | `.phase4-acceptance/stage2-workbench-local-2026-10-09/` 的 `settings-review.json` 与 5 张 PNG |
| 实际远端完整 controller | 自有 loopback 普通账户 sshd、真实 profile 和源 PTY；首次选择 project-alias，预检期间显示加载，成功显示规范化 project 与 partial。策略改为 workspace 再切回 readOnly，摘要与设置仍 unavailable，不复活旧结果；0 session、0 model request、PTY writes=0 | `.phase4-acceptance/stage2-workbench-remote-2026-10-09/fixture/settings-review.json`、各 PNG 与 CUA 操作记录 |
| 目录键盘关闭 | 修改前真实 Wry 的第二次 Escape 仍不能关闭目录 Dialog；修改后关闭并聚焦 composer。真实浏览器目录服务读取仓库文件系统，400×800、1000×800、600×420 三尺寸覆盖候选关闭后第二次 Escape 关闭 Dialog，原目录选择／IME／防抖／迟到返回回归均通过 | `stage2-directory-keyboard-2026-10-09.log` 与 `escape-dialog-closed.png` |
| 审计、授权与终态 | 现有生产层 sandbox_audit 三项通过：真实资源申请、Once／Session、过期、撤销、真实日志写失败阻止待执行 marker 并清理已存在进程；不代表工作台错误去重／恢复 UI 或模型链全部通过 | `stage2-audit-regression-2026-10-09.log` |
| 真实模型工作台尝试 | 实际 MiniMax-M3 配置及完整 controller 已加载。固定临时 marker 在发送前 absent；UI 输入确认期间，实际采样停在 `agent_runtime_start → RouteStore::credential → ReadonlyModelCheckBackend → NativeKeychainBackend → Security`。本次退出 code=0，1 个 session、0 model request、PTY writes=0；没有工具派发，不计模型通过 | `.phase4-acceptance/stage2-workbench-model-r2-2026-10-09/` 的 screenshot、`sample.txt` 和 `fixture/settings-review.json` |

本地／远端 UI 是独立 Wry 内实际 `AiWorkspaceController scope="terminal"` 和默认 adapter／IPC，不是用户正在使用的主应用实例；不外推整应用侧栏组合或远端模型执行。远端手动输入路径已验收，SFTP 自动完成仍缺当前 harness 的 profile hydration／注册环境，不记为通过。

模型首次初始化尝试的 MISSING_CREDENTIAL 和初始化退出错误保留在 `stage2-workbench-model-2026-10-09/`；该轮没有 Runtime／模型请求通过结论。随后使用与既有恢复验收一致的配置快照初始化，未放松生产路由变更 API 的凭据引用检查。钥匙串阻塞没有以明文 key、替身或绕过系统授权处理，也没有重放原请求。

## 本轮待完成矩阵

| 计划项 | 当前状态 |
| --- | --- |
| 首次远端选目录、预检及实际模型启动／执行 | 选目录与预检有真实 controller 证据；模型执行、SFTP 自动完成仍待验收 |
| 设置、摘要、审批、工具结果与模型上下文一致 | 设置与摘要、partial 限制已实看；真实审批／工具结果／模型上下文仍待验收 |
| 授权申请、复用、撤销、过期和恢复 | 资源层真实回归已通过；实际工作台活动资源撤销与恢复提示仍待验收 |
| 来源／账户／连接代际／目录变化 | 策略往返真实回归已通过；其他组合仍待对应真实 UI 证据，不同真实 macOS SSH 账户继续延期 |
| 队列、子 Agent、fleet | 仍待真实入口验收；子 Agent 继承与收窄代码已定位，静态核对不计通过 |
| 审计写失败、错误去重、键盘焦点 | 生产层写失败门禁及目录键盘回归通过；工作台审批错误和 Toast 去重仍待真实验收 |
| 宽窄容器、中英文及状态 | 本地空态／设置、远端加载／未预检／成功／失效状态有分项记录；完整恢复和审批／工具结果状态仍待完成 |

阶段 3 前置条件仍未满足。当前质量结果与最终源码报告见本文末尾；跳过与 ignored 不计通过。

## 2026-10-08 历史前置核对

以下只保留当时前置尚未完成的证据范围，不代表阶段 1／阶段 2 的当前状态。旧 `verify_stage2_prerequisites.py` 固定 pending 仅用于当时证据身份核对，不作为当前阶段完成认证工具。

### 历史实际核对

- 先读取 [阶段 1 验收记录](agent-shell-sandbox-macos-ssh-stage-1-acceptance.md)，其末尾明确要求阶段 1 未完成时不得开启阶段 2。
- HEAD 为 `689509decac0d39efbf08cf180d9e237d3212a86`；保留本次开始时全部未提交文件。本次仅增加前置核对脚本、此记录和计划链接，没有修改生产逻辑、界面或既有阶段 1 证据。
- 对 `.phase4-acceptance/stage1-final-r4-2026-10-08/report.json` 的 18 个源码 SHA-256 逐一核对，全部匹配；核对结束再次计算，`sourceUnchanged=true`。这只确认记录对应的源码未变化，不扩大旧验收范围。
- 当前生产路径核对：`NativeToolAdapter.configure` 配置持久账本；`NativeToolEngine.admit_operation` 核对恢复债务；`ProcessRegistryNative.ensure_capacity` 再核对债务与未确认终态；`prepare_for_shutdown` 保留债务错误。`DirectIntent` 只有当前内存实例能解除自身行，异常丢弃关闭后续派发，重启读取历史债务继续拒绝。
- 重新执行 `cargo test --manifest-path src-tauri/Cargo.toml direct_ownership -- --test-threads=1`：3 passed；执行 `agent_runtime::native::process::tests` 同参数：20 passed。进程组、取消、启动注册窗口和目录清理的真实生产层回归不代替工作台、模型、队列或 fleet 验收。
- 新证据：`.phase4-acceptance/stage2-prerequisites-2026-10-08/report.json`、`ownership.log`、`process.log`。新脚本 `tests/agent-shell-sandbox-macos-ssh/verify_stage2_prerequisites.py` 保存引用报告哈希、源码哈希和实际测试命令。它只核对前置证据，不具备认证整阶段的能力，最终退出码 2 表示阶段 2 门禁未通过，即使所选回归全部通过也不放行。

### 当时未解除的前置条件

| 条件 | 当前事实 | 后续所需证据／行为 |
| --- | --- | --- |
| 真实模型待审批／已授权未派发中断 | 最终修订没有通过记录；本次未执行模型请求 | 自有 Wry App 在各中断窗口留下真实模型、审批和恢复事实，证明旧授权不复活 |
| Wry 实际 pipeline unknown-dispatch 硬崩溃 | 资源层中断与正常恢复已有记录，不能替代该窗口 | 实际 pipeline 硬崩溃及重启，核对副作用、资源债务与派发门禁 |
| SSH 硬崩溃丢失 live cleanup key | 持久账本只保存债务，不保存可认领资源的凭据；没有可信历史资源解除 IPC | 先建立可验证的所属资源恢复契约，再完成真实崩溃验收；不得删除账本行、按 PID／名称清理或用自然结束解除 |
| 多远端会话、不同账户与反复断连 | 既有自有 fixture 的多个 job 不等于独立 Agent Session／账户组合 | 各独立生产入口与真实普通账户 fixture 的隔离、取消、重绑和清理事实 |

不能通过本次选择的回归消除上述缺口。全量 Rust 测试和全仓格式检查的既有失败继续以阶段 1 记录为准，本次没有重跑，也没有将它们改记通过。

### 当时的待验收矩阵

| 计划项 | 状态 | 必须记录的入口与事实 |
| --- | --- | --- |
| 首次选远端目录、预检、启动、执行及绑定变化 | 待完成 | 主工作台真实 SSH 路径；目标、账户、连接代际、目录和策略变化后的过期结果丢弃 |
| 设置、摘要、审批、工具结果与模型上下文一致 | 待完成 | 当前 `partial` 能力事实、中英文限制和未验证目标拒绝 |
| 授权申请、复用、撤销、过期和恢复 | 待完成 | 实际审批、活动进程终态及未确认时拒绝新派发 |
| 队列、子 Agent 和 fleet | 待完成 | 各生产入口、权限范围、过期审批和重绑行为 |
| 审批审计写入失败、错误去重、键盘和焦点 | 待完成 | 真实写入失败与实际主工作台操作；就近回归 |
| 宽窄容器、中英文、加载／失败／空态／恢复状态 | 待完成 | 实际 Wry 渲染与脱敏截图；组件和模型证据分开记录 |

本次没有阶段 2 截图或真实 UI 操作记录。阶段 1 必要缺口解除且证据匹配最终修订后，才开始此矩阵的生产修复和真实验收。

## 2026-10-09 当前质量与最终证据

- 最终真实 SSH/Wry 回归目录：`.phase4-acceptance/stage2-verification-final-r2-2026-10-09/`。四项真实预检断言均 true，`passed=true`、`sourceUnchanged=true`、`binaryUnchanged=true`、`userKnownHostsUnchanged=true`；12 个相关源码哈希涵盖本轮 hook、目录输入和验收入口。这里只表示该分项通过，`stageStatus=pending`。
- `.phase4-acceptance/stage2-summary-2026-10-09.json` 收集精确已记录截图的 SHA-256，复核当前 12 个源码和原生二进制匹配最终回归报告；模型尝试实际 journal 仅有 session/created 与 agent/created，持久 header 为 workspace／requestApproval，modelRequests=0，Direct 债务=0，原 PID 80753 absent，自有项目 absent。只观察本次已知 PID／目录，没有发信号或从这些历史观察构造清理权限。
- `pnpm test`：2454 passed、2 skipped，271 文件 passed／1 skipped；日志 `stage2-frontend-tests-2026-10-09.log`。该全量运行包含预检 hook 修复，目录 Escape 修复之后单独执行真实目录浏览回归和当前 controller／composer 两文件回归，88 passed；日志分别为 `stage2-directory-keyboard-2026-10-09.log` 与 `stage2-frontend-targeted-final-2026-10-09.log`。未把跳过项计为通过。
- 最后 `pnpm build` 通过，日志 `stage2-frontend-build-final-2026-10-09.log`；原生构建通过，日志 `stage2-native-build-final-r2-2026-10-09.log`。既有 chunk 提示和两项 container_backend dead-code 警告保留。
- 全量 Rust：1161 passed、0 failed、66 ignored，另 Petdex 集成 5 passed；日志 `stage2-rust-full-2026-10-09.log`。该运行覆盖本轮后端代码行为，之后只改 debug 模块头注释并重建／复验；ignored 不计通过。独立 sandbox_audit 回归 3 passed 的实际日志同时保留。
- 最后全仓 fmt、`pnpm check:rust:includes`、`pnpm check:ai-styles` 和 `git diff --check` 均通过，对应 `stage2-{fmt-final-r2,includes-final,ai-styles-final}-2026-10-09.log`。本轮未修改模型目录或双语文案键；未重复模型 catalog 检查。
- 原有未提交文件全部保留。本轮生产 UI 改动仅限预检结果失效和目录 Escape 行为，没有布局／样式调整。验收使用忽略目录、自有 PTY／普通账户 sshd，没有用户服务器、系统 SSH 配置、账户、用户主应用或凭据写入，也没有 commit、tag 或推送。

真实模型、远端模型执行、队列／子 Agent／fleet、完整审批与恢复 UI 仍需继续验收；当前不宣布阶段 2 完成或阶段 3 门禁通过。

## 2026-10-09 继续实施：真实模型、队列与公共 IPC

此段为当前补充结果。保留上文原修订、原失败和当时的待完成状态，不把旧报告改写成新的通过结论。

### 凭据读取与真实本地链路

只读模型验收原先使用旧的通用密码读取 API，当前可执行文件读取用户凭据库时等待系统授权。现在仅对 `ReadonlyModelCheckBackend` 改用已安装 security-framework 的精确 User keychain／generic password／service／account 查询，`skip_authenticated_items(true)` 不显示授权 UI、不给予新访问权；不可用时返回固定 `MODEL_CREDENTIAL_UNAVAILABLE`，双语反馈说明模型请求尚未发出。生产 `CredentialManager::new` 与正常 VaultBackend 的授权／存储路径没有改动，也没有修改钥匙串 ACL。`keychain::native_acceptance_tests` 使用新 UUID 的真实 OS 条目核对可授权精确读取、其他账户没有匹配、选定引用边界、禁止凭据写入／删除，并清理自身条目；两项通过。对应 `stage2-keychain-native-2026-10-09.log` 与最终复验日志。

实际用户所选 MiniMax-M3 凭据在新非交互查询下可被系统正常读取。`.phase4-acceptance/stage2-model-noninteractive-2026-10-09/live-model-facts.json` 记录了真实工作台、生产默认 adapter／IPC、模型生成、单次批准与原生控制器结果，未替换模型响应或直接从测试脚本写入 marker：

- 初始 `printf stage2 > stage2-marker` 在审批前 marker absent；真实审批后内容为 `stage2`。另两条为 `sleep 20; printf first > queue-first-marker` 和 `printf second > queue-second-marker`，分别实际批准，内容分别为 `first`／`second`；第二个队列 marker 在其独立审批前 absent。
- 三个原生结果均 direct／macos-seatbelt、exitCode=0、terminationConfirmed=true，策略 workspace、能力 partial、root 与实际自有项目一致、resourceGrants=0；三个效果均匹配，Direct 债务为 0。20 秒命令实际 durationMs=20106；其余为 96 和 128。模型最终回复不能替代这些控制器结果。
- 下一轮输入的真实 Inbox Enqueued seq 早于前一回合 TurnEnd，UI 实际出现“下一轮 · 已排队”，之后进入独立审批。队列提交时前台 Shell 已到终态，模型回合仍进行中；不把此观察描述为队列提交时 Shell 必然仍在运行。
- 采集时 4 个回合／7 次 request/start，其中前三回合执行上述三条命令，第四回合请求子 Agent 时没有调用工具。三个独立 requested／approved 事件对应三次批准，没有复用前次的批准。真实请求的 toolSchemas 仅五个已开放工具；`spawn_one_shot_agent`／fleet 没有加入模型工具范围。模型说明不可调用子 Agent 与持久请求工具列表相符，不能只依赖模型文字判断权限。
- screenshot 包含 waiting-approval、tool-result、queued-next-turn、queued-separate-approval。后续检测到用户在此独立验收窗口输入“你能做什么”，窗口和独立数据目录继续保留，未强制退出。上面的事实和统计只覆盖采集时刻，后续用户操作不混入验收统计；不能据此宣称所有 App 已退出。

### 真实远端目录浏览

debug Wry 接入现有 profile hydration、SFTP pool、目录请求注册／取消和只读凭据适配，没有构造目录响应。`.phase4-acceptance/stage2-remote-browse-2026-10-09/` 的 sftp-candidates／sftp-bound-root PNG 记录普通账户 SSH 上真实 project 候选、ArrowDown／Enter 完成路径、再次 Enter 绑定根目录。实际 settings-review：0 session、0 model request、sourcePtyWrites=0、exitCode=0。原手动输入路径的证据与本次 SFTP 自动完成分开记录。

### 公共 IPC 子模型与 fleet

入口为 `verify_stage2_public_ipc.py`。使用新的独立数据目录、不抢焦点的 Wry 窗口、实际生产公开 IPC 和真实 MiniMax-M3，没有扩大 `restricted_model_tool` 的五工具名单，没有增加沙箱豁免。两个父配置分别核对：显式五工具范围的父会话拒绝 Explorer 的空角色交集；正常终端父配置与主 controller 一样不额外传入 capabilityScope，继续由生产沙箱过滤实际模型工具。后者的子会话核对策略、审批模式、Direct 执行方式、精确目标与 cwd 继承，实际子请求工具列表仍是父模型工具范围的子集；没有将逻辑角色 allowlist 当作已开放的工具。

最终 `.phase4-acceptance/stage2-public-ipc-r3-2026-10-09/report.json`：passed=true，11 checks true，sourceUnchanged=true、binaryUnchanged=true、userKnownHostsUnchanged=true。实际创建 7 个 session，10 次 request/start，sourcePtyWrites=0，exitCode=0。除两个父会话外，包含独立 Explorer 子会话和 fleet 的 Explorer／Operator／Verifier／Reviewer；各任务有真实模型请求，工具调用总数为 0。fleet 实际 completed，越界 target 拒绝、one-shot 续跑拒绝、策略／审批／目标继承及有效模型工具没有扩大均通过。此分项不证明子会话 Shell 的审批、执行、取消、资源清理或 fleet 业务副作用；这些继续待验收。

首轮 `stage2-public-ipc-2026-10-09` 在显式五工具父范围上被拒绝，原报告保留 false；该角色交集拒绝在最终入口单独作为真实拒绝条件核对。`stage2-public-ipc-r2-2026-10-09` 的隐藏 Webview 运行在 250.019 秒超时，退出码 null、清理状态 unconfirmed，无成功报告。原目录和日志保留，不通过新修订成功覆盖或按历史 PID／名称清理。最终入口改为可见但不抢焦点的独立窗口，不声称已经证明超时原因或历史资源全部清理。

### 当前质量与剩余边界

全量 Rust 为 1163 passed、0 failed、66 ignored，另 5 个集成测试 passed；全量前端 2458 passed、2 skipped。日志分别为 `stage2-continued-rust-full-2026-10-09.log` 与 `stage2-continued-frontend-full-2026-10-09.log`。最后的 IPC 配置补验重新完成原生／前端构建，既有警告保留。ignored／skipped 不计通过。最终预检 hook、真实 OS 钥匙串回归及格式／includes 复验以新的最终报告为准，不重用旧源码哈希作为当前证明。

工作期间发现用户另行修改消息阅读／折叠、chat primitives 和样式等文件，全部保留，没有恢复或格式化这些无关修改。本轮额外生产前端变更只有固定凭据错误的双语格式化；额外后端变更只影响 debug 只读模型验收路径和验收入口。生产恢复、Direct 债务、审批和权限门禁继续保留；没有 commit、tag 或推送。

阶段 2 仍待真实远端模型启动／命令链、子会话／fleet 原生工具与活动资源边界、工作台实际撤销／过期／恢复以及审批审计失败时的完整 UI 去重与焦点验收。历史超时的资源未确认也继续保留，阶段 3 不放行。

最终继续修订的预检回归为 `.phase4-acceptance/stage2-verification-continued-final-2026-10-09/report.json`：四项真实 SSH/Wry 检查通过，18 个相关源码运行前后匹配，二进制未变化，用户 known_hosts 未变化。真实 OS 钥匙串最终两项回归通过；日志 `stage2-keychain-native-final-2026-10-09.log`。全仓格式、includes 和 diff check 最后复验通过；日志 `stage2-continued-{fmt-final,includes-final}-2026-10-09.log`。这些成功不解除 r2 超时的未确认状态，也不代表用户继续使用的窗口已退出。

## 2026-10-09 远端真实模型与能力快照修复

重新读取阶段 1 本轮完成决定，延期的不同 macOS 账户不冒充通过；生产 uncertain 门禁保持。公共 IPC r2 历史超时的只读复核保存在 `.phase4-acceptance/stage2-timeout-readonly-2026-10-09/report.json`：实际 journal 有 1 次模型请求、0 工具调用／执行／结果，Direct 债务 0，原项目仍存在，精确 cwd 查询为空。原 PTY handle 和可信 App 退出回执缺失，terminationConfirmed=false；没有信号、钥匙串读取、目录删除或按名称补认领。

远端模型验收只读适配现在同时允许本次生成的精确 SSH key 引用及 fixture profile 的可选口令读取；其他 SSH／profile 引用、写入与删除均拒绝。真实 OS 钥匙串 3 项通过，日志 `stage2-scoped-ssh-keychain-r3-2026-10-09.log`。生产 CredentialManager 未改变。旧 r2 的预检失败、0 模型请求、0 session、sourcePtyWrites=0、正常退出分别保留。

真实主 controller 发现创建会话时的未验证能力快照在远端 start 完成后仍被用于摘要及审批。`agent-session-adapter.ts` 现在在受限远端 start 后重新读取权威快照，再提交输入；恢复队列 start 同样刷新。没有从预检缓存、历史工具结果或模型文字推断授权，没有布局／样式修改。

`.phase4-acceptance/stage2-remote-main-model-r3-2026-10-09/live-model-facts.json` 保存实际 MiniMax、审批和 SSH 原生执行：首次不一致审批被拒绝，新显式请求后摘要和审批显示 partial，批准前 marker absent；控制器 completed／direct／remote-macos-seatbelt／workspace／partial、exitCode=0、terminationConfirmed=true、durationMs=2352、resourceGrants=0，实际 marker 为 remote-stage2，Direct 债务 0。marker 是同主机精确 OS 文件观察，不声称由 SFTP 核对。热更新窗口内新的会话仍出现旧提示并拒绝，fresh marker absent；保留该失败，首次启动须由全新窗口复验，不将 follow-up 成功扩大为首次启动通过。

本修订全量 Rust 1164 passed、0 failed、66 ignored，另 5 项集成 passed；全量前端 2458 passed、2 skipped。就近 adapter／sandbox 现有回归 39 passed，前端和原生构建通过。对应日志 `stage2-remote-{rust-full,frontend-full}-2026-10-09.log`、`stage2-remote-snapshot-tests-r2-2026-10-09.log`、`stage2-remote-snapshot-build-2026-10-09.log`、`stage2-remote-model-build-r2-2026-10-09.log`；跳过项不计通过，既有警告保留。阶段 2 继续 pending，子会话原生工具、完整撤销／过期／恢复和审计失败 UI 仍待验收，阶段 3 不放行。

### 全新窗口与活动资源撤销

`.phase4-acceptance/stage2-remote-main-model-r4-2026-10-09/live-model-facts.json` 的 7 项检查 true：全新窗口首次启动摘要显示 partial，后续实际审批显示项目路径及默认网络限制；自然过期产生 timedOut／Native approval expired，UI 显示“批准请求已过期”，当时 marker absent。新的显式请求生成独立审批，实际批准后 remote-macos-seatbelt／workspace／partial、exitCode=0、terminationConfirmed=true、durationMs=2292，marker 匹配、债务 0。原生最终结果不由模型回复推断。退出报告为 1 session、6 次模型请求、sourcePtyWrites=0、exitCode=0，包含后续后台撤销尝试。

该 r4 的实际后台撤销暴露空资源审计问题：后台 started 效果存在、结束效果 absent，UI 活动数从 1 降至 0，但后续审计拒绝空 resources，显示 `resource audit resources must contain 1-1024 items`。修复仅让 revoked／revocationFailed 接受空资源集合，保留清理结果；approved／reused 仍要求非空。协议同步，真实日志持久化／重启读取回归加入 `tests/sandbox_audit.rs`，4 项通过。原编译失败和缺少 target 的初次回归失败日志保留，最终日志为 `stage2-empty-revocation-tests-r3-2026-10-09.log`。

最终 `.phase4-acceptance/stage2-remote-revoke-r5-2026-10-09/live-model-facts.json` 的撤销 7 项全部 true：实际模型获批启动 remote-macos-seatbelt 后台命令，start marker 为 started，工作台活动进程 1；用户入口撤销后活动数 0、无操作失败、end marker absent、审计 revoked／cleanupConfirmed=true／resources=[]、债务 0。正常退出为 1 session、2 次真实请求、PTY 零写入；10 个源文件和二进制运行前后匹配。该证据证明没有资源扩展授权的活动 SSH 命令停止，不代替 once/session 资源复用或离线未确认撤销。

审计修复后的全量 Rust 1165 passed、0 failed、66 ignored，另 5 项集成 passed，日志 `stage2-empty-revocation-rust-full-2026-10-09.log`。前端未再变更，全量 2458／2 skipped 沿用上面的修订；fmt、includes、diff check 通过。当前阶段仍 pending，不提交、不推送、不开放阶段 3。

### 子会话、资源复用及审计失败继续验收

公共 IPC Operator 原生工具补验为 `.phase4-acceptance/stage2-child-native-r2-2026-10-09/report.json`：5 项检查及实际 child-stage2 marker true，源码／二进制／用户 known_hosts 未变化，3 次模型请求、3 个 session、PTY 零写入、exitCode=0。实际子会话继承 workspace／requestApproval／Direct 和精确 cwd，模型工具范围未扩大；精确命令的独立审批后 macos-seatbelt／partial、exitCode=0、terminationConfirmed=true，实际文件匹配。原首次报告 false 保留：普通命令的 pending arguments IPC 返回 null，因为该 IPC 只返回临时敏感参数；新入口同生产 UI 一样读取已提交的普通命令参数，仍精确比较后批准，不放宽命令。该证明不覆盖 fleet 原生命令。

首轮真实本地工作台 `.phase4-acceptance/stage2-local-resource-ui-2026-10-09/resource-facts.json` 覆盖精确普通文件 once／session 批准、真实 stdout 和自然过期拒绝，13 次真实模型请求，1 session、PTY 零写入、正常退出。会话资源与操作批准必须独立：已存在 session 授权时，再次独立操作批准原先仍被审计为 approved／once。修复在 Native prepare 中区分资源初次批准需求，操作批准复用已覆盖资源，不更新原 session 期限；签发时重新核对原授权，准备后被撤销也不能以批准操作复活。真实普通文件／原生控制器回归 1 passed，原编译失败日志保留，最终日志 `stage2-independent-resource-approval-tests-r2-2026-10-09.log`；原生全量 1165 passed、66 ignored，另 5 集成 passed。

`.phase4-acceptance/stage2-local-resource-ui-r2-2026-10-09/resource-facts.json` 记录修复后的 actual approved／session 与 reused／session，两个结果 macos-seatbelt、退出 0、terminationConfirmed=true，stdout 匹配本次自有文件，原 sessionExpiresAtUnixMs 未延长。工作台撤销后无有效授权／后台 0；再次读取生成新审批。仅将本次自有 journal 从 600 设为不可写，批准时出现真实 Permission denied，该请求未执行，随后恢复 600。无有效资源且后台 0；旧审批重试／取消被后端拒绝，恢复日志权限后通过现有撤销入口结束回合，没有重放命令。

该真实失败还发现两个前端问题：可见错误与 sr-only 播报重复；已提交取消回合的历史 requested 审批仍显示为操作卡。现在错误由既有 Alert 播报，sr-only 只表达进行中状态；审批投影按已提交 turn/end 撤下操作卡，保留历史事件，不能从 snapshot／历史审计推断恢复授权。`recorded-sandbox-approval.test.tsx` 直接读取上述真实 journal／AX 记录，不使用 mock 或替代事件；修复前两项失败，修复后两项通过，连同就近回归 43 passed。初次前端构建的 ES 目标兼容错误保留，改为兼容循环后构建及两项回归通过。实际 Wry 重读最终记录和其他剩余边界继续待补齐，不把这些分项当作整阶段完成。

### 最终实时错误、历史重读及 fleet 原生命令

`.phase4-acceptance/stage2-audit-ui-final-2026-10-09/resource-facts.json` 的 8 项实际检查 true：新自有 journal 的真实 Permission denied 只在 AX 中出现一次，tool/execution 为 0，没有 completed 原生结果；权限恢复为原 600 后，经工作台撤销入口结束回合，无有效授权、后台 0、旧审批操作卡消失、Direct 债务 0。launch-final 的 15 个源码／二进制哈希运行前后匹配，1 session、7 次实际模型请求、PTY 零写入、exitCode=0。前一回合有实际 REQUEST_HEADERS_TIMEOUT／网络恢复重试及审批自然过期，全部保留，不算成功执行。点击关闭时 CUA 超时，但 launcher 的真实正常退出回执已核对；不从点击成功或 UI 工具超时推断进程终态。

`.phase4-acceptance/stage2-approval-replay-ui-r2-2026-10-09/replay-ui-facts.json` 记录 actual Wry 的历史显示：逐字复制本次自有已提交 journal，成功 stdout 和取消回合可见，旧审批操作卡 absent，新增模型请求 0、原 journal 未变化、正常退出。没有复制数据库、凭据、live grant 或资源归属，证明范围仅为历史重读和操作卡投影，不冒充同状态目录的完整资源恢复。首次在空目录门禁前复制日志被拒绝，原 exitCode=1 记录保留；当前复制只在新空目录门禁核对之后的显式 debug 路径进行。

`.phase4-acceptance/stage2-fleet-native-r3-2026-10-09/report.json` 的 7 项检查和实际 fleet-stage2 marker true：公共 IPC 真实启动 fleet，4 个角色继承 workspace／requestApproval／Direct、精确 target／cwd，实际模型工具不扩大；只有 Operator 调用一条精确获批的 foreground 命令，其余角色无工具调用。控制器 macos-seatbelt／partial、退出 0、terminationConfirmed=true；fleet completed，6 session／6 次实际模型请求、PTY 零写入、Direct 债务 0、exitCode=0。源码、二进制及用户 known_hosts 未变化。该结果不覆盖 fleet 活动后台进程取消。

前两轮 fleet 失败保留：start_fleet 会等待整个 fleet 完成，验收脚本先等待它返回再读取审批，导致 Operator 审批已过期，公共批准返回 Agent Session is not started。两轮没有 marker、正常失败退出、债务 0。最终入口发起 start 后同时读取真实子会话事件，在原审批 TTL 内核对并批准精确命令，之后等待最终 start 回执；没有改变生产审批／超时、开放新模型工具或填入虚假结果。

SSH fixture 的 profileId 和 keyId 现在都由本轮 UUID 生成，只读凭据适配只允许这两个精确新引用以及已选模型引用；真实 OS 测试核对 key／passphrase 正向读取、其他 profile／kind 拒绝、写入／删除拒绝及自身条目清理，3 passed。当前 `.phase4-acceptance/stage2-final-ssh-verification-r2-2026-10-09/report.json` 的四项实际 StrictMode／SSH 预检检查 true，18 个相关源码／二进制前后匹配，用户 known_hosts 未变化。前一轮 120 秒超时没有完成报告，保留 unconfirmed，不按 PID／名称清理。最终用独立 App bundle 显式显示真实窗口，保留 requestAnimationFrame 等待和原预检步骤；成功不解释原超时原因或解除原资源未确认。

最终质量：实际记录 fixture 环境下全量前端 2460 passed、2 skipped；全量 Rust 1165 passed、0 failed、66 ignored，另 5 集成 passed。前端／原生构建、fmt、includes、diff check 通过；ignored／skipped 不计通过。日志为 `stage2-final-{frontend-full,rust-full}-2026-10-09.log` 及各最终构建／检查日志。后续仅增加 debug 验收诊断／调度和凭据 fixture 引用，原生及前端重建通过，对应真实 Wry／fleet 报告绑定其修订；旧报告不冒充所有新源码的证据。

工作期间 HEAD 被其他操作更新，已保留新修订及终端弹框等无关修改；本任务工具没有执行 commit、tag 或推送。

### 前次验收的未完成范围（最新结果见下节）

- 实际工作台的完整 unknown／资源恢复门禁链，不能用上面的历史重读替代同状态目录及可信资源归属恢复。
- fleet／子会话活动后台资源的取消、重绑及过期审批组合；当前原生命令证明均为 foreground，远端活动撤销为独立主会话。
- 真实工作台内目标、连接代际及账户变化的完整组合；不同真实 macOS SSH 账户继续按阶段 1 决定延期，不记作已通过。
- session 资源授权的整段实际一小时到期边界；已有真实审批 TTL 过期及签发／撤销回归，不冒充该长时段实测。
- 原公共 IPC r2 及本轮预检超时的历史资源未确认仍保留，不凭新分项成功、空 registry 或 debt=0 清除。

阶段 2 整体保持待完成，阶段 3 门禁不放行。原先用户继续使用的窗口不关闭，保留的普通读取 fixture 文件只用于本轮输入与记录，不恢复授权。

最终同修订子会话复验为 `.phase4-acceptance/stage2-child-native-final-2026-10-09/report.json`：5 项检查／实际 marker true，3 次实际请求、3 session、PTY 零写入、退出 0、Direct 债务 0；源码、二进制及用户 known_hosts 未变化。没有额外工具调用、elevated 或 boundTerminal 变通。交付汇总 `.phase4-acceptance/stage2-delivery-summary-2026-10-09.json` 记录各确切报告 SHA-256 和当前修订，核对实时 UI 验收对应的六个生产源码哈希仍与当前文件一致，actualUiProductionHashesMatchNow=true；后续 debug 验收入口的修订与生产行为证据分开记录。最后前端构建、全仓 fmt、includes、AI styles、diff check 通过，既有构建警告保留。本汇总仍为 pending，不清除上述缺口或历史未确认状态。

## 2026-10-09 完整工作台恢复与活动资源补验

当前补充证据覆盖前文仍待完成矩阵中的本地完整 unknown／资源恢复，以及子 Agent／fleet 活动后台取消与新会话绑定组合。其他目标、连接代际、账户及历史未确认资源的边界继续保留，阶段 3 不放行。

### 同状态目录的完整 unknown／资源恢复

`.phase4-acceptance/stage2-recovery-workbench-final-2026-10-09/recovery-evidence-final.json` 的 11 项实测检查通过。自有 MiniMax-M3 工作台实际请求并显式批准 `printf started > recovery-started; sleep 120; printf ended > recovery-ended`；确认派发 journal 和 `started` 效果后，仅终止本次父进程仍持有的 App Child。退出码 -9，随后在同一 fixture／owned-project／Direct 状态数据库重启；seed 与 reopen 使用相同原生二进制哈希。没有复制历史日志、数据库、凭据或资源来代替重启。

实际 controller 显示恢复 Alert，旧审批操作和发送／停止被锁住；公共审批 IPC 返回没有 resident driver，旧会话授权为 none，活动进程为 0。这个拒绝原因直接记录为 `rejectedWithoutResidentDriver=true`；没有将审批 TTL 已过期的观察描述为“到期前拒绝”。原 `recovery-started` 仍为单次内容，`recovery-ended` 未出现，旧命令没有重放。

先仅暂存本次所属控制器的精确签名回执，实际核对返回 uncertain=1，恢复操作继续禁用。还原同一回执后通过受保护托管和 HMAC 终态核验，resolved=1、uncertain=0；Direct 债务和托管行均为 0。用户操作在最终动作前重新核对回执，然后结束中断回合并新建会话；`printf fresh > recovery-fresh` 在新的独立审批前 absent，显式批准后内容为 fresh，原生结果 direct／macos-seatbelt、exitCode=0、terminationConfirmed=true。清理不被用来声明旧命令完整执行，也不迁移旧授权。

本轮修复包括：公共 snapshot 的瞬态 `recoveryRequired` 区分冷恢复和真实活动 driver；工作台只在该状态显示恢复区域，并将旧活动过程显示为未完成；清理后重新探测能力，避免沿用 unavailable 摘要。恢复 UI 沿用共享 Alert／Button，双语实看，实际窗口为 620×680。动态缩窄调用未获 debug App 的窗口权限，未计为窄窗口通过；没有扩大生产权限。截图、AX、原始日志、实际 journal 和白名单资源报告均保留。首次自有 fixture 的完整通过证据也保留在 `stage2-recovery-workbench-2026-10-09/recovery-evidence-r1.json`。

### 子 Agent／fleet 活动后台取消与新会话绑定

`.phase4-acceptance/stage2-activity-workbench-2026-10-09/activity-evidence.json` 的 15 项公共 IPC 实测检查通过，报告独立核对真实模型 journal、后台 running 结果、cancelled 终态和精确 marker。Operator 子会话和 fleet Operator 分别实际批准一条自有 `printf started; sleep 90; printf ended` 后台命令；活动期间旧目录改写及策略变更被拒绝。取消子会话／abort fleet 后活动进程为 0，Direct 债务与托管行均为 0，精确 started 文件匹配、ended 文件 absent。

已有项目目录不可改写。组合中的“重绑”通过显式创建新会话并选择新目录完成；新会话没有迁移旧资源授权，旧父／子目录保持原值。fleet 在 Operator 资源活动期间被 abort，实际观察 Explorer 和 Operator；没有把此证明扩展为四角色完成或业务完成。

验收发现同 ID 目标的全局查询会取到其他历史会话的目录／label。派生现在优先使用当前父会话冻结的目标与 target scope，原权限收窄检查继续保留。另修复 cancelCascade 的 detached 子会话仍显示 running 的投影，实际取消日志驱动的回归确认显示 cancelled。验收代码未替换模型、IPC、资源控制器或时钟。

### 当前质量与长时段边界

全量前端 2472 passed、4 skipped，日志 `stage2-recovery-frontend-final-2026-10-09.log`；全量 Rust 1165 passed、0 failed、68 ignored，另 5 集成 passed，日志 `stage2-recovery-rust-full-final-2026-10-09.log`。新增真实记录回归需分别指定 recovery 与 activity fixture；缺少实际记录时保持 skip／ignore，不构造替代事件。当前前端／原生构建和格式检查通过，已有构建警告保留。源码、证据与后续用户自行提交的 HEAD 分别记录，本任务工具没有创建 commit、tag 或推送。

普通文件 `/private/tmp/shellspan-stage2-hour-eDcGLJ/read-input.txt` 的真实 session 授权在 20:15:00 签发，原截止时间为 21:15:00（Asia/Shanghai）。原 App 保持运行，中间只读核对仍 active，截止时间未续期。截止时间已经过去，但 Mac 再次锁屏，尚不能读取原 App 的实际到期 snapshot 或完成新资源审批，不能把时间经过记为通过。`.phase4-acceptance/stage2-recovery-workbench-2026-10-09/hour-acceptance-pending.json` 核对实际 session 审计寿命为 3599998 ms，post-deadline snapshot 仍为 null，passed=false。不能用 60 秒操作审批到期或单次调用 grant 的 TTL 替代。历史公共 IPC／预检超时资源继续 unconfirmed，不按 PID、名称、空 registry 或新报告补清理。

最后将 `recoveryRequired` 限定为原生执行／已授权未派发／待审批检查点；纯模型请求保留原有继续方式。真实模型 journal 的冷前缀分别核对纯模型不进入资源门禁、unknown 原生执行进入门禁、取消终态不复活，两个记录回归通过。最新全量 Rust 仍为 1165 passed、68 ignored，另 5 集成 passed，日志 `stage2-native-gate-rust-full-2026-10-09.log`；记录回归日志为 `stage2-recorded-native-gate-final-2026-10-09.log`。该范围收窄后的额外真实模型复验保留在 `stage2-recovery-gate-final-2026-10-09/pending-result.json`：系统钥匙串读取等待，1 session、0 model request、0 native dispatch；Mac 锁屏阻止 UI 继续及正常退出，terminationConfirmed=false，未计通过。没有绕过系统授权、复制凭据或按 PID 补清理。前述两轮完整工作台通过证据与这个额外待完成尝试分开保留，阶段 3 继续关闭。

## 2026-10-10 当前补验完成结果

本次要求的三个分项已有实际通过证据：完整 unknown／资源恢复、子 Agent／fleet 活动后台取消与新会话绑定，以及完整一小时授权到期。阶段 2 的其他目标／连接／账户组合与历史未确认资源仍按原记录保留；阶段 3 未开启。

### 最新修订的完整工作台恢复

`.phase4-acceptance/stage2-recovery-2026-10-10/recovery-evidence-final.json`：11 checks true、passed=true。当前 scope 收窄后的原生二进制实际完成 MiniMax-M3 派发、显式审批、中断、同状态目录重启、无回执时 uncertain=1 阻止、原签名回执 resolved=1 清理、新会话独立审批及真实 fresh 效果。旧授权 none、无 resident driver 的旧审批拒绝、旧命令没有重放；新结果 exitCode=0、terminationConfirmed=true，Direct 债务和托管行均为 0。seed 与 reopen 二进制哈希相同。

App 正常退出 code=0，2 session、3 次实际模型请求、sourcePtyWrites=0；实际 UI、原始 journal、日志、marker 和终态报告保留。它补齐了昨日 scope 收窄后模型复验的证明，不覆盖昨日失败／锁屏尝试的原资源未确认状态，也没有以新成功清除任何历史资源。

### 完整一小时到期与到期后新审批

原 10-09 App 已退出，不能用原内存授权补认到期。新的独立 fixture 为 `.phase4-acceptance/stage2-hour-2026-10-10/`，首次真实模型读取的普通自有文件由 launcher 新建，不包含用户敏感内容。通过生产公共审批 IPC 显式选择 session 范围，生产一小时 TTL 不变。

同一原 Runtime／PID 94200 在 **2026-10-10 09:25:59.313 → 10:25:59.313（Asia/Shanghai）** 保存授权。后端在原截止时间之后 3 ms 读到 state=expired，readPaths／writePaths／networkTargets／localServices 均为空、activeProcesses=0；观察期间没有重启、调时、缩短 TTL 或授权续期。保存的单调经过时长为 3596288 ms，观察开始时授权已签发 3655 ms，合计约一小时；审计落盘在签发后 1 ms，记录寿命为 3599999 ms。

后端观察是 debug-only、只读的原 Runtime 任务，页面重载或锁屏不丢弃它；它不授予或恢复执行权限。`hour-initial.json`、`hour-expired.json` 分别保存真实 active／expired 元数据。新的同文件读取在截止时间之后产生不同的 requested／approved approval ID，资源审计 action=approved、scope=once；实际第二次 cat 退出 0、terminationConfirmed=true，stdout 与自有输入完全一致。没有复用已经到期的 session grant，`hour-acceptance.json` 的 freshOnceResourceApproval／freshNativeTerminal／passed 均为 true。

`hour-evidence.json` 独立交叉核对原进程、生产 TTL、真实经过时长、两次精确调用、两份独立审批、session→once 审计及原生终态：11 checks true、passed=true、Direct 债务 0。实际工作台保存了授权有效／原截止时间、到期后没有可复用授权、第二次实际读取与批准的 PNG／AX。正常退出 code=0，1 session、4 次实际模型请求、sourcePtyWrites=0。临时系统睡眠抑制已结束，没有改变锁屏或钥匙串规则。

### 当前质量和保留边界

本轮全量前端 2472 passed、6 skipped；其中新增的两个一小时记录测试在尚未有完整证据时 skipped，实际证据生成后单独运行 **2 passed**。全量 Rust 1165 passed、68 ignored，另 5 集成 passed；恢复／委派的真实记录 Rust 回归另行 2 passed。对应日志 `stage2-hour-{frontend-full,rust-full,recorded-tests,recorded-regressions}-2026-10-10.log`。原生／前端构建、全仓 fmt、includes 和 diff check 通过，原有构建警告保留。

所有 skip／ignore 不计通过。历史公共 IPC／SSH 预检超时资源仍 unconfirmed，不按 PID、名称、空 registry 或新成功报告清理。验收使用新的自有目录／进程／文件，没有提交、tag、推送或进入阶段 3；用户另行更新的 HEAD 和文件继续保留。

## 2026-10-10 连接绑定刷新修复与实际组合复验

修复前在新的自有 SSH fixture 中确认：真实模型的原审批仍在 TTL 内，同身份断连／重连后重新启动原会话刷新预检，批准前重新 prepare 会把原绑定换成新连接绑定，旧审批仍可执行。原生结果实际 exitCode=0、terminationConfirmed=true；记录保留在 `stage2-binding-before-2026-10-10`，不依赖模拟事件或缩短时钟。

NativeAdapter 现在保留原 prepared token 的连接代际、账户／认证和 profile 执行修订；刷新前校验原绑定，刷新后比较新旧绑定。runtime slot 转发这个核验，pipeline 保留原有契约和 omitted-input 校验。绑定变化使原审批持久化为 cancelled，结束原会话，不记录原命令派发；新会话必须重新显式申请审批。刷新期间再次改变绑定也会拒绝，执行前最后一次绑定核验继续保留。

`stage2-binding-fixed-2026-10-10/binding-evidence.json` 的 15 项检查通过：原审批在到期前取消、没有 approved／dispatched、旧效果文件 absent；新会话经实际 UI 独立审批，远端 Seatbelt 命令退出 0 并确认终止，新效果精确匹配。实际 UI、journal、来源代际和资源终态均保存；两个会话授权 none、活动进程 0，Direct debt／custody 0。

`stage2-binding-terminal-2026-10-10/binding-activity-evidence.json` 的 19 项检查通过：自有后台命令的 started 先由实际 SFTP 确认，再断连；活动期间目录改写与策略切换被拒绝。重连使原始连接绑定失效，原准确 process handle 终态为 failed、terminationConfirmed=true，公共撤销审计 cleanupConfirmed=true，ended 效果 absent。原目录与策略保持原值；新建独立目录和会话后由实际 UI 重新审批，真实 fresh 效果仅出现在新目录。原会话工作台显示已停止，两个会话均无残留授权／活动进程，debt／custody 0。未扩展为不同真实账户通过。

退出与资源证明分别记录。前几轮 Cmd-Q 后只有 App 退出码，没有原生汇总／fixture 退出回执，辅助 SSH fixture 的完整退出仍未确认；这些状态不凭新成功补认清理。新增 debug 收尾只使用原 Runtime 和仍驻留的自有 Child／线程／凭据引用：先确认 native shutdown，再 join 源线程、wait 原始 SSH server Child，释放精确自有凭据，并显式释放 managed fixture，避免 AppHandle／Runtime 引用继续持有资源。Child 已被 wait／try_wait 回收后不会再按旧 PID 发信号。

最新 `stage2-binding-close-2026-10-10/fixture/fixture-shutdown.json` 实际确认 runtimeShutdownConfirmed、sourceWorkerJoined、serverWaitConfirmed、ownedCredentialReleased 均为 true；server exitCode=0、PTY 写入 0。该轮实际后台重连与新目录命令保留原生终态／SFTP started／公共撤销日志与 UI；一次新审批自然过期的记录也保留，后续新的精确公共 IPC 审批完成真实执行。正常关闭主窗口后 `settings-review.json`／`launch-final.json` 均存在、exitCode=0，3 session、6 次实际模型请求，sourceUnchanged／binaryUnchanged=true。这个回执不覆盖旧窗口的辅助资源。

当前生产 `native_adapter.rs`／`tool_pipeline.rs` 哈希与 15／19 项通过记录一致；debug 收尾扩展单独记录，不外推为历史资源清理。全量前端 2468 passed、12 skipped，日志 `stage2-binding-frontend-2026-10-10.log`；全量 Rust 1165 passed、68 ignored，日志 `stage2-binding-rust-close-2026-10-10.log`。实际记录回归另行运行，skip／ignore 不计通过。阶段 2 其他目标／账户组合、窄恢复界面及历史未确认边界仍按原范围保留，阶段 3 未放行；没有 commit、tag 或推送。

最终三个真实记录回归 3 passed，日志 `stage2-binding-recorded-final-2026-10-10.log`；前端构建、全仓 fmt、51 个 includes、AI styles 和 diff check 通过。最后一轮全量前端发生在新增退出记录回归之前；新回归以实际收尾证据单独通过，不修改原全量计数。

## 2026-10-10 双目标预检与窄恢复界面补验

新的 `stage2-target-switch-2026-10-10` fixture 在同一普通账户／同一自有 sshd 上创建两个独立的真实 SSH PTY 和独立目录，共享本次自有 profile／凭据。不声称跨主机、不同账户或不同认证方式组合通过。独立工具栏沿用 ToggleGroup 切换真实 TerminalStore 源，不模拟 connected 状态，不改生产工作台布局。

实际主工作台经生产目录选择器绑定自有目录、选择工作区策略，观察 A 的预检按钮 disabled／加载中后切换 B；B 及切回 A 的状态保留为 AX／截图。切换查看目标不等于重绑仍有效的原会话，不要求仅因导航就取消其他目标的活动任务。B 不得沿用 A 的审批／授权，切回时已失效审批不得复活。

生产 `useRemoteSandboxVerification` 在实际 Wry／原生 IPC 上完成 11 项检查：完成结果不出现在另一目标、切回不复活；首次 B 的真实 SSH／SFTP 预检确实 busy 时切换，切回后旧在途响应被丢弃；B 的结果绑定准确源／目录；策略改变及切回不恢复旧结果，新的 A 验证成功。`target-verification-evidence.json` 的 verificationPassed=true、overallPassed=false。这个 hook／IPC 证明与主工作台观察分开记录，没有 mock、响应替换、延时屏障或修改生产计时器。

真实模型待审批组合仍 pending：会话已创建，原 Runtime 查询 idle、modelSelected=false，实际 model request=0。仅采样本轮自有 App 的进程，栈确认 `agent_runtime_start → RouteStore::credential → SecItemCopyMatching → SecurityServer::decrypt` 等待系统钥匙串；随后 UI 工具明确提示 Mac 已锁屏、无法自动解锁。没有绕过钥匙串或把未发生的模型派发记为通过。原 App／两个源的拥有句柄保留用于解锁后继续与可信收尾，不按 PID／名称补清理，不宣布终态。

`stage2-narrow-recovery-2026-10-10/narrow-evidence.json` 的 10 项检查通过。由此前真实 MiniMax／显式批准／已派发日志导出逐字相同的原始前缀，仅重读历史；不复制 database、凭据、live grants 或 resource custody，不重放模型命令。实际 Wry 为 360 CSS px（Retina 截图 720 px），中英文 documentWidth=360，两个按钮边界均在容器内；结束中断和旧停止操作 disabled，旧批准卡不出现。键盘可从语言切换经设置／历史／新会话到 Verify cleanup receipts；两个截图已实看。这个渲染证明不能补认历史资源清理。

本次新建本地 PTY 使用原始 Child wait 回执，sourceWorkerJoined／sourceWaitConfirmed=true、PTY 写入 0；Runtime shutdown 与主窗口正常退出均确认，native／launcher exitCode=0、binaryUnchanged／originalJournalUnchanged=true。汇总里的一个 request/start 来自导入历史；前缀之后实际新增 model request=0／native dispatch=0。两项真实记录回归 2 passed，日志 `stage2-narrow-recorded-2026-10-10.log`。

当前 Rust 1165 passed、68 ignored，前端构建、全仓 fmt、51 includes、AI styles 与 diff check 通过，日志 `stage2-target-ui-{rust,build}-2026-10-10.log`。真实模型待审批跨目标及双 SSH 源可信收尾需 Mac 解锁后继续；历史资源仍 unconfirmed，阶段 3 关闭，未提交或推送。

解锁后在原 App、原状态目录和原会话继续，钥匙串返回后模型选择完成；页面重载导致旧 JS callback 丢失，核对原 journal 没有 request/start 后，通过公共 followup 向同一会话提交精确自有命令。真实 MiniMax 请求产生一次 `printf target-a > switch-target-a` 待审批，实际 A 工作台显示“允许执行一次”。切换 B 后显示 B 新建会话，不出现 A 的审批按钮。原 60000 ms 审批自然到期；随后从 B 打开 A 历史会话，显示续接新会话提示和已过期记录；返回 A 仍显示“批准请求已过期”，无执行按钮。历史视图是在到期后观察，不能外推为到期前历史面板验收。原命令没有 approved 或 dispatched，模型没有重试。

`stage2-target-switch-2026-10-10/target-switch-final-evidence.json` 的 15 项记录检查通过，旧 pending 报告保留不改写。原 Runtime shutdown 后，两个原 SSH 源线程 join、原 sshd Child wait（exitCode=0）、精确自有凭据释放均有回执；PTY 写入 0。主窗口正常退出，launch exitCode=0、sourceUnchanged／binaryUnchanged=true。该轮两个实际模型请求分别为初始工具请求和到期结果总结。不同真实账户仍 deferred，历史未确认资源保持 untouched，阶段 3 继续关闭。

## 2026-10-10 审批未到期时从 B 打开 A 历史会话

新的独立 Wry／同账户双 SSH 源验收目录为 `stage2-history-live-2026-10-10`。真实 MiniMax 生成一次精确自有命令 `printf target-a > switch-target-a`，原审批到期时间为 1791611253574，仍沿用生产 60000 ms TTL。B 打开 A 历史会话的实际 AX／截图时间为 1791611232832（距到期 20742 ms）；展开历史步骤为 1791611237255（距到期 16319 ms）。B 显示历史等待批准步骤与“旧命令不会自动重试”的续接提示，没有“允许执行一次”按钮。截图已实看，不替换模型、IPC 或生产时钟。

切回 A 的实际 AX 时间为 1791611249835（距到期 3739 ms），原审批仍有“允许执行一次”按钮。随后通过 A 实际界面取消，journal 记录 rejected；全日志只有一次 requested，没有 approved 或 tool/execution。生产公共 IPC 查询授权 state=none、activeProcesses=0。实际模型请求为 2 次（工具申请和拒绝结果总结），源 PTY 写入 0。此结果只覆盖同账户跨目标历史导航，不能证明不同账户隔离或活动资源转移场景。

新增 `recorded-history-isolation.test.ts` 对真实时间戳、B 历史／展开内容、A 原审批入口及无批准／派发进行回归，显式指定本轮 fixture 后 2 passed，diff check 通过。未修改生产 UI／后端行为，未提交、tag 或推送。

主窗口正常关闭，launcher exitCode=0、sourceUnchanged／binaryUnchanged=true，`settings-review.json` 存在；本轮没有生成 `fixture-shutdown.json`，因此辅助 SSH 源／server／自有凭据的完整收尾仍 unconfirmed。不能凭应用退出、无活动授权或其他轮次回执补认清理，不按 PID／名称处理。不同真实账户的验收等待用户指定第二个现有可登录普通账户配置；新执行重新审批及旧授权／活动资源不转移尚未获得该组合的真实证据。阶段 2 整体继续 pending，阶段 3 不放行。

## 2026-10-10 不同真实 SSH 登录身份分项验收

用户指定现有 `root@175.178.66.45:22` 与 `root@8.216.9.10:22` 配置，作为不同主机上的真实登录身份。此项不再增加“必须 macOS 普通账户”的要求；平台能力仍按实际 backend 记录。用户已连接窗口使用的已安装二进制与当前修订不同，实际 UI 为旧权限入口。本轮构建当前开发修订，用 `launch_account_review.py` 启动独立命名的正常工作台，在现有开发数据库／系统钥匙串引用上连接这两个配置，没有复制密码、修改用户配置或中断其既有终端。

证据目录 `stage2-real-account-review-2026-10-10`，`account-evidence.json` 的 12 项记录检查通过，**overallPassed=false**。真实记录回归 `recorded-account-isolation.test.ts` 指定该目录后 2 passed。只新增验收脚本／测试／记录，不改生产行为，不提交或推送。

- A 的精确 `printf shellspan-account-a-20261010` 请求实际待审批，切到已连接 B 时仍在 A 的 TTL 内，B 显示独立新会话，无 A 的批准入口。B 历史列表明确按 `root@8.216.9.10:22` 过滤，没有本轮 A 会话。A 请求自然过期，没有 approved／tool/execution，切回后未复活。
- B 的 `printf shellspan-account-b-20261010` 产生独立 approvalId，经实际 UI 单次批准后派发。原生 SSH 握手在 15002 ms 超时，failure.admission=notStarted、terminationConfirmed=true、stdout 为空，不能记为远端执行成功。
- A 的第二个独立任务为 `printf shellspan-account-active-a; sleep 40`。实际批准、派发，并收到准确 stdout，证明命令启动。未显式设置超时，触发生产默认 30000 ms；原生结果为 uncertain、timedOut、failure.admission=started、terminationConfirmed=false。此时原会话持有精确 handle `proc-8eaaf45168404e42ac5f75fbe3a4c03b`，不根据这个标识构造额外清理权。
- 公共 IPC 在超时前查询 A activeProcesses=1、B=0；切到 B 后仍为 A=1、B=0。后一次查询发生在 A 已超时且终止未确认之后，因此证明的是未确认资源仍属于 A，不描述为该时刻远端进程必然仍运行。B 工作台没有接管 A 活动任务。
- B 的新重试在发送阶段被“Shell 资源清理尚未确认”门禁拒绝，没有新增 requested／模型执行。原 Runtime 对本轮精确 A 会话的公共取消返回 `Native process cancellation remains unconfirmed`；host 会话的资源撤销入口拒绝 `Restricted Session required for resource revocation`。本轮债务保留，不按 PID／名称清理，不以命令自然结束、空授权或窗口退出解除。

两个会话实际为 host policy／host-account，backend capability unavailable；公共资源授权 state=none。已覆盖跨身份审批及活动资源归属，尚未覆盖有实际 live grants 时的授权转移、B 成功执行以及可信资源终态。原验收 Runtime／窗口继续保留，不关闭拥有本轮资源的实例。历史超时资源保持 untouched；阶段 2 整体 pending，阶段 3 不放行。

### 同日继续：收尾阻塞根因复核

原账户验收进程与窗口仍存在。只读查询当前开发 Direct 账本，本轮精确 task 的 dispatch_debt=1、对应 remote_cleanup_custody=0；没有读取 key、修改账本或对远端发出清理命令。

生产 `native/process.rs::run_remote_worker` 的 host 路径在 deadline 到达时关闭 channel，以 terminationConfirmed=false 结束并返回，原 SSH channel／session 随后释放。`ManagedProcessNative::kill` 对已经终态但未确认的记录，仅能调用 `remote_sandbox` 的所属资源清理；本轮 host-account 没有该 job／清理凭据，因此原 Runtime 存在也不能补认终态。不能通过延长等待、重复取消、重连、自然结束或重新启动应用恢复这份已丢失的清理能力。

授权能力复核：`sandbox_authorization.rs` 明确拒绝 host policy 的 sandbox 资源请求。两个登录身份可以证明审批与资源归属隔离，但当前 host-account 路径不能产生所需的实际 sandbox live grants；不能把 state=none 当作授权复用／隔离验收完成。

继续真实执行会触及现有 Direct 债务门禁，故未发送 B 重试、未通过新数据目录／新实例绕过，未重放 A 命令。后续实现需要在新 host-account 执行启动前建立可验证的远端资源归属、收尾凭据及确认回执；这个未来契约不能追认本轮无 custody 的旧债务。当前实际授权验收还需支持资源 grant 的后端。本轮根因记录不放行阶段 2 或阶段 3。

## 2026-10-10 新 Host Direct 可信收尾实现

生产 NativeToolEngine 对带冻结 Host 契约的远端新命令接入专用内存控制器。派发前核验真实源代际、账户／profile 修订、固定主机密钥、规范化 cwd 和现有 Python；未派发的检查失败不创建虚假债务。新 job 的签名清理 capsule 在 Shell 启动前托管到系统钥匙串，原生状态仅存引用。正常退出、超时、取消和绑定失效沿用已有所属资源回执处理。前台调用增加有界收尾等待，回执查询覆盖 DNS／TCP／SSH 的完整期限，避免用户命令到期后在控制器收尾期间过早返回 running。

新 `remote_host.py` 复用未修改的旧控制器签名／Child／进程组函数，单独实现 Host 流程；保留账户环境，并通过 Python `-I` 隔离控制器导入。规范化 `/tmp` 避免 macOS 用户 TMPDIR 超过 Unix socket 路径限制。工具原有最长一小时期限保持；不安装远端组件，不改生产 UI、命令审批或 sandbox grant 范围。旧 Seatbelt 源码及摘要未改变，旧 capsule 缺省按原控制器处理；UID=0 仅适用于明确 Host capsule。

实际验证均使用新自有资源，没有 mock 或模型／IPC 替身：

- `host_tests -- --ignored --test-threads=1` 显式执行 **3 passed**。自有普通账户 sshd 与真实系统钥匙串覆盖正常退出、超时、显式取消、准确 stdout、控制器目录清理、cleanup capsule 的 OS 读取及签名核验。生产 NativeToolEngine 覆盖批准前拒绝、单次批准、host-account／unavailable 事实及正常／超时收尾后自身 dispatch_debt／remote_cleanup_custody 均为 0。这里没有硬崩溃创建者测试或用户 Linux root 工作台模型执行证明。
- `test_host_controller.py` 实际本机 Child 验证正常／超时终态、最长一小时期限可接受、签名清理、错误密钥不能清理；**1 test passed**。日志 `stage2-host-controller-python-2026-10-10.log`。
- 全量 Rust **1165 passed、71 ignored**，另 5 集成 passed；日志 `stage2-host-rust-full-2026-10-10.log`。新增三项属于显式分项运行通过，默认 ignored 不计全量通过。前端和原生构建通过，日志 `stage2-host-{frontend,native}-build-2026-10-10.log`；全仓 fmt、51 includes 与 diff check 通过。原有两项 container dead-code 与构建提示保留。

只读复核用户原开发账本，本轮旧 A task 仍 dispatch_debt=1、对应 custody=0。旧账户验收实例继续保留，没有修改账本、按 PID／名称清理或将失败轮次资源随新通过结果补认清理，没有 commit／tag／推送。新代码尚未用于用户两台 Linux root 的工作台重新执行；B 成功执行、实际 sandbox live grants 和阶段 2 其他门禁仍待补齐。Host 收尾能力不等于文件／网络隔离，也不覆盖恶意同账户／逃逸后代；阶段 2 整体 pending，阶段 3 不放行。

## 2026-10-10 真实 Linux 原生收尾补验

新增 debug 固定验收入口及 `verify_linux_host.py`，从用户指定现有配置读取原 credential reference，使用新自有 SSH source、原生 prepare／单次批准／执行流程及独立验收账本。这里没有模型、没有恢复用户旧会话授权，也不代替主工作台跨身份验收。所有新检查是明确固定的验收命令；不修改服务器、known_hosts、用户连接配置或旧债务，不复制 secret 到文件或报告。

最终本轮目录 `stage2-linux-host-r5-2026-10-10`：第一台 `root@175.178.66.45:22` 证明实际 `uname=Linux`／`uid=0`，正常退出、8 秒期限触发超时、真实 started 后显式取消、真实源断连均得到 terminationConfirmed=true，自有账本 debt／custody 均 0、源线程 join、源 PTY 写入 0。独立客户端崩溃窗口先核对真实 host-started、debt=1／custody=1，再由父进程 SIGKILL 并 wait 本次原始 Child（exit=-9）；原 capsule 恢复 resolved=1／uncertain=0，清理后两表均 0，没有重放命令。R1／R4 的前述分项证据同时保留，不覆盖失败或扩大范围。

第二台 `root@8.216.9.10:22` 仍没有完整通过：R1／R2 未得到执行结果；R3 真实返回 `Linux\n0\nhost-normal`，admission=started，但终止未确认。R4／R5 在源 SSH 握手阶段出现 `[Session(-9)] Timed out waiting on socket`。各目录的源码／二进制身份及失败结果独立保存；不得凭某次正常 stdout 或之后成功来解除该轮资源状态。

源码复核发现 EOF 处理窗口：首次 completion 查询失败后，后续 cleanup 成功可能移除最终状态，原生却仍报告未确认。现在清理期间保留已验证的最终回执，并从原 job 内存读取终态；反复清理仅使用同一已验证回执。Host job 的检查／控制复用自己的精确已认证 peer；恢复 capsule 一次核验也复用精确 peer，避免每个回执都重新握手，不共享到其他 job／账户。未将这一源码窗口认定为 R3 失败的唯一根因。

新增真实回执保留回归，实际清理目录后断开原源，原 job 仍能取得 exitCode=0／controllerFinished／terminationConfirmed，且 valid=false，未复活执行。四项真实 SSH／系统钥匙串回归 4 passed，日志 `stage2-linux-host-native-regressions-r2-2026-10-10.log`。第一台实际记录回归 2 passed，第二台失败不计通过。

第二台无认证对照：系统 OpenSSH 校验同一 ECDSA 主机密钥并完成握手，随后按 `PreferredAuthentications=none` 被拒绝，未读取凭据或执行命令；`stage2-linux-host-r4-2026-10-10/b-openssh-handshake.log` 保留事实。libssh2 独立对照在 default／curve25519／ecdh 中超时，一次 group14-sha256 在约 8.5 秒后完成握手并匹配 known_hosts；完整结果为 `stage2-linux-host-b-handshake-2026-10-10/host-handshake.json`。这不证明稳定算法根因，没有修改生产算法或绕过主机信任。

R3 原 capsule 的后续恢复曾停在 macOS `SecurityServer::decrypt`，原进程采样保留为 `recovery-sample.txt`。用户在系统完成授权后，该原请求返回 resolved=0／uncertain=1、debt=1／custody=1；新的 UUID 恢复报告保留旧失败文件，未补认清理。它属于本轮新验收资源，不能与更早的无 custody 旧 A 债务合并或相互替代。旧 A 及其他历史资源继续 unconfirmed，不按 PID／名称处理；阶段 2 整体 pending，阶段 3 不放行。

最终全量 Rust 1165 passed、72 ignored，另 5 集成 passed，日志 `stage2-linux-host-rust-final-r3-2026-10-10.log`；第一台 R5 真实记录回归 2 passed。前端构建通过，日志 `stage2-linux-host-build-final-2026-10-10.log`；当前原生构建、fmt、51 includes 和 diff check 通过。只读复核用户原开发旧 A 行仍 debt=1、custody=0，原账户验收进程保留；本轮固定 Linux 检查进程均已返回。没有 commit、tag、推送或服务端配置改动。下一项仍是第二台 libssh2 握手与可信终态的稳定复验，随后才补完整跨身份／实际授权组合；本记录不宣布该目标完成。

### 第二台原 capsule 收尾与握手复验（2026-10-10）

R3 原目录的独立恢复回执 `target-1-lifecycle/host-recovery-81f58e69-69dc-43db-b7f0-a1497fb71575.json` 通过原系统钥匙串 capsule 和签名回执返回 resolved=1／uncertain=0、debt=0／custody=0。原 `host-normal.json` 的 started／terminationConfirmed=false 以及先前恢复失败文件保持原样；这只确认该轮原资源清理，不把原执行或完整第二台验收改记通过。旧开发 A 只读计数仍为 debt=1／custody=0，原账户验收 App 保留，没有接管或解除该债务。

无认证对照目录 `stage2-linux-host-b-handshake-r2/r3/r4-2026-10-10` 分别保存原始结果。默认 curve25519 既有 574 毫秒成功，也有 15.826 秒成功；30 秒期限内仍存在失败，部分失败未取得服务器 banner。ECDH、group14、AES 与 TCP_NODELAY 对照没有证明稳定根因。生产保留原算法、TCP_NODELAY 和主机信任，只将握手期限独立设为 30 秒，握手成功后恢复原有 15 秒会话 I/O 期限；主机密钥读取复用同一握手入口，取消和更短外层期限仍关闭所属 socket 并 join。诊断入口不读取凭据或执行命令，恢复错误仅输出固定脱敏分类。

第二台 R6／R7／R8／R9 失败记录独立保留。最终 `stage2-linux-host-b-r9-2026-10-10/report.json` 确认源码与二进制未变化，但完整验收 passed=false；该轮正常请求返回 admission=notStarted／processControllerFailed、durationMs=5002，没有正常 stdout，独立账本 debt=0／custody=0。握手及控制器启动等待仍需继续处理，不能凭 R3 清理成功或 R8 的正常退出放行第二台。未开始后续跨主机旧审批、授权和活动资源隔离／新执行重新审批；阶段 2 仍 pending，阶段 3 不放行。

验证：真实自有 sshd／钥匙串 Host 回归 **5 passed**（含透明 TCP 转发延迟实际服务器字节 16 秒的握手测试）；连接测试 **17 passed、1 ignored**；取消／外层期限回归 **1 passed**；第一台原记录及第二台原 capsule 收尾记录 **3 passed**。日志分别为 `stage2-linux-host-b-final-host-tests.log`、`stage2-linux-host-b-connection-tests.log`、`stage2-linux-host-b-handshake-cancel-test-r2.log`、`stage2-linux-host-b-recording-tests.log`。最终原生构建、fmt、51 includes 和 diff check 通过。没有 UI 修改、commit、tag、推送或服务器配置改动。
