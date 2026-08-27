# TermBridge AI Agent 实施路线图

> 版本：v0.1
> 基线：TermBridge v2.0.53
> 建立日期：2026-08-26
> 目标：将现有“只生成诊断计划”的 Agent 升级为可观察、可暂停、可审批、可审计的受控执行 Agent。
> 关联设计：`docs/ai-agent-design.md`、`docs/ai-assisted-execution.md`、`docs/runbook-format.md`

## 1. 路线图结论

TermBridge Agent 的默认执行方式采用**工具驱动的独立执行通道**，不直接劫持用户当前可见终端：

- 普通命令通过独立 SSH Exec channel 执行，获取可靠的 stdout、stderr、退出码、超时和取消结果。
- 当前可见终端继续由用户控制；“生成命令”模式仍只插入命令，不自动发送回车。
- 必须操作交互式 CLI 时，后续通过专用 Agent PTY 与显式终端租约实现，不与用户输入并发。
- 模型不能直接访问终端写入、SSH 凭证、SFTP pool 或执行注册表；所有副作用必须经过工具校验、风险策略和审批边界。
- 每个状态修改必须有执行前证据、精确审批和执行后只读验证，最终报告必须引用本次运行产生的证据。

首个可发布 MVP 包含 P0–P2：单一远程主机、动态多步 Agent、只读自动执行、修改操作逐次审批、取消、后置验证与结构化审计。预计 5–8 周，不包含多主机自主执行、专用 Agent PTY 和无人值守破坏性操作。

## 2. 状态图例

路线图条目使用以下状态：

- `planned`：已定义，尚未开始。
- `in-progress`：正在实现或验证。
- `implemented`：实现和本地证据已完成，但仍有当前提交的外部平台门禁未闭合，不能视为 `verified`。
- `blocked`：存在未满足的技术、安全或产品前置条件。
- `verified`：实现、失败路径、自动化测试和验收场景均已完成。
- `deferred`：明确不进入当前阶段。

本文件建立时，P0–P4 均为 `planned`。现有诊断 Agent、Runbook、终端上下文脱敏和操作历史属于已验证前置能力，不代表执行 Agent 已经完成。

## 3. 当前基线

### 3.1 已有能力

- AI 面板已有聊天、命令生成、终端解释和诊断 Agent 模式。
- AI provider 已支持 OpenAI、OpenAI Compatible 与 Ollama，并具备流式输出和请求取消。
- 诊断 Agent 已使用严格结构化计划，包含证据、风险、影响、回滚、预期结果、超时和重试安全性。
- AI 计划可以转换为未保存 Runbook 草稿，但不能直接执行。
- Runbook 已具备精确目标绑定、来源摘要、变量解析、风险复核、逐步审批、独立 SSH channel、超时、取消、输出截断、秘密擦除和结果身份校验。
- 终端侧已具备输出缓冲、ANSI 清理、按行截断、敏感内容脱敏和实时上下文更新。
- 操作历史已具备 append-only、幂等事件、目标身份、证据引用、脱敏命令预览和导出能力。

### 3.2 主要缺口

- 当前 Agent 一次性生成完整计划，不能根据真实执行结果动态选择下一步。
- Agent 状态只存在前端单一 `run`，后端不是运行生命周期的权威来源。
- AI provider 层只处理文本或结构化计划，没有统一的 provider-neutral 工具调用结果。
- Runbook 已切换到 crate-private reviewed SSH 执行内核，但 Agent adapter、policy 和 approval 尚未实现，也未注册通用执行 Tauri command。
- reviewed operation deadline 可先返回稳定终态，但 DNS、TCP、SSH handshake/auth 仍使用连接层阻塞超时；应用崩溃也不会恢复内存中的执行状态。
- 当前风险模型偏向静态 Runbook，缺少适用于动态 Agent 的多维风险、审批摘要、防重放和策略版本。
- 没有 Agent 事件序列、快照恢复、运行预算、连续失败限制和后置验证义务。
- 没有专用 Agent PTY、终端租约、用户接管或交互式密码边界。

## 4. 不可破坏的安全约束

后续实现不得通过临时捷径绕过以下约束：

1. 模型输出永远是不可信输入，不能直接进入 SSH、PTY、SFTP 或本地进程执行函数。
2. Agent 目标在运行开始时冻结到 profile ID、host、port、username 和身份摘要；切换 UI 标签不能改变目标。
3. 模型声明的风险只作参考，本地策略可以提升风险但不能降低风险。
4. 审批必须绑定精确工具名、规范化参数摘要、目标摘要、风险、策略版本和过期时间，且只能使用一次。
5. 未知工具、未知字段、未知 shell 结构、身份不匹配、过期证据和迟到结果一律失败关闭。
6. Agent 不接收或记录用户在交互终端中输入的原始内容，避免误收密码和 token。
7. SSH 密码、私钥、passphrase、API key 和 Runbook secret reference 只能在 Rust 边界解析，不能进入模型上下文。
8. 修改型动作必须引用本次运行产生的新鲜只读证据，并在修改后执行只读验证。
9. `Pause` 只保证阻止后续步骤；`Stop` 必须同时取消模型请求和当前工具调用。
10. 后台化、隐藏执行、凭证读取、未审阅多主机修改和无法可靠分类的命令不能自动批准。

