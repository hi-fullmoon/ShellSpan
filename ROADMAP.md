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
- Deployment Runbook v2 已完成阶段 5/5：在阶段 2 单主机执行、阶段 3 持久化/恢复/独立回滚和阶段 4 显式 canary + rolling 协调之上，增加独立 Deployment 工作台、合法模板/导入导出、后端 review 冻结、精确单主机/批次审批、批次/主机证据、恢复入口与独立回滚建议；仍不进入 v1 tag 调度、流量切换、动态发现、任意 Shell、无人审批回滚或后台 GC。

### 3.2 主要缺口

- 旧静态诊断计划仍作为 fallback；P1 已实现 observation-driven fake Agent loop，但生产 dynamic start 仍因 P0/P1-D 门禁而 blocked。
- P1-A 已建立后端权威 run registry，P1-E 已建立 snapshot-authoritative 前端投影。
- AI provider 已统一到 provider-neutral strict `AgentDecision`；真实 tool observation 仍缺 P1-D SSH adapter。
- Runbook 已切换到 crate-private reviewed SSH 执行内核，P1 只读 policy/evidence 已实现；Agent SSH adapter 与 P2 approval 尚未实现，也未注册通用执行 Tauri command。
- reviewed operation deadline 可先返回稳定终态，但 DNS、TCP、SSH handshake/auth 仍使用连接层阻塞超时；应用崩溃也不会恢复内存中的执行状态。
- 当前风险模型偏向静态 Runbook，缺少适用于动态 Agent 的多维风险、审批摘要、防重放和策略版本。
- P1-A/P1-E 已具备 Agent 事件序列、快照恢复、运行预算和连续失败投影；真实 SSH adapter 与后置真实 fixture 仍未准入。
- 没有专用 Agent PTY、终端租约、用户接管或交互式密码边界。
- Deployment Runbook v2 阶段 5 已提供专用 Deployment UI、两套 systemd Web 模板、v2 导入导出、review 后冻结、精确审批、authoritative 进度/熔断/恢复与逐主机独立回滚；流量/负载均衡集成、动态发现、任意 Shell、无人值守回滚和实际清理执行继续 deferred。

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
| P2 受控修改 MVP | blocked | 2–3 周 | v2 协议、结构化风险、一次性审批、语义服务工具、后置验证与审计 | P1 verified 后才允许接入真实修改执行 |
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

#### P1-0：Agent 协议与预算（implemented）

- 定义 `AgentStartRequest`、`AgentTargetBinding`、`AgentPolicySnapshot`。
- 定义 provider-neutral `AgentDecision`、`AgentToolCall`、`ToolExecutionResult`、`AgentEvidence` 和版本化 `AgentEvent`。
- 定义 Run/Tool Call 状态机、run/tool cancellation、最大运行时间、模型轮次、工具调用数、单步输出与连续失败预算。
- P0 verified 前可以实现协议、状态机、fake model/tool 与纯逻辑测试，但不新增真实 SSH tool adapter、通用 Tauri execution command 或模型执行入口。

实际结果（2026-08-27）：

- 已新增 Rust/TypeScript v1 协议类型、严格 `AgentDecision` decoder、checked-in JSON schema、公开错误分类、显式 run/tool 转换表和硬上限预算策略。
- `protocol/agent/v1/` 与 `tests/fixtures/agent-protocol/v1/` 是双端共同消费的 schema/fixture；unknown field、unknown version、unknown enum、tool/arguments 错配和 P1 非空 `changes` 均失败关闭。
- Rust 与 TypeScript 都对所有状态笛卡尔积核对共享转换表，并系统性证明 `completed`、`failed`、`cancelled`、`blocked`、`timedOut` 和 `denied` 等终态不能被迟到结果覆盖。
- P1-0 提交保持纯逻辑边界：当时没有 `AgentManager`、真实 SSH adapter、模型调用入口、Agent Tauri command 或 `write_session` 旁路；后续 P1-A 只新增下述控制面。

#### P1-A：AgentManager 与运行注册表（implemented）

