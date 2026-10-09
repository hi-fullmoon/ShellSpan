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