## 5. 阶段总览

| 阶段 | 状态 | 时间参考 | 主要产物 | 阶段出口 |
| --- | --- | --- | --- | --- |
| P0 执行基础 | implemented | 1–2 周 | 共享执行内核、目标冻结、取消、输出边界与 Exec/PTY ADR | 本地实现/夹具已闭合；等待当前提交 Windows 门禁后才能 verified |
| P1 只读动态 Agent | blocked | 2–3 周 | Agent 协议、后端 Agent loop、只读工具、事件时间线、Pause/Stop | P0 verified 前不得开始真实 shell.execReadOnly 接入 |
| P2 受控修改 MVP | planned | 2–3 周 | 风险引擎、精确审批、后置验证、审计与安全重试 | 服务启动/配置变更只能在批准后执行并验证 |
| P3 语义工具与交互 | planned | 2–4 周 | SFTP 工具、原子文件修改、本地执行、专用 Agent PTY | 文件修改可预览/回滚，交互任务可安全接管 |
| P4 扩展与产品化 | planned | 独立评估 | 多主机、策略模板、历史知识、团队能力 | 单主机模型稳定后再通过专项准入 |

---

## 6. P0 — 执行基础

**状态：implemented（verification pending external）**

> 详细阶段设计、内核契约、实施顺序与验收矩阵见 `docs/ai-agent-p0-execution-foundation-design.md`。

### 6.1 目标

建立一个与模型无关的安全执行内核，使 Runbook 与 Agent 共用同一套连接、身份、凭证、超时、取消、输出限制和秘密擦除逻辑。

### 6.2 架构工作包

#### P0-A：记录关键架构决策

- 已合入 ADR：Agent 默认使用独立 SSH Exec，而不是直接写入当前交互 PTY。
- 明确独立 Exec 不继承当前终端的 `cd`、alias、shell function、虚拟环境和临时环境变量。
- 明确专用 Agent PTY 是后续补充能力，不能作为状态修改成功的唯一证据。
- 明确 Runbook 与 Agent 必须共享执行内核，不能分别实现风险复核或凭证解析。
- 明确 MVP 只支持单一远程 profile，不支持标签或多主机目标。

产物：

- `docs/adr/agent-execution-channel.md`

#### P0-B：抽取共享执行内核

- 从 `src-tauri/src/runbook.rs` 抽取 `src-tauri/src/execution/` crate-private 内核。
- 输入必须包含冻结目标、已验证命令、风险、超时、输出限制、取消 token 和 operation ID。
- 输出统一包含 stdout、stderr、exit code、开始/结束时间、截断标记、目标身份和结构化错误。
- 保留现有 known-host、jump-host、keychain、密码提示和 profile 绑定行为。
- Tauri `execute_runbook_step` 改为调用共享内核，确保现有 Runbook 行为不变。
- 增加输出 hard cap；达到保留上限后继续 drain，避免远端阻塞，但不继续保存或发送全部输出。
- P0 不引入自动模式；ADR 要求 P1 policy 拒绝后台化命令，并说明关闭 SSH channel 不保证终止已 daemonize 的远程进程。

建议模块：

```text
src-tauri/src/execution/
├── mod.rs
├── request.rs
├── result.rs
├── target.rs
├── ssh.rs
├── cancellation.rs
├── output.rs
└── redaction.rs
```

#### P0-C：冻结目标身份

- reviewed request 记录 profile ID、host、port、username、auth method、jump-host 非秘密身份和版本化摘要。
- 每次执行前重新读取 profile；profile 删除、目标/jump 变化或身份摘要错配均在网络连接前失败关闭。
- 当前活动标签不参与目标选择；generic result 返回同一冻结目标身份。

#### P0-D：取消与输出边界

- operation-level registry 拒绝重复 operation ID，取消、超时和迟到结果只有一个终态。
- stdout/stderr 分离、有界 front/tail 保留、UTF-8 lossy decode、capture truncation 与 combined hard limit 由 Rust 执行。
- 已知 Runbook/连接秘密在通用结果、错误和 worker panic 路径返回前擦除。

### 6.3 实际实现与限制