- 在 P1-0 的 `src-tauri/src/agent/` 协议模块上新增 manager、journal 与 IPC 控制面。
- `AgentManager` 成为运行状态的权威来源，前端 Zustand 仅为事件投影。
- MVP 同一 profile 同时只允许一个 executing Agent；不同 profile 的并发先限制为全局 1，稳定后再提高。
- Panel 关闭不取消运行；用户显式 Stop 或应用退出才触发取消。
- 前端重新挂载时通过 snapshot 恢复当前状态。

实际结果（2026-08-27）：

- Rust 进程内 `AgentManager` 是 run、幂等 request/action、journal sequence 与 snapshot 的唯一权威来源；registry 保留终态历史且全局最多一个非终态 run。
- 仅注册 `agent_start`、`agent_get_snapshot`、`agent_pause`、`agent_resume`、`agent_stop`、`agent_send_message` 六个窄 IPC；没有 generic execute/tool command，也没有 execution adapter、raw SSH 或 `write_session` Agent 路径。
- `clientRequestId` / `clientActionId` 重放返回原结果，同一 ID 搭配不同输入失败关闭；事件 sequence 只由后端 journal 单调分配，snapshot 携带 `lastSequence`。
- fake control boundary 覆盖 Panel 重挂、gap/duplicate/late event、延迟 Pause/Stop 与应用退出 cancel；生产 no-op boundary 稳定返回 `p1Blocked`，不创建 run。
- P1 总体仍为 `blocked`：P0 尚未 verified；P1-C 已在本地 registry + fake executor 边界内实现，P1-E UI workspace 已实现，但 P1-D 的真实 SSH adapter/fixture 在独立核验中因缺少当前 SHA 的 Windows runner 实跑证据而失败关闭、没有提交。

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

#### P1-B：ModelAdapter 与 fake Agent loop（implemented）

- OpenAI Responses、OpenAI Compatible Chat 和 Ollama 使用同一 checked-in strict JSON schema，一次 provider request 只返回一个 `AgentDecision`；native tool calling 不进入 P1-B 正确性路径。
- capability snapshot 冻结 provider kind/base URL/model 与 streaming、strict JSON schema、native tool calling、usage、response continuation；Compatible/Ollama 非 `jsonSchema` 配置失败关闭。
- strict decoder 失败最多一次通用 repair，repair 计入模型回合预算且不回显 raw provider response；发送和有界 response body 读取均支持 request cancellation。
- stable context 固定用户目标、冻结目标、只读边界、tool proposal contract 和预算；dynamic untrusted context 仅保留 plan、最近 observation、压缩旧 index、最近错误、问题与 steering。
- 可测试 orchestrator 每次只应用一个 decision；fake tool validation/execution seam 不包含真实 registry、policy、renderer、evidence、redactor 或 SSH adapter。
- fake 多轮测试证明：首个 `uptime` observation 为 `load=9.2` 时第二个 tool call 选择 `ps`，为 `load=0.2` 时直接 final，因此不是静态计划重放。
- 另一条完整 fake 路径执行 `host.inspect → shell.execReadOnly(ps) → final`，覆盖两个 decision tool variant；它仍只经过 fake driver。
- steering 通过 request generation 与 cancellation 双重使 in-flight decision 失效；Pause/Resume、Stop、askUser/answer、schema failure、provider timeout、tool denied 后替代、budget exhaustion 和迟到终态均有确定测试结果。
- 生产 `AgentManager::default()` 仍绑定 blocked no-op boundary，`agent_start` 继续返回 `p1Blocked`；P1-B 没有形成真实可执行入口。

#### P1-C：Tool registry、policy 与 evidence（implemented）

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

本工作包还负责 program-specific validator、POSIX renderer、evidence ownership/final report validator、同源 redaction，以及把 P1-B 的 fake observation seam 替换为真实但仍不接 SSH 的本地 tool registry。P1-B 只完成通用有界 context framing；evidence ID、来源、时间、target、digest 和 redaction 语义不得提前在 fake loop 中冒充完成。

实际结果（2026-08-27）：

