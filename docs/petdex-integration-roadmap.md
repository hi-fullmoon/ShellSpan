# TermBridge × Petdex 桌宠集成路线图

<!-- petdex-phase4-decision: blocked -->
<!-- petdex-phase4-implementation: not-authorized -->

> 状态：`EXPLORE — Phase 3 collecting；Phase 4 准入评估 blocked；Phase 0 / Phase 2 跨平台发布门禁仍未关闭`
>
> 更新日期：2026-08-28
>
> 结论：Phase 3 已建立无默认遥测的自愿研究流程、最小聚合台账和可重复门禁，并于 2026-08-28 启动观察；当前真实样本为 0、严格门禁为 `collecting` / exit 1。Phase 4 准入评估已记录为 **blocked、未准入且未授权实现**；详见 [Phase 4 准入评估](./petdex-phase4-admission.md)。在 Phase 0/2 门禁关闭前，也不承诺跨平台发布。

## 1. 产品判断

Petdex 可以为 TermBridge 的后台连接、文件传输和 AI 请求提供持续、轻量的视觉反馈，也能增加产品辨识度。但桌宠不是 SSH / SFTP 的核心能力，对专业运维用户还可能造成干扰。

因此采用以下策略：

1. 桌宠能力默认关闭，完全由用户选择启用。
2. 第一阶段只连接已安装的 Petdex Desktop，不在 TermBridge 内重做悬浮窗口和渲染器。
3. 桌宠只消费操作状态，不接收终端输出、命令、路径、主机名、凭证或 AI 对话内容。
4. Petdex 不可用时静默降级，不得影响 SSH、SFTP、AI 或应用启动。
5. 在获得真实使用证据前，不内嵌 Petdex 宠物目录，不打包社区宠物资产。

## 2. 目标与非目标

### 目标

- 用户可以在设置中启用或关闭 Petdex 联动。
- TermBridge 能把连接、传输和 AI 生命周期映射为稳定、可理解的桌宠动作。
- Petdex 未安装、未启动、Token 轮换或接口超时时，TermBridge 主功能保持正常。
- 整个集成遵守最小数据、最小权限和可随时撤销原则。
- 通过小规模试用判断桌宠是否带来可感知的状态反馈价值。

### 非目标

- 不自行实现跨窗口悬浮、拖拽、穿透点击或多显示器桌宠引擎。
- 不解析终端输出判断命令是否成功。
- 不让桌宠执行命令、连接主机或控制文件传输。
- 不默认安装 Petdex Desktop、Node.js、CLI 或任何宠物包。
- 不代理 Petdex 登录、投稿、付费或账户体系。
- 不承诺 Petdex 在线目录和第三方宠物资产的可用性或版权状态。

## 3. 推荐用户体验

在“设置 → 外观”中增加“Petdex 桌宠（实验性）”：

- 开关：启用 Petdex 联动，默认关闭。
- 状态：`未检测到`、`已连接`、`Petdex 未运行`、`连接异常`。
- 操作：`测试动作`、`打开 Petdex 官网`、`关闭联动`。
- 说明：仅发送动作状态，不发送终端内容、主机信息或凭证。

用户启用后，TermBridge 在后台操作期间驱动桌宠；用户关闭开关后立即停止所有 Petdex 请求。Petdex 未运行时不弹出重复错误，只在设置页展示状态。

## 4. 状态模型

TermBridge 应通过一个中心状态仲裁器统一决定桌宠动作，禁止各功能直接竞争写入 Petdex。

| TermBridge 事件 | Petdex 动作 | 持续时间 / 退出条件 | 优先级 |
| --- | --- | --- | ---: |
| SSH / 本地终端正在连接 | `waiting` | 连接成功或失败 | 40 |
| SSH 连接成功 | `waving` | 1.2 秒 | 80 |
| 任意上传、下载或远程复制进行中 | `running` | 所有传输完成、失败或取消 | 50 |
| AI 请求进行中 | `waiting` | 请求完成、失败或取消 | 60 |
| 操作成功完成 | `jumping` | 1.2 秒 | 80 |
| 连接、传输或 AI 请求失败 | `failed` | 2.5 秒 | 100 |
| 没有活动操作 | `idle` | 直到新事件出现 | 0 |