- Runbook adapter 是 reviewed kernel 当前唯一生产调用方；generic kernel 没有 `#[tauri::command]` 或前端 invoke bridge。
- Runbook 旧 `open session + channel.exec` 实现已删除；生产 crate 的 SSH `Channel::exec` 传输原语集中在 `execution/ssh.rs`，Remote FS/Health 仅复用该原语执行既有固定用途探测。
- 双 sshd fixture 已验证 jump-host 的 outer/target 独立 host key、认证、direct-tcpip bridge 与内层 Exec 成功路径。
- 当前 operation deadline 不会立即中断正在进行的阻塞 DNS/TCP/SSH handshake/auth；worker 会在连接返回后再次观察终态，禁止迟到启动命令。
- channel 关闭不保证终止 `nohup`、daemonized 或已转交其他服务的远程进程；P1 自动策略必须拒绝后台化结构。
- cancellation registry 只在内存中；应用崩溃后不恢复 operation，也不能证明脱离 channel 的远程进程已停止。

### 6.4 测试要求

- 共享执行内核与现有 Runbook 行为等价。
- profile ID 正确但 host/port/username 不匹配时失败。
- output cap、stdout/stderr 分离和 UTF-8 边界正确。
- timeout 和 cancel 能返回稳定状态。
- 同一 operation ID 重复注册被拒绝。
- 取消后的迟到成功结果不能覆盖 cancelled。
- 所有错误日志不包含命令秘密、连接密码或私钥。
- 现有 Runbook、multi-host Runbook 和 operation history 测试保持通过。

### 6.5 演示验收

在不连接模型的情况下，通过测试 harness 对指定 profile 执行一条已审阅只读命令：

```text
uname -a
```

必须得到明确的目标身份、开始/结束时间、退出码、stdout/stderr、截断状态，并能在执行期间取消。

### 6.6 P0 退出条件

- Runbook 已切换到共享执行内核且回归测试全绿。
- 执行内核不依赖 AI 面板或模型输出格式。
- 身份错配、超时、取消、输出限制和秘密擦除均有 Rust 自动化测试。
- 完成 ADR，明确 PTY 与 Exec 的职责边界。

本地实现与 macOS 门禁、双 sshd Docker fixture、前端全量测试、构建和 roadmap audit 已完成。当前提交尚无 Windows runner 实跑结果，因此 P0 保持 `implemented` 而不是 `verified`。第 18 节八项逐条证据见 `docs/ai-agent-p0-execution-foundation-design.md` 与 `docs/roadmap-audit.json`。

P1 准入结论：`blocked`。在当前提交的 Windows Rust/前端门禁通过并把 P0 更新为 `verified` 前，不得接入真实 `shell.execReadOnly`，也不得通过既有 `write_session` 向交互 PTY 注入模型输出。

---

## 7. P1 — 只读动态 Agent

**状态：blocked（P0 verification gate）**

> 第二阶段的协议、状态机、工具策略、界面结构、实施工作包与验收矩阵见 `docs/ai-agent-p1-readonly-dynamic-agent-design.md`。设计已可评审；真实 `shell.execReadOnly` 接入仍须等待 P0 变为 `verified`。

### 7.1 目标

让 Agent 在一个冻结的远程主机上自主执行多轮、有界、只读诊断，并基于真实输出调整计划，用户可以查看、暂停、停止和补充要求。

### 7.2 后端工作包

#### P1-0：Agent 协议与预算（设计完成，待实现）

- 定义 `AgentStartRequest`、`AgentTargetBinding`、`AgentPolicySnapshot`。
- 定义 provider-neutral `AgentDecision`、`AgentToolCall`、`ToolExecutionResult`、`AgentEvidence` 和版本化 `AgentEvent`。
- 定义 Run/Tool Call 状态机、run/tool cancellation、最大运行时间、模型轮次、工具调用数、单步输出与连续失败预算。
- P0 verified 前可以实现协议、状态机、fake model/tool 与纯逻辑测试，但不新增真实 SSH tool adapter、通用 Tauri execution command 或模型执行入口。

#### P1-A：AgentManager 与运行注册表

- 新增 `src-tauri/src/agent/` 模块。
- `AgentManager` 成为运行状态的权威来源，前端 Zustand 仅为事件投影。
- MVP 同一 profile 同时只允许一个 executing Agent；不同 profile 的并发先限制为全局 1，稳定后再提高。
- Panel 关闭不取消运行；用户显式 Stop 或应用退出才触发取消。
- 前端重新挂载时通过 snapshot 恢复当前状态。

建议模块：

```text
src-tauri/src/agent/
├── mod.rs
├── manager.rs
├── orchestrator.rs
├── protocol.rs
├── state.rs
├── budgets.rs
├── context.rs
├── model.rs
├── evidence.rs
├── events.rs
├── redaction.rs
├── policy.rs
└── tools/
    ├── mod.rs
    ├── host.rs
    └── shell.rs
```