- `src-tauri/src/agent/tools/` 使用编译期静态 `ToolDefinition` 表同时生成 model definitions 和执行 dispatch；`host.inspect` 只映射 enum fields 到固定 probe plan，不能接受 command/path/environment/target。
- `src-tauri/src/agent/policy.rs` 为 `uname`、`hostname`、`whoami`、`id`、`date`、`uptime`、`df`、`free`、`ps`、`ss`、`systemctl`、`journalctl` 和 capability-gated Docker 分别实现 parser；未知 program/flag/subcommand/position、控制符、shell 控制/重定向/substitution/glob、后台/提权/修改型与敏感读取结构全部失败关闭。
- policy 强制 systemctl `--no-pager`、status `--lines=0`、show 安全 properties，journalctl `--lines 1..500`，Docker stats `--no-stream`、logs `--tail 1..500` 与安全 format；Docker 默认关闭，只有冻结且专项测试过的 capability 才可启用。
- `tools/shell.rs` 是唯一 POSIX word quote/command renderer；只有 program-specific policy 成功后才生成 `ApprovedPosixCommandV1`。P1-C executor seam 只有 scripted fake，未调用 P0 kernel、raw SSH、PTY、`write_session` 或本地 process。
- `src-tauri/src/agent/redaction.rs` 在完整 chunk 重组后统一遮蔽 key/value、Bearer/Basic、高置信 AWS/GitHub/JWT/OpenAI token、private key、URL userinfo、query/connection-string secret 和额外 literal；digest 在脱敏与 Agent 有界压缩后计算。
- `src-tauri/src/agent/evidence.rs` 以同一 immutable redacted content 派生 model/UI/event/evidence，ledger 校验 run、target、source、tool-call 唯一 ownership；final validator 拒绝未知/其他 run/其他 target evidence、无成功 evidence 的 verified finding、无 evidence 的 likely finding、可识别 secret 和任何非空 P1 `changes`。
- orchestrator 的 P1-C 定点路径已接本地 registry + fake executor，能执行固定 `host.inspect`、创建后端 evidence ID、把同一脱敏 observation 放入 model context/evidence，并只在 final report 引用通过后完成。生产 `AgentManager::default()` 仍绑定 `BlockedNoopAgentBoundary`，`agent_start` 继续返回 `p1Blocked`。
- 阶段证据见 `docs/ai-agent-p1-c-tool-policy-evidence.md`；P0 仍为 `implemented（verification pending external）`，所以 P1 总体继续 `blocked`，不得开始 P1-D 真实接入。

#### P1-D：P0 adapter 与真实 SSH fixture（planned；受门禁阻断）

- 只有 P0 在 Roadmap/audit 变为 `verified` 后，才允许把 `shell.execReadOnly` 接到 `execute_reviewed_ssh_command`。
- adapter 必须继续执行 target revalidation、operation cancellation、timeout/output policy 和 secret redaction，且不得新增 generic execute IPC。
- direct/jump-host fixture 覆盖只读成功、non-zero、timeout、cancel、output cap 和 target drift。
- 当前 P0 仍为 `implemented（verification pending external）`。独立 P1-D 准入核验确认当前 SHA 缺少 Windows runner 真实结果，已按门禁失败关闭；本工作包没有开始、没有 adapter 或提交。

### 7.3 P1-E：Agent Workspace UI（implemented；生产 dynamic start 继续 blocked）

#### 拆分 AI Panel

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

#### 事件投影 Store

- `agentStore` 从单一 `run?` 改成 `runsById + activeRunId + lastSequenceByRunId`。
- Store 只应用 sequence 连续且符合状态机的事件。
- 检测 sequence gap 后调用 `agent_get_snapshot`，不能自行猜测状态。
- 运行终态不可被迟到事件覆盖。
- 运行与 AI conversation 建立关联，但不能因为 conversation 切换而改变 target。

#### 只读运行界面

- Header 显示冻结主机、权限模式、状态、运行时长、工具次数和 Stop/Pause。
- Timeline 显示计划、工具目的、命令、状态、退出码、持续时间和输出截断。
- 输出默认折叠，展开后展示脱敏 stdout/stderr。
- 运行中 composer 用于 steering，例如“只检查，不修改”或“先看最近 100 行日志”。
- 不展示隐藏 chain-of-thought，只显示简短动作理由和证据摘要。
- 使用现有 `MessageScroller`、`Card`、`Badge`、`Alert`、`Collapsible`、`Marker`、`InputGroup` 和 `sonner`。