仲裁规则：

- 高优先级临时状态覆盖低优先级持续状态；临时状态结束后恢复仍然有效的持续状态。
- 多个并行传输使用活动计数或操作 ID 集合，不能因其中一个完成而提前回到 `idle`。
- 连续相同状态去重，并设置最小发送间隔，避免进度事件形成请求风暴。
- 取消属于中性结束，默认恢复剩余活动状态，不展示 `failed`。
- 原始终端输入和输出不参与状态判断，避免噪声、误判和数据泄漏。

## 5. 技术方案

### 5.1 首选：Rust 后端状态桥接

Petdex Desktop 在本机 `127.0.0.1:7777` 暴露状态接口，并使用启动时轮换的本地 Token 鉴权。TermBridge 新增一个 Rust 侧适配器：

```text
SSH / SFTP / AI 事件
        ↓
Petdex 状态仲裁器
        ↓
Rust PetdexAdapter
        ↓
127.0.0.1:7777/state
```

适配器职责：

- 仅在用户启用联动后读取 Petdex runtime Token。
- 每次连接失败或鉴权失败后重新读取 Token，以兼容 Petdex 重启轮换。
- 只允许请求固定的 loopback 地址和固定路径，不接受前端传入任意 URL。
- 设置短连接与短超时；失败不重试风暴，不阻塞业务操作。
- Token 永不发送到前端，永不写入 TermBridge 数据库，永不进入日志、诊断包或错误详情。
- 对外只暴露 `set_state(state)`、`test_connection()` 和 `disconnect()` 等窄接口。

采用 Rust 后端请求可以避免 WebView 读取用户目录，也不必为 `127.0.0.1:7777` 放宽前端 CSP。

### 5.2 暂缓：直接消费 Petdex 目录并自行渲染

Petdex 提供公开 manifest、`pet.json` 和 8×9 / 8×11 spritesheet 格式，技术上可以直接渲染。但该方案还需要解决：

- 网络资源缓存、校验、配额、损坏恢复和离线行为。
- 独立透明窗口、置顶、鼠标穿透、拖拽、多屏幕与 DPI 差异。
- macOS、Windows 和 Linux 的窗口行为与签名权限差异。
- 社区资产的归属、署名、下架、审核和缺失授权字段。
- Petdex 格式或目录变化后的兼容与回滚。

在状态桥接验证失败或没有足够用户需求时，不进入该方案。

## 6. 分阶段路线图

### Phase 0 — 契约验证（0.5–1 天）