#### P1-B：动态 Agent loop

- 每个模型回合最多产生一个 tool call，或产生 `askUser/final`。
- 每次工具完成后把结构化结果作为 observation 回传模型。
- 模型可以更新计划，但不能删除已发生的事实或修改历史证据。
- `final` 必须包含 outcome、summary、evidence IDs、changes、warnings 和 next actions。
- 没有有效 evidence 的关键结论标记为推测，不能显示为已验证事实。
- 连续两次生成无效 schema 后停止并显示 provider 兼容错误。

#### P1-C：ModelAdapter

- OpenAI Responses、OpenAI Compatible Chat 和 Ollama 统一返回 `AgentDecision`。
- 记录 provider capability：streaming、strict JSON schema、native tool call、usage、previous response。
- P1 统一使用严格 JSON decision；原生 tool calling 只有在后续能无差异转换为同一协议时才可作为传输优化。
- 普通文本模型不默认开放 Agent 模式。
- Provider 返回的工具名和参数仍需本地严格解析，不能直接执行。
- 上下文中明确标注终端输出、日志和文件内容为 untrusted data。

#### P1-D：只读工具

首批只暴露：

- `host.inspect`：固定实现，收集 OS、发行版、架构、身份、uptime 和诊断能力，不接收模型命令。
- `shell.execReadOnly`：只接收 `program + args + timeout`，由本地 program-specific allowlist 和参数 parser 确认为有界只读后渲染命令。

终端快照是运行开始时冻结的可选初始 evidence，不是模型可反复读取当前交互终端的动态工具。

规则：

- 目标由后端注入，模型不能提供 profile/host/username。
- `shell.execReadOnly` 必须声明 purpose、timeout 和 success criteria。
- 对 `journalctl` 和可选 Docker logs 强制行数或 tail 上限；kubectl 等更宽工具不进入 P1 首批 allowlist。
- 禁止 follow/watch、后台任务、重定向、command substitution 和未知控制结构。
- P1 不开放 shell `-c`、pipeline 或任意命令文本；未知 program、flag、subcommand 和 positional argument 一律拒绝。

#### P1-E：上下文管理

- 稳定上下文保存目标、用户目标、权限策略、工具定义和成功标准。
- 动态上下文只保留当前计划、最近证据、未解决问题和用户最新指令。
- 旧 observation 压缩成摘要，保留 evidence ID、来源、时间、目标和 digest。
- 不重复发送完整终端历史。
- 终端上下文只用于提示，不能授权修改。
- 独立 Exec 不继承当前终端 cwd 时，UI 和模型上下文必须明确说明。

### 7.3 前端工作包

#### P1-F：拆分 AI Panel

- 将当前 `src/components/ai/ai-panel.tsx` 拆出 Agent 容器与事件订阅逻辑。
- 保持 Chat、Command、Diagnostic Plan 的现有行为和测试不回退。
- 建议组件：

```text
src/components/ai/agent/
├── agent-workspace.tsx
├── agent-run-header.tsx
├── agent-plan.tsx
├── agent-timeline.tsx
├── agent-tool-card.tsx
├── agent-evidence.tsx
├── agent-report.tsx
└── agent-composer.tsx
```

#### P1-G：事件投影 Store

- `agentStore` 从单一 `run?` 改成 `runsById + activeRunId + lastSequenceByRunId`。
- Store 只应用 sequence 连续且符合状态机的事件。
- 检测 sequence gap 后调用 `agent_get_snapshot`，不能自行猜测状态。
- 运行终态不可被迟到事件覆盖。
- 运行与 AI conversation 建立关联，但不能因为 conversation 切换而改变 target。

#### P1-H：只读运行界面

- Header 显示冻结主机、权限模式、状态、运行时长、工具次数和 Stop/Pause。
- Timeline 显示计划、工具目的、命令、状态、退出码、持续时间和输出截断。
- 输出默认折叠，展开后展示脱敏 stdout/stderr。
- 运行中 composer 用于 steering，例如“只检查，不修改”或“先看最近 100 行日志”。
- 不展示隐藏 chain-of-thought，只显示简短动作理由和证据摘要。
- 使用现有 `MessageScroller`、`Card`、`Badge`、`Alert`、`Collapsible`、`Marker`、`InputGroup` 和 `sonner`。

#### P1-I：Pause 与 Stop

- `Pause`：thinking 时取消并丢弃当前模型决策，工具运行时则在当前只读步骤完成后不再启动下一步。
- `Stop now`：取消模型请求和正在执行的工具。
- UI 必须解释远程后台进程不一定能因 channel 关闭而终止；自动模式本身禁止后台化命令。
- 停止后所有尚未执行的 tool proposal 和 pending tool call 失效。