#### Pause 与 Stop

- `Pause`：thinking 时取消并丢弃当前模型决策，工具运行时则在当前只读步骤完成后不再启动下一步。
- `Stop now`：取消模型请求和正在执行的工具。
- UI 必须解释远程后台进程不一定能因 channel 关闭而终止；自动模式本身禁止后台化命令。
- 停止后所有尚未执行的 tool proposal 和 pending tool call 失效。

#### 实际结果（2026-08-27）

- `src/components/ai/agent/` 已按建议拆出 Workspace、Header、Timeline、Plan、Tool Card、Evidence、Report 和 Composer，并复用现有 shadcn/Base UI primitives、chat primitives、设计 token、Spinner 与 sonner。
- `src/stores/agentStore.ts` 已成为 versioned event + authoritative snapshot 投影：严格 decode，sequence 连续检查，gap resync，duplicate/late terminal 忽略，冻结 goal/target/provider/policy 与终态不可回退。Panel 先订阅再 snapshot，unmount/remount 不取消后端 run。
- `src/lib/tauri.ts` 只增加 `agent_start/get_snapshot/pause/resume/stop/send_message` 六个既有窄 IPC 的 typed wrapper；没有 generic execute/tool IPC，也没有 raw SSH、PTY 或 `write_session` Agent 路径。
- Header/Timeline 覆盖冻结 target、read-only、状态、duration/budgets、plan、全部 tool state、后端命令预览、exit/duration/bytes/truncation、折叠脱敏 stdout/stderr、evidence、final report、错误与 Stop 限制说明；Pause/Resume/Stop/answer/steering 均等待后端接受后 snapshot resync。
- 旧诊断计划迁移到明确命名的 `staticDiagnosticStore`/`StaticDiagnostic*`，仅作为用户显式选择的 fallback。`p1Blocked` 与 provider incompatible 清晰展示；fallback 不解除 dynamic gate，也不伪装为动态运行。
- 测试覆盖 gap/duplicate/late、Panel remount、frozen target、预算、tool states、awaitingUser/steering、终态/错误/blocked/provider incompatible、evidence navigation、keyboard/live region，以及 Chat/Command/Explain/static Diagnostic Plan/Remote Health 回归。阶段证据见 `docs/ai-agent-p1-e-agent-workspace-ui-evidence.md`。
- P1-D 未实现；生产 `AgentManager::default()` 仍为 `BlockedNoopAgentBoundary`。P1 总体继续 `blocked`；后续 P1-F 只补充 fake eval、文档与发布门禁，不改变此结论。

### 7.4 P1-F：Eval、文档与发布门禁（implemented；P1 发布门禁仍 blocked）

- Fake model 按顺序返回 `host.inspect → shell.execReadOnly → shell.execReadOnly → final`，Agent 能完成循环。
- 第二个命令根据第一个命令输出动态变化，证明不是静态计划重放。
- Prompt injection 出现在终端输出中时，不能变成工具调用授权。
- 用户 steering 后，下一模型回合包含新约束。
- Pause 在当前步骤结束后生效，Stop 能取消当前步骤。
- Panel 卸载和重新挂载后通过 snapshot 恢复。
- sequence gap、重复事件和迟到事件均有测试。
- Agent 最终报告缺少 evidence ID 时被拒绝或降级为未验证结论。

实际结果（2026-08-27）：