| ID | 工作项 | 状态 | 证据 |
| --- | --- | --- | --- |
| PETDEX-001 | 验证 Petdex Desktop 当前状态接口、动作集合、Token 文件位置和轮换行为 | **已完成**（macOS 0.8.0 实测 + 固定 commit 源码证据） | [Phase 0 验证记录 §2](./petdex-phase0-validation.md#2-petdex-001desktop-状态接口契约) |
| PETDEX-002 | 验证 macOS / Windows 下 Petdex 未安装、未启动和重启后的失败表现 | **部分完成**（macOS 未启动/重启已实测；无安装跨平台契约探针已纳入 `windows-2025` / `macos-15` CI；Windows 真机与 ACL 仍待验证） | [Phase 0 验证记录 §3](./petdex-phase0-validation.md#3-petdex-002失败与重启路径) |
| PETDEX-003 | 确认社区资产和 manifest 的授权边界 | **已完成**（不随包分发第三方资产） | [Phase 0 验证记录 §4](./petdex-phase0-validation.md#4-petdex-003社区资产授权边界) |

退出条件：本地接口能够稳定驱动动作，且无需向 Petdex 发送 TermBridge 业务数据。

2026-08-28 审核结论：上述技术退出条件已在 macOS 真机满足，且 Token 缺失/残留、端口拒绝、401 重读和固定 loopback/路径已形成可在 `windows-2025` / `macos-15` 执行的无安装契约探针。但 Windows 真机 Petdex 失败/重启路径和 Token ACL，以及 macOS 真实未安装环境仍未验证，因此 **PETDEX-002 与 Phase 0 仍不关闭**。

有条件准入执行情况：上述证据已用于独立阶段任务实施 Phase 1，但它始终只是开发准入，不是 Phase 0 完成或发布批准。Phase 1 的完成不改变本节对 `PETDEX-002` 和 Phase 0 的部分完成判定。详见 [有条件的 Phase 1 开发准入建议](./petdex-phase0-validation.md#51-有条件的-phase-1-开发准入建议) 和 [Phase 2 发布门禁](./petdex-phase0-validation.md#52-必须保留到-phase-2-的发布门禁)。

### Phase 1 — 最小状态桥接（1–2 天）

| ID | 工作项 | 状态 | 交付物与证据 |
| --- | --- | --- | --- |
| PETDEX-010 | 增加默认关闭的实验性设置项 | **已完成** | [持久化偏好与默认值](../src/stores/appStore.ts)、[设置页开关和隐私说明](../src/components/workbench/settings-panel.tsx)、[偏好测试](../src/stores/__tests__/appStore.test.ts) |
| PETDEX-011 | 实现 Rust `PetdexAdapter` | **已完成** | [固定 loopback、禁用代理、Token 隔离、250/750 ms 超时、关闭取消与串行请求](../src-tauri/src/petdex.rs)、[Phase 0 固定契约探针](../src-tauri/tests/petdex_contract_probe.rs) |
| PETDEX-012 | 接入 SSH 连接、成功和失败事件 | **已完成** | [连接/成功事件](../src-tauri/src/session.rs)、[失败/关闭事件](../src-tauri/src/commands.rs)、[有限状态映射测试](../src-tauri/src/petdex.rs) |
| PETDEX-013 | 接入 SFTP 传输生命周期 | **已完成** | [上传、下载和远程复制的开始/完成/失败/取消接线](../src-tauri/src/commands.rs)、[有限状态映射测试](../src-tauri/src/petdex.rs) |
| PETDEX-014 | 接入 AI 请求生命周期 | **已完成** | [请求开始、完成、失败和取消接线](../src-tauri/src/ai.rs)、[有限状态映射测试](../src-tauri/src/petdex.rs) |
| PETDEX-015 | 增加设置页测试动作 | **已完成** | [主动测试和四类可见结果](../src/components/workbench/settings-panel.tsx)、[设置页集成测试](../src/components/workbench/__tests__/settings-panel.test.tsx)、[前端 IPC 枚举边界测试](../src/lib/__tests__/petdex.test.ts) |

退出条件：启用时三条事件链路可驱动桌宠；关闭或 Petdex 不可用时没有业务功能回归。

2026-08-28 Phase 1 审核结论：本地实现与自动化证据满足上述开发退出条件。适配器在关闭时不读取 Token、不发网络请求，所有业务接线均为不等待结果的旁路通知；用户主动测试也只返回 `notDetected`、`connected`、`notRunning`、`connectionError` 四类状态。请求体只能由 Rust 内部 6 个动作枚举和可选固定时长组成，不接受前端 URL、状态字符串或业务内容。Phase 1 只使用串行请求、短超时、关闭取消和 401 后 Token 变化时的单次重试；**没有实现 Phase 2 的优先级、并发活动计数、恢复、节流或失败退避**。

本结论不关闭 Phase 0：Windows 真机的安装/未启动/重启时序与 Token ACL、macOS 真实未安装环境仍未完成，`PETDEX-002` 继续保持部分完成。Phase 2 发布门禁同样保持不变；在这些门禁完成前，功能只能维持默认关闭的实验状态，不宣称跨平台可用。

### Phase 2 — 可靠性与体验（2–3 天）

| ID | 工作项 | 状态 | 交付物与证据 |
| --- | --- | --- | --- |
| PETDEX-020 | 实现中心状态仲裁器 | **已完成**（本地实现与自动化） | [单协调循环、SSH/SFTP/AI 操作 ID 集合、40/50/60/80/100 优先级、1.2/2.5 秒 TTL 与持续状态恢复](../src-tauri/src/petdex.rs)；单元测试覆盖并发 SSH、并发传输、AI/传输叠加、失败覆盖和中性取消 |
| PETDEX-021 | 增加去重、节流和失败退避 | **已完成**（本地实现与自动化） | [同状态去重、100 ms 最小发送间隔、250 ms–4 s 有界指数退避和 5 s 低频恢复探针](../src-tauri/src/petdex.rs)；状态变化在退避后重算，过期临时状态不会补发 |
| PETDEX-022 | 处理 Token 轮换和 Petdex 重启 | **已完成**（macOS 0.8.0 实测 + 自动化） | [401 后仅在 Token 变化时单次重试、每次退避重读 Token、同一适配器实例恢复测试](../src-tauri/src/petdex.rs)；`controlled_macos_petdex_restart_recovers_without_adapter_restart` 在本机 Desktop 0.8.0 通过，结束后恢复为未运行且 7777 无监听 |
| PETDEX-023 | 完成双语文案和无障碍标签 | **已完成**（本地实现与前端测试） | [设置页状态播报、`aria-live` / `aria-atomic` / `aria-busy`、隐私说明关联](../src/components/workbench/settings-panel.tsx)、[zh-CN](../src/locales/zh-CN.ts)、[en-US](../src/locales/en-US.ts) 与 [设置页测试](../src/components/workbench/__tests__/settings-panel.test.tsx) |
| PETDEX-024 | 补齐诊断边界 | **已完成**（本地实现与自动化） | [后端仅记录固定结果类别，前端仅接收四类连接状态](../src-tauri/src/petdex.rs)；请求和日志不含 Token、操作 ID、终端/主机/路径/文件名/AI 内容、响应正文或自由文本，结果类别边界有单元测试 |

退出条件：并发连接、传输和 AI 请求下动作稳定；Petdex 重启后能自动恢复；错误日志不含秘密。

2026-08-28 Phase 2 本地审核结论：PETDEX-020～024 的实现和本地证据已完成。所有业务通知仍为不等待结果的旁路；中心协调器是唯一 `/state` 写入者，关闭开关会先撤销授权、取消在途请求、丢弃事件通道并通过新协调器清空全部活动集合。重复事件不重复发送，状态变化最多 10 次/秒；失败退避上限 4 秒，成功后恢复 5 秒低频探针，以便 Petdex 在没有新业务事件时重启也能重新同步。临时状态按剩余 TTL 发送，失败结束后恢复仍活跃的 AI、传输或连接状态。

本机受控 E2E 在 `/Applications/Petdex.app` 0.8.0 上以初始“未运行、无 7777 监听”为前提，验证首次请求成功、Desktop 停止后分类为 transport、实际 Token 轮换、Desktop 重启后同一 TermBridge 适配器实例恢复、最终 `idle` 和关闭取消。测试输出未包含 Token；测试后已恢复为“未运行、无 7777 监听”，Token 文件仅复核 mode `600` / size `64`。该结果只计为 macOS 已安装/停止/重启证据，不计为 macOS 真实未安装或任何 Windows 真机证据。

最终本地复核：脚本测试 14 项、前端测试 1116 项和生产构建通过；Rust fmt、全 targets Clippy `-D warnings` 通过，Rust 全 targets 为 338 项通过 / 11 项按既有环境要求 ignored，Phase 0 契约探针 5 项通过；受控 macOS E2E 另以显式 guard 运行 1 项并通过。`git diff --check` 通过；当前真实 Token 的工作区精确匹配扫描为零，64 位十六进制候选仅有两条明确的单元测试夹具，Petdex 日志调用仅有固定结果类别。上述均为本机结果，不替代远端双平台 CI。

**Phase 2 工作项本地完成，但跨平台发布门禁不关闭。** Windows 真机安装/未安装/未启动/启动顺序/退出/重启与 Token ACL 仍未验证；macOS 真实未安装环境仍未验证；本线程也不能把本机结果记作 `windows-2025` / `macos-15` CI 已运行。功能继续保持默认关闭的实验状态，不宣称跨平台可用。

Phase 2 发布门禁：Windows 真机的安装/未启动/重启路径与 Token ACL、macOS 真实未安装降级、双平台契约探针与产品适配器测试、退避/节流、业务无回归和秘密扫描必须全部通过；未通过时只能保持默认关闭的内部/实验状态，不宣称跨平台可用。

### Phase 3 — 小规模价值验证（2–4 周观察期）

| ID | 工作项 | 状态 | 交付物与证据 |
| --- | --- | --- | --- |
| PETDEX-030 | 明确招募、知情选择、反馈问题、隐私和 2–4 周运行流程 | **已完成（流程）** | [Phase 3 运行手册](./petdex-phase3-study.md) |
| PETDEX-031 | 建立只含脱敏、明确同意后聚合的最小证据台账 | **已完成（格式）；收集中（数据）** | [初始真实台账](./petdex-phase3/evidence-ledger.json) 为 0 人且安全复核待定；[严格 schema](./petdex-phase3/evidence-ledger.schema.json) 不允许自由文本或参与者标识 |
| PETDEX-032 | 提供可重复汇总/门禁和自动化测试 | **已完成（工具）** | [门禁脚本](../scripts/petdex-phase3-gate.mjs) 输出 `collecting` / `pass` / `fail` / `blocked` 及逐项缺口；[测试](../scripts/__tests__/petdex-phase3-gate.test.mjs) 覆盖空台账不得通过等场景 |
| PETDEX-033 | 提供 GitHub 自愿反馈入口 | **已完成（入口）** | [Issue 表单](../.github/ISSUE_TEMPLATE/petdex-phase3-feedback.yml) 询问状态价值、7 日启用、干扰/资源/遮挡、安全问题和三种呈现方式，并禁止秘密、日志、主机、路径、文件名、终端/AI 内容与 Token |
| PETDEX-034 | 设置页提供主动外链，不上报数据 | **已完成（本地实现与测试）** | [设置页固定外链](../src/components/workbench/settings-panel.tsx)、[窄外链封装](../src/lib/petdex-feedback.ts) 与 [设置页测试](../src/components/workbench/__tests__/settings-panel.test.tsx)；不读取开关、不拼接应用数据、不自动请求 |
| PETDEX-035 | 完成真实观察并作准入决定 | **收集中** | 观察自 2026-08-28 开始，最早 2026-09-11、最晚 2026-09-25 截止；截至启动日真实 opt-in 0、Day-7 0/0、定性反馈 0，不能形成结论 |

不默认开启遥测。只通过自愿试用、Issue 模板和经过明确同意的用户访谈收集证据：

- 桌宠是否帮助用户发现后台传输、AI 完成或连接失败。
- 用户是否在一周后仍保持启用。
- 桌宠是否被认为干扰、幼稚、耗资源或遮挡工作区。
- 用户真正想要的是外部悬浮桌宠、TermBridge 窗口内状态角色，还是普通系统通知。

进入下一阶段至少满足：

- 有不少于 30 名明确选择加入的试用用户，或等量可复核需求证据。
- 一周后仍启用的试用用户比例不低于 30%。
- 没有由联动引起的崩溃、业务阻塞或秘密泄露。
- 定性反馈显示它不仅“有趣”，也确实改善至少一种后台状态感知。

执行口径与自动门禁额外保证：所有实际试用用户在截止时都必须有第 7 天结果；未回复者只进入 eligible 分母，不算 still-enabled；安全事件在观察结束复核前保持 `null`，不能把“尚未发现”写成已确认的 0。台账只接受公开 Issue URL 或脱敏 `anonymous:<record-id>`，不保存自由文本、姓名、账号、终端/主机/路径/文件名/AI 内容、日志或 Token。

2026-08-28 观察启动结论：运行 `pnpm petdex:phase3 -- --as-of 2026-08-28` 返回 `collecting`，缺少完成的 14–28 天观察、30 人/等量证据、完整第 7 天分母与至少 30% 保持启用、安全复核和状态感知价值反馈。该结果只证明流程可执行，不是价值验证通过。**Phase 3 尚未完成，Phase 4 尚未准入。**

不满足门槛时，保持实验性联动或移除，不继续建设内嵌桌宠系统。只有真实截止且严格命令 `pnpm petdex:phase3:gate -- --as-of YYYY-MM-DD` 返回 `pass`，才可重新审核 Phase 4。

### Phase 4 — 目录与原生渲染评估（未承诺；当前阻断）

| ID | 准入项 | 状态 | 当前证据 |
| --- | --- | --- | --- |
| PETDEX-040 | Phase 3 真实用户价值门禁 | **阻断** | 严格门禁在 2026-08-28 返回 `collecting` / exit 1；真实台账为 opt-in 0、Day-7 0/0、安全复核待完成、定性反馈 0 |
| PETDEX-041 | 逐资产可机读许可、署名、来源、版本和下架状态 | **阻断** | Phase 0 只确认 `submittedBy`、资产 URL、`spriteVersionNumber` 和上游 takedown 流程；缺许可、完整署名义务、不可变来源/内容版本和逐资产下架状态 |
| PETDEX-042 | 下载校验、缓存与清理契约 | **阻断** | 仅有路线图边界；没有可信摘要、失败关闭校验、原子写入、配额/离线/损坏恢复、用户清理/自动逐出/下架清理证据 |
| PETDEX-043 | 跨平台窗口原型 | **阻断** | 当前只有外部 Desktop 状态桥接；没有透明、置顶、穿透、拖拽、多屏、DPI、焦点、无障碍、签名/权限的平台原型矩阵 |
| PETDEX-044 | 资源占用基线 | **阻断** | 现有基准只覆盖终端路径；没有 Phase 4 idle/动画/多屏 CPU、内存、GPU、唤醒和启动影响基线或批准预算 |
| PETDEX-045 | Petdex 格式版本兼容和回滚 | **阻断** | 已知 manifest v1/v2、`spriteVersionNumber` 和 8×9 / 8×11 输入；缺支持矩阵、fixtures、未知版本失败关闭、last-known-good、降级/迁移/下架/完整禁用回滚 |

2026-08-28 准入结论：**Phase 4 未准入。** 本轮只新增 [可复核的阻断评估](./petdex-phase4-admission.md) 和 [机器可读快照](./petdex-phase4/admission-evaluation.json)，没有打开目录、下载/缓存资产、内嵌角色、创建独立悬浮窗口或实现原生渲染。`pnpm petdex:phase4:audit` 只验证“当前阻断记录自洽”，不授予准入；`pnpm petdex:phase4:gate` 在当前状态必须非零退出。

重新评估必须先在真实截止日让 `pnpm petdex:phase3:gate -- --as-of <真实截止日>` 返回 `pass` / exit 0，再补齐 PETDEX-041～045 的逐项证据，并让 Phase 4 audit 与 gate 同时通过。任何单项、计划日期或自动化夹具都不能替代真实用户门禁，也不能单独授权 Phase 4 实现。

## 7. 安全与隐私边界

- 功能默认关闭；设置开关是唯一长期授权。
- 只向 loopback 发送有限状态枚举，不发送自由文本。
- 不读取或发送终端内容、主机名、用户名、IP、路径、文件名、命令、AI 内容和操作错误详情。
- Token 只在后端内存中短暂使用，不持久化、不导出、不记录。
- `0600` 是 macOS/Linux 的 POSIX 保证；Windows 依赖 `%USERPROFILE%\.petdex` 父目录 ACL，在真机验证前不宣称具有等价隔离。
- Petdex 返回内容视为不可信；错误文本在进入 UI 或日志前进行长度限制和净化。
- 禁止由 manifest 或 `pet.json` 提供本地执行命令、任意 URL 请求或文件写入位置。
- 如果未来下载宠物资产，必须限制文件数、单文件大小、解压总量、图片尺寸和缓存总量，并校验实际内容类型。

## 8. 测试与验收

### 自动化测试

- 状态映射、优先级、TTL、并发计数和恢复顺序。
- 功能关闭时不会读取 Token 或发出网络请求。
- Token 缺失、空值、权限不足、格式错误和启动中轮换。
- 本地服务拒绝连接、超时、401、非 JSON 响应和连接中断。
- 相同状态去重、事件风暴节流和退避恢复。
- 日志、错误详情、诊断包中不存在 Token 或业务内容。
- mock loopback 服务只接受固定方法、路径、Header 和状态枚举。

### 手工验证

- macOS 与 Windows：Petdex 已安装 / 未安装、运行中 / 未运行。
- Petdex 与 TermBridge 任意顺序启动和重启。
- 同时连接多台主机、进行多项传输并发起 AI 请求。
- 功能运行中关闭开关、退出应用或取消操作。
- 系统深色 / 浅色模式、中文 / 英文设置页。

### Phase 2 完成定义

- 所有自动化测试通过，Rust fmt、Clippy 和测试通过。
- Windows 与 macOS 的核心手工场景通过。
- Petdex 任何失败都不会改变 TermBridge 操作结果或耗时等级。
- 关闭功能后不再产生 Petdex I/O。
- 没有秘密、终端数据和资产授权回归。

## 9. 失败、恢复与回滚

| 场景 | 用户表现 | 恢复方式 |
| --- | --- | --- |
| Petdex 未安装或未运行 | 设置页显示不可用，主功能不受影响 | 启动 Petdex 后重试或等待下一个事件 |
| Token 已轮换 | 当前请求失败一次 | 重新读取 Token 并受控重试 |
| 本地接口持续失败 | 暂停发送并进入退避 | 用户测试连接或下一退避周期恢复 |
| 状态仲裁异常 | 桌宠动作不准确 | 关闭实验性开关；不影响操作本身 |
| 集成产生稳定性问题 | 功能由默认关闭保持隔离 | 通过功能开关停用或完整移除适配器 |

首版只新增布尔设置和隔离适配器，不引入不可逆数据迁移。回滚时保留未知设置字段也不得阻止旧版本启动。

## 10. 继续投入的决策

| 证据 | 决策 |
| --- | --- |
| 用户把它作为后台状态反馈长期启用 | 保留桥接，继续改善可靠性 |
| 用户只短暂尝鲜，随后大量关闭 | 保持实验性，不扩建目录和渲染器 |
| 用户更偏好窗口内反馈 | 评估轻量内嵌状态角色，不做系统级桌宠 |
| 外部 Petdex 不稳定或契约频繁变化 | 冻结兼容版本或移除联动 |
| 资产授权和下架机制不完整 | 禁止内嵌目录与资产分发 |

最终成功标准不是“桌宠能动”，而是它以很低的维护和隐私成本，让用户更及时地感知后台任务状态，同时不削弱 TermBridge 作为轻量、可靠 SSH 客户端的定位。

## 参考

- [Petdex 项目与构建接口](https://github.com/crafter-station/petdex#for-builders)
- [Petdex Desktop 本地状态接口](https://petdex.dev/docs#desktop-app)
- [Petdex public manifest](https://petdex.dev/api/manifest)