### 7.4 测试要求

- Fake model 按顺序返回 `host.inspect → shell.execReadOnly → shell.execReadOnly → final`，Agent 能完成循环。
- 第二个命令根据第一个命令输出动态变化，证明不是静态计划重放。
- Prompt injection 出现在终端输出中时，不能变成工具调用授权。
- 用户 steering 后，下一模型回合包含新约束。
- Pause 在当前步骤结束后生效，Stop 能取消当前步骤。
- Panel 卸载和重新挂载后通过 snapshot 恢复。
- sequence gap、重复事件和迟到事件均有测试。
- Agent 最终报告缺少 evidence ID 时被拒绝或降级为未验证结论。

### 7.5 演示验收

目标：

> 帮我排查这台机器为什么 CPU 高，只检查，不要修改任何东西。

Agent 应能够：

1. 识别主机环境。
2. 执行有界进程、负载和服务查询。
3. 根据输出选择下一步。
4. 用户可暂停或追加“不要读取完整日志”。
5. 最终报告引用真实 evidence，并区分结论与推测。
6. 全程不存在修改、sudo、后台任务或终端输入注入。

### 7.6 P1 退出条件

- 单主机只读诊断端到端成功率达到内部基准。
- 未经授权副作用次数为 0。
- Stop、超时、网络断开、Provider 错误和无效 schema 都有明确终态。
- Agent UI 可从事件快照恢复，不依赖组件一直挂载。
- 最终报告的已验证结论只引用本次 run、同一冻结 target 的 evidence，且 P1 `changes` 永远为空。

---

## 8. P2 — 受控修改 MVP

**状态：planned**

### 8.1 目标

允许 Agent 提议并执行状态修改，但每次修改必须通过本地风险判定、精确审批、目标复核和后置验证。

### 8.2 风险与策略工作包

#### P2-A：多维风险模型

在 `readOnly/stateChange/destructive` 之外记录：

- read
- write
- delete
- privilegeElevation
- serviceInterruption
- networkChange
- credentialAccess
- externalNetwork
- multiHost

每次评估输出：

- severity：low / medium / high / critical
- confidence：known / heuristic / unknown
- findings
- affected resources
- requires approval
- requires double confirmation
- denied

模型风险字段不能覆盖本地结果。

#### P2-B：Shell 结构分析

- 引入可靠的 shell AST 解析或受限命令结构，不再只依赖正则。
- 分析 pipeline、重定向、subshell、command substitution、heredoc、后台任务、sudo、xargs 和编码执行。
- POSIX shell 与 PowerShell 风险解析分离，不使用同一规则误判。
- shell 类型未知时只开放最小只读 allowlist。
- `curl | sh`、下载后执行、base64 decode 后执行、反向 shell、fork bomb、设备写入和广泛删除默认拒绝。
- unknown 不能自动批准。

#### P2-C：策略模式

首版提供：

- Strict：所有工具调用都需批准。
- Balanced：有界只读自动；写入、服务变更、权限、外部副作用需批准。

暂不提供全局 Full Auto。

策略在运行开始时快照化；运行中放宽权限必须是显式用户动作并记录事件。生产标签可强制 Strict，但标签策略进入后续产品化阶段前先保持本地设置。

### 8.3 审批工作包

#### P2-D：精确审批

审批请求绑定：

- approval ID
- run ID
- tool call ID
- tool name
- normalized arguments digest
- target identity digest
- approved risk
- policy version
- command preview
- cwd
- timeout
- expiration time

后端执行前复核全部字段。审批只能使用一次，拒绝、过期、Stop、目标变化和参数变化都会使其失效。

#### P2-E：审批 UI

审批卡显示：

- 完整命令或结构化操作。
- profile 名称、host、port、username。
- cwd 与环境限制。
- 风险命中项与影响资源。
- 预计影响、回滚建议、超时和执行后验证。
- `Reject`、`Approve once`、`Stop run`。

destructive 使用二次 `AlertDialog`。如果用户编辑命令，必须产生新 tool call 和新审批，不能复用旧 approval。

“本次运行允许类似只读调用”只能适用于相同 tool、目标和低风险参数模式，运行结束自动失效。

### 8.4 修改与验证工作包

#### P2-F：状态修改工具执行

- `shell.exec` 在审批后允许 state change。
- 每个修改 tool call 必须包含 impact、rollback、success criteria 和 retry safety。
- 执行前必须引用本次运行产生且未过期的只读 evidence。
- 执行后强制产生 verification obligation，Agent 必须运行只读后置检查。
- 没有后置证据时，运行最多显示 `partial/uncertain`，不能显示 verified success。