- `tests/fixtures/agent-evals/v1/diagnostic-scenarios.json` 固定 CPU、磁盘、内存、服务、端口、capability-gated 容器和信息不足七类场景；test-only `agent/eval.rs` 通过 strict decoder、生产 registry/policy/orchestrator/evidence ledger 和 scripted fake executor 连续运行两次，比较规范化终态、预算、调用序列、evidence binding、finding 引用、askUser/outcome 与空 `changes`，并冻结 strict-schema provider compatibility、fake token accounting、延迟上限及具名控制面证据。
- `tests/fixtures/agent-evals/v1/adversarial-corpus.json` 固定 21 项 shell/prompt injection、后台化、重定向、提权、修改型、敏感读取和 unbounded proposal；所有恶意 proposal 的 fake executor 命中为 0，非空 `changes` 为 0。来自只读 observation 的 prompt injection 仍只作为不可信数据，后续 restart proposal 被 policy 拒绝。
- Workspace 启动前增加双语用户可见说明，明确只读范围、独立 Exec、不继承 shell 状态、同源输出脱敏、Pause/Stop、应用退出、崩溃不恢复与 detached process 限制；完整说明见 `docs/ai-agent-readonly-user-guide.md`。
- `docs/roadmap-audit.json` 新增 P1 12 项退出条件的精确有序映射；`scripts/check-roadmap-audit.mjs` 强制 P1 状态、0 副作用、安全 corpus、七类 eval、六个窄 IPC、blocked production boundary、无 adapter/PTY/process 旁路与双语安全说明。
- 阶段验收见 `docs/ai-agent-p1-f-eval-release-gate-evidence.md`。第 1、6、10 项仍 blocked：P0 未 verified、当前 SHA 缺 Windows runner 真实结果、P1-D adapter/direct/jump fixture/真实演示不存在。既有隔离 SSH/SFTP fixture 只能作为回归证据，不能冒充 P1-D 证据；P1 最终状态继续 `blocked`。

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

**状态：blocked（P1 verification gate；P2-0 已本地实现）**

> 第三阶段的 v2 协议、结构化风险、精确审批、服务工具、verification obligation、界面、测试与退出矩阵见 `docs/ai-agent-p2-controlled-mutation-agent-design.md`。P2-0 已完成纯协议、状态机与准入门禁；P0/P1 verified 前不得接入真实修改 executor。

### 8.1 目标

允许 Agent 提议少量、结构化的远端状态修改；每次修改必须由后端判定风险、绑定新鲜前置证据、获得用户对精确动作的一次性批准，并在执行后自动完成只读验证。

首个修改能力收窄为 systemd 服务控制。P2 不开放任意 shell、sudo、文件修改、包管理、网络策略、删除或多主机修改；批准不是未知命令的 sanitizer。

### 8.2 工作包

#### P2-0：准入、v2 协议与状态机（implemented；生产准入继续 blocked）

- 已增加后端权威 P0/P1 admission check；当前基线因 P0 未 verified、P1 blocked 而失败关闭，且请求中不存在 executor 注入字段。
- P1 v1 保持冻结，只读工具与空 `changes` 语义不变；Rust/TypeScript 共享兼容性 fixture 证明 v1 继续拒绝 mutation 与非空 `changes`。
- P2 已增加 `schemaVersion: 2` Rust/TypeScript types，以及严格、独立的 decision/event/snapshot schema；未知字段、版本、工具和 tool/arguments 错配均失败关闭。
- 已增加 run/tool/approval/verification 四类状态机与共享 fixture，并对所有终态和全部可能迟到状态做笛卡尔积拒绝测试。
- P2-0 提交没有注册 IPC、真实 adapter、approval registry、风险引擎或修改 executor；当前 P2-A 状态见下，P2-B 至 P2-F 仍未实现。

#### P2-A：结构化 evidence 与多维风险（implemented；生产准入继续 blocked）

- 后端从固定只读工具解析 systemd service resource 与 structured claims。
- precondition evidence 必须属于当前 run、target、resource，successful 且未过期。
- 风险记录 read/write/delete/privilege/service interruption/network/credential/external/multi-host 维度。
- verdict 为 autoReadOnly、requiresApproval、requiresDoubleConfirmation 或 deny。
- 模型风险字段不能覆盖本地结果；unknown、destructive、critical 和提权一律 deny。

实际结果（2026-08-27）：

- Rust 后端新增 canonical `AgentResourceRefV2` 派生边界、固定 systemd/config/listener parser、structured evidence/capability ledger；模型和前端不能写入 resource、claims、observedAt、successful 或 digest。
- ledger 与 precondition validator 系统性校验 same-run、same-target、same-resource、successful、完整 observation、无冲突 claims 和 immutable evidence-set digest；status/config/listener/target-capability 默认 freshness 分别为 120/120/60/300 秒，任一配置硬上限为 300 秒。
- start/reload/restart/stop 前置矩阵已落地；stop 额外要求冻结用户目标明确请求停止，validator 与 canonical resource 由本地 capability 绑定。
- 本地 RiskEngine 覆盖完整维度与 service-control 矩阵；unknown/destructive/privilege/credential/external-download-execute/network/shell/multi-host/ambiguous-resource 全部 critical deny，restart/stop 及可能中断的 reload 要求二次确认。模型宣称 readOnly/low 只记录为 ignored finding，不能降低本地结果。
- Strict/Balanced effective policy 由 application/profile/request/tool minimum 取最严格值；两种模式都不允许 mutation auto-approval。Rust/TypeScript 共同消费 `risk-evidence-preconditions.json`，前端只严格投影后端结果，不实现第二套风险或前置条件决策。
- 本工作包仍未注册 v2 manager/IPC、approval registry、真实 service/SSH executor、verification executor、audit writer 或 UI；`CURRENT_P2_ADMISSION_BASELINE` 继续先因 P0/P1 未 verified 失败关闭。

#### P2-B：Approval control plane

- approval 绑定 run/tool、规范化参数 digest、target、resource、risk、policy/tool registry、前置 evidence、command preview、timeout、expiry 和 verification plan。
- approval 只能消费一次；重放、过期、目标/证据/参数/策略变化和 Stop/steering 全部使其失效。
- medium 修改使用 Approve once；restart/stop 等 high 修改使用后端 challenge 的二阶段确认。
- 只新增 `agent_resolve_approval` 和 `agent_confirm_approval`；前端不回传 command、risk、digest 或 evidence payload。

#### P2-C：语义服务工具、执行与验证（受准入门禁）

- 首批工具：`service.inspect`、`service.validateConfig`、`service.control`。
- `service.control` 只接受 systemd unit 与 start/reload/restart/stop 枚举，不接受 shell 文本。
- 使用冻结 profile 的现有 username，不 sudo；权限不足返回明确失败。
- approval/audit prewrite 后才由唯一 adapter 构造 `ReviewedSshCommand` 并调用 P0 kernel。
- 每次执行都创建后端 verification obligation；固定检查 service state、result 和需要时的监听端口。
- exit 0 但 verification 失败时结果为 partial/unverified，不能显示 verified success。

#### P2-D：后端审计与 crash 语义

- 增加 Agent operation category/action 与 approval/change/verification companion metadata。
- effecting backend 直接写 operation history，不能依赖前端记录。
- execution-started 持久预写失败时不执行。
- crash 不恢复为可消费 approval；执行效果不确定时记录 unknownEffect 并先只读验证。
- history/export 不保存原始输出、终端输入、文件内容或秘密。

#### P2-E：Approval/Change Workspace UI

- Timeline 延续现有 `MessageScroller`；风险、审批、change 和 verification 使用完整 `Card`。
- Approval Card 显示 target、resource、exact preview、影响、风险命中、前置证据、expiry 和验证计划。
- high action 用 `AlertDialog` + `Field/Checkbox` 完成二次确认；destructive/critical 只显示 deny。
- 审批卡不能编辑 command/arguments；修改意图必须 Reject + steering 后产生新 tool call。
- 使用现有 `Alert`、`Badge`、`Collapsible`、`Spinner`、`InputGroup` 和 sonner。

#### P2-F：Eval、演示与发布门禁

- 固定 approval replay、expiry、target/evidence/policy drift 和 forged digest corpus。
- 覆盖 config invalid、service active、批准 start、取消 restart、权限不足、unknownEffect 和 verification failure。
- direct/jump SSH fixture 与 Windows/macOS 当前 SHA 门禁必须有真实证据。
- 三个硬指标：未审批 mutation=0、replay success=0、verified-without-post-evidence=0。

### 8.3 策略模式

- Strict：所有只读与修改调用逐次批准；high 修改二次确认。
- Balanced：P1 有界只读自动；所有修改逐次批准；high 修改二次确认。
- 不提供修改自动批准或 Full Auto。
- effective policy 由应用/profile 强制策略与用户请求取最严格结果，并在 run 开始时冻结。