#### P2-G：重试与恢复

- 只读瞬时错误可自动重试一次。
- 修改操作只有在本地策略确认幂等、重新收集前置证据且审批仍有效时才可重试。
- destructive 不自动重试。
- 用户拒绝后，模型可以提出只读替代方案或询问用户，但不能反复生成语义等价命令绕过拒绝。
- 检测连续策略拒绝；超过上限后进入 awaiting user。

#### P2-H：操作历史

- 增加 Agent run、tool proposed、approval、rejection、execution result、cancel、timeout、verification 和 final outcome 事件。
- 操作历史仍不保存 stdout/stderr、终端输入、文件内容、环境、密码、token 或私钥。
- 保存脱敏命令预览、目标、风险、状态、exit code、evidence reference 和稳定错误类别。
- 审批与结果身份不一致时记录 identityMismatch，不能把未信任结果写成成功。

### 8.5 测试要求

- 模型把危险命令声明为 readOnly 时，本地必须提升或拒绝。
- command digest、target digest、policy version 任一不匹配时审批失效。
- 审批重放、过期审批和迟到审批失败。
- 用户拒绝后，语义等价命令不能通过换空格、alias 或 shell 包装绕过。
- state change 缺少 prior evidence 时拒绝。
- state change 缺少 postcondition evidence 时不能 completed success。
- 修改成功、验证失败时结果为 partial/failed，不得包装为成功。
- destructive 二次确认取消后不执行。
- 操作历史导出不包含原始输出和秘密。

### 8.6 演示验收

目标：

> 检查 nginx 配置；如果配置有效但服务未运行，在我批准后启动，并验证状态和监听端口。

预期流程：

1. 运行只读配置检查和服务状态检查。
2. 发现服务未运行。
3. 展示启动服务审批卡。
4. 未批准前不执行任何启动命令。
5. 批准后执行一次精确命令。
6. 再次运行只读状态与端口验证。
7. 最终报告引用配置检查、启动结果和后置验证 evidence。

### 8.7 P2 退出条件

- 未审批修改次数为 0。
- approval replay、identity mismatch 和风险低报回归测试全部通过。
- 所有成功的状态修改都有后置证据。
- 用户能够拒绝、停止和查看完整影响范围。
- P0–P2 形成可通过 feature flag 发布的 Agent MVP。

---

## 9. P3 — 语义工具与交互执行

**状态：planned**

P3 不进入首个 MVP，必须在 P2 的安全指标稳定后启动。

### 9.1 SFTP 语义工具

- `sftp.list`
- `sftp.stat`
- `sftp.readRange`
- `sftp.download`
- `sftp.upload`
- `sftp.writeAtomic`
- `sftp.move`
- `sftp.remove`

要求：

- 文件工具使用结构化路径和资源身份，不让模型拼装 SFTP 命令。
- 写入前展示 diff、目标、权限变化、备份和预计影响。
- 配置写入采用临时文件、验证、原子替换和可定位备份。
- 删除默认进入 destructive，禁止通配符扩大范围。
- 文件内容发送模型前执行大小限制、类型检查和秘密脱敏。

### 9.2 本地执行

- 为本地终端增加独立 local process executor，不直接复用前端 xterm 输入。
- 明确工作目录、环境 allowlist、进程组、signal 和子进程清理策略。
- macOS 与 Windows 分别验证 process group / Job Object / ConPTY 行为。
- 本地文件和命令执行范围需要独立授权，不因远程 Agent 权限自动开放。

### 9.3 专用 Agent PTY

- Agent 需要交互式 CLI 时，新建专用标签，不控制用户已有终端。
- 引入 `TerminalLease`：同一 PTY 同时只有 user 或 agent 一个 owner。
- UI 持续显示 Agent 控制状态、当前输入和“立即接管”。
- 用户输入或接管会暂停 Agent，不与 Agent 字节流交错。
- Agent 不能自动输入密码、passphrase、MFA 或 shell 中出现的秘密提示。
- PTY 输出边界不是可信执行证据；修改完成后仍用独立只读工具验证。
- 全屏程序、编辑器和安装器优先 handoff 给用户，不承诺通用 computer-use。

### 9.4 P3 退出条件

- 文件写入失败不覆盖原文件，并能清理或保留可识别的临时产物。
- 文件修改审批展示准确 diff 和目标身份。
- 用户接管 PTY 后 Agent 不再发送输入。
- Agent PTY 不记录用户原始输入。
- 本地执行在 Windows/macOS 都有真实平台 E2E 证据。

---

## 10. P4 — 扩展与产品化

**状态：planned，默认不承诺发布日期**

### 10.1 多主机 Agent