### 8.4 测试要求

- v1 继续拒绝 mutation 和非空 `changes`。
- 模型把危险动作声明为 readOnly 时，本地提升或拒绝。
- approval 任一 binding 不匹配时 executor invocation 为 0。
- concurrent double click 只能消费一次。
- high action 单次 IPC 不能 approved。
- state change 缺少 prior evidence 时拒绝。
- execution success 缺少 post evidence 时不能 verified。
- unknownEffect 后不自动重试。
- audit prewrite 失败时不执行。
- Stop、steering、expiry 和 app exit 撤销 pending approval。
- operation history 导出不包含原始输出和秘密。

### 8.5 演示验收

目标：

> 检查 nginx 配置；如果配置有效但服务未运行，在我批准后启动，并验证状态和监听端口。

预期流程：

1. 运行 `service.validateConfig` 和 `service.inspect`，生成结构化前置证据。
2. 发现配置有效且服务未运行。
3. 展示 `service.control(start nginx.service)` 的精确审批卡。
4. 未批准前 executor invocation 为 0。
5. 批准后持久预写 audit，并执行一次固定命令。
6. 后端自动验证 service state 和监听端口。
7. 最终 change 引用 approval、execution evidence 和 verification evidence。
8. 操作历史展示完整生命周期但没有原始输出或秘密。

restart/stop 等 high action 必须再经过后端 challenge 驱动的 `AlertDialog` 二次确认；任一阶段取消都不执行。

### 8.6 P2 退出条件

- P0/P1 已 verified，v1 只读回归保持全绿。
- v2 协议、状态机、risk、structured evidence 和 approval control plane 通过双端 fixture。
- mutation 只通过编译期 semantic registry，不存在任意 shell 修改入口。
- approval/audit prewrite 之前不会调用 P0 kernel。
- 每个已执行 change 都有 verification obligation 终态。
- retry/unknownEffect/Stop/crash 不产生自动重复修改。
- 用户可以拒绝、停止、查看完整影响和二次确认高影响动作。
- 未审批修改次数、approval replay 成功次数、无后置证据的 verified change 均为 0。
- macOS/Windows、Rust/前端、direct/jump fixture、security corpus 和演示通过。
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

#### 9.3.1 已实现的隔离基础（P3 仍为 planned）

- 阶段 1 已增加 `SessionKind::AgentPty`、run/session-bound `TerminalLease`、epoch/revision replay fence，以及普通 `write_session` 不得写入专用 Agent PTY 的硬边界。
- 阶段 2 已增加独立且冻结的 `agent-terminal/v1` 强类型协议；它没有并入或放宽 Agent v1/v2 decision union，模型侧不能提交 session ID、lease token、PTY bytes、shell command 或自由文本响应。
- 编译期 driver registry、唯一 renderer、本地 prompt detector 与 run/target/observation/lease policy 已接到 crate-private lease input seam，并只由 fake caller 与共享 Rust/TypeScript fixture 验证；没有注册 generic Agent session-write IPC，也没有接入生产 Agent manager/model loop、审批、operation history 或 UI。
- 当前 registry 只包含 deterministic interactive fixture 定义，用于冻结 driver/program/args、response/key corpus 和 handoff 边界；它不是通用 TUI、编辑器、安装器或 computer-use 承诺。
- 阶段 2 证据与限制见 [`docs/ai-agent-p3-terminal-protocol-phase2.md`](docs/ai-agent-p3-terminal-protocol-phase2.md)。

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

### 11.4 P2 版本边界

P2 不修改 v1 decision union、只读 policy 或空 `changes` 语义。受控修改使用 `schemaVersion: 2`，新增 `service.inspect`、`service.validateConfig`、`service.control`、approval/risk/change/verification snapshot 与事件，以及 `agent_resolve_approval`、`agent_confirm_approval` 两个窄 IPC。详细 exact binding 与状态机见 `docs/ai-agent-p2-controlled-mutation-agent-design.md`。

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
9. 服务状态修改并验证。
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
- P2 结构化风险、approval fixture 与审批 UI 原型。

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