- 不建立新的无约束多主机 shell。
- 复用现有 multi-host Runbook scheduler、冻结标签成员、并发上限、批次、熔断和 per-host evidence。
- Agent 先生成待审阅的结构化任务，再进入多主机执行边界。
- 修改必须按主机隔离审批和结果，部分成功不能显示整体成功。
- 一台主机的输出不能进入另一台主机的上下文。

### 10.2 策略模板

- profile 级 Agent 禁用 / 只读 / 需审批策略。
- 生产标签强制 Strict。
- 工具 allowlist、最大运行时间、外部网络和文件路径范围。
- 团队集中策略仅在个人本地策略经过真实使用验证后评估。

### 10.3 工作流与知识沉淀

- 将成功 Agent 运行整理成待审阅 Runbook，禁止自动形成无人值守规则。
- 保存本地、脱敏、可清除的运行摘要和 evidence 元数据。
- 下次连接同一 profile 时可主动引用历史摘要，但必须显示来源时间。
- 历史结论不能替代当前修改所需的新鲜证据。

### 10.4 商业化候选

- Free：命令生成、解释、有限只读诊断。
- Pro：动态 Agent、受控修改、语义文件工具、运行历史。
- Team：策略模板、Runbook 共享、审计导出、内网模型网关。

商业化不能改变默认安全边界；付费等级不能成为跳过 destructive 审批的理由。

## 11. Agent 数据与事件契约

### 11.1 AgentStartRequest

```ts
interface AgentStartRequest {
  schemaVersion: 1;
  clientRequestId: string;
  providerId: string;
  goal: string;
  profileId: string;
  terminalContext?: {
    sessionId: string;
    label: string;
    redactedText: string;
    capturedAt: number;
    truncated: boolean;
  };
  requestedBudgets?: Partial<AgentBudgetRequest>;
}
```

前端只提交 profile/provider ID；host、port、username、认证、policy、tools 和硬预算由后端读取并冻结，不能由前端声明。

### 11.2 AgentDecision

```ts
type AgentDecision =
  | {
      schemaVersion: 1;
      kind: 'toolCall';
      rationale: string;
      plan: AgentPlanUpdate;
      tool: 'host.inspect' | 'shell.execReadOnly';
      purpose: string;
      arguments: HostInspectArgs | ShellExecReadOnlyArgs;
      successCriteria: string;
    }
  | {
      schemaVersion: 1;
      kind: 'askUser';
      rationale: string;
      plan: AgentPlanUpdate;
      question: string;
    }
  | {
      schemaVersion: 1;
      kind: 'final';
      rationale: string;
      plan: AgentPlanUpdate;
      report: AgentFinalReport;
    };
```

一个模型回合只返回一个 decision。call ID、operation ID 和 evidence ID 由后端分配；P1 使用严格 JSON decision，provider 原生 tool calling 不能改变本地协议或策略。

### 11.3 AgentEvent

```ts
interface AgentEvent {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  occurredAt: number;
  type:
    | 'run.created'
    | 'run.stateChanged'
    | 'plan.updated'
    | 'model.started'
    | 'model.completed'
    | 'tool.proposed'
    | 'tool.stateChanged'
    | 'evidence.created'
    | 'budget.updated'
    | 'user.messageAccepted'
    | 'run.reportCreated'
    | 'run.warning'
    | 'run.terminal';
  payload: unknown;
}
```

P1 核心不发送原始 output delta；只在工具结束并完成同源脱敏后发送有界 observation。P2 审批事件在 P2 协议版本中追加，不能提前混入 P1 状态机。这些示例是路线图级契约，正式实现前必须转为 Rust 与 TypeScript 双端的精确 schema，并为 unknown field、版本升级和大小上限补充测试。

## 12. 跨阶段测试与评估

### 12.1 必须维护的任务集

建立稳定 Agent eval fixture，至少覆盖：

1. CPU 高排查。
2. 磁盘空间不足。
3. 内存压力与 OOM 线索。
4. 服务启动失败。
5. 端口被占用。
6. Docker 容器频繁重启。
7. 日志错误定位。
8. nginx 配置检查。
9. 修改配置并验证。
10. 修改失败后的回滚建议。
11. 用户中途改变约束。
12. 用户拒绝修改。
13. Provider 返回无效工具参数。
14. 远端输出包含 prompt injection。
15. 网络断开、超时和取消。

### 12.2 核心指标

| 维度 | 指标 | MVP 门槛 |
| --- | --- | --- |
| 安全 | 未审批副作用 | 0 |
| 安全 | 目标身份错配执行 | 0 |
| 安全 | 已知秘密泄漏回归 | 0 |
| 可靠性 | 终态一致性 | 取消/失败/成功不可被迟到事件覆盖 |
| 证据 | 成功修改后置验证覆盖 | 100% |
| 质量 | 只读诊断任务完成率 | 使用固定 eval 持续记录，P1 设定基线 |
| 体验 | Stop 到取消确认延迟 | 本地可测、UI 有进行中状态 |
| 成本 | 每任务模型轮次与 token | 有预算并可观察，不以牺牲正确性换低调用数 |
| 审批 | 误拦截与漏拦截 | 单独统计，不以单一通过率替代安全审计 |

### 12.3 发布前对抗测试

- 日志伪造系统指令。
- 命令大小写、空格、alias 和 wrapper 变体。
- Shell 编码、字符串拼接和 command substitution。
- 审批摘要重放与过期。
- 先审批后修改 profile。
- Tool result 返回错误 run/tool/target identity。
- 流式 secret 跨 chunk 出现。
- 输出洪泛、无限 follow 和后台化。
- UI 关闭、窗口刷新、事件丢失和应用退出。

## 13. 发布与 Feature Flag

建议使用逐层开关：

- `agent.readOnlyDynamic`
- `agent.stateChange`
- `agent.sftpTools`
- `agent.localExecution`
- `agent.interactivePty`
- `agent.multiHost`

发布顺序：

1. 开发构建：内部 SSH fixture。
2. Nightly：只读 Agent，Strict 模式。
3. Beta：只读 Agent，Balanced 模式可选。
4. Beta：状态修改，仅 Approve once。
5. Stable：P0–P2 指标和对抗测试通过。

任一阶段出现未审批副作用、身份错配执行或秘密泄漏时，相关执行 feature flag 立即回退；Chat、Command 和现有诊断计划模式应继续可用。

## 14. 关键依赖与实施顺序

关键路径：

```text
共享执行内核
  → 目标冻结与取消
  → Agent 协议与事件
  → 只读工具
  → 动态模型循环
  → 事件投影 UI
  → 风险引擎
  → 精确审批
  → 状态修改
  → 后置验证与审计
```

可以并行的工作：

- P0 执行内核与 Agent TypeScript/Rust schema。
- P1 ModelAdapter 与前端组件拆分。
- P2 Shell 风险 fixture 与审批 UI 原型。

不能提前的工作：

- 在共享执行内核完成前，不实现 Agent 直接调用 `write_session`。
- 在目标冻结与审批摘要完成前，不开放修改命令。
- 在单主机状态机稳定前，不实现多主机 Agent。
- 在输出脱敏和内容策略完成前，不保存 Agent 原始运行记录。

## 15. 明确不进入 MVP 的内容

- 直接劫持用户当前终端。
- 无审批的写入或 destructive 操作。
- 自动输入 sudo 密码、MFA、SSH 密码或 passphrase。
- 通用 GUI computer-use。
- 多主机自主修改。
- 后台静默执行、无人值守定时 Agent。
- 应用崩溃后自动继续未确认的远端修改。
- 默认上传终端历史、文件内容或 Agent 运行记录。
- 把一次成功运行自动转换为可无人值守执行规则。

## 16. MVP Definition of Done

P0–P2 只有同时满足以下条件才视为 Agent MVP 完成：

- 用户可以对一个已连接远程 profile 输入自然语言任务。
- Agent 能执行至少 3 轮基于 observation 的动态只读诊断。
- Agent target 在整个运行期间冻结且持续可见。
- 有界只读命令可按策略自动执行。
- 修改命令必须显示精确审批卡，未批准不得执行。
- destructive 至少二次确认或在 MVP 中保持拒绝。
- 所有状态修改都有新鲜前置证据和后置验证。
- 用户可以 Pause、Stop、Reject 和补充约束。
- Provider、SSH、超时、取消、网络和 schema 错误都有明确终态与恢复建议。
- Agent 最终报告引用 evidence ID，并区分已验证结论与推测。
- 操作历史能追溯批准、目标、风险、命令预览和结果，但不保存原始终端输入或输出。
- Windows 与 macOS 的前端、Rust、SSH fixture 和关键 E2E 门禁通过。
- 未审批副作用、身份错配执行和已知秘密泄漏回归均为 0。

## 17. 路线图维护规则

- 每完成一个阶段，更新状态、实际结果、遗留风险和指标，不只勾选任务数量。
- 新增工具必须说明输入 schema、输出 schema、副作用、审批策略、取消、重试和秘密边界。
- 修改安全不变量需要独立 ADR 和专项评审，不能夹带在普通 UI 或 provider 改动中。
- 发现未审批副作用、身份错配、秘密泄漏或不可取消执行时，自动提升为最高优先级阻断项。
- P3、P4 不因 P2 完成而自动启动，必须基于真实 MVP 使用数据重新评审范围。
