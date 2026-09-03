# 阶段 6B：Skills 接续设计（尚未实现）

> 2026-09-04 用户要求停止开发并换设备接续。本文件保存已完成的只读设计，不代表功能或验收已完成。请先阅读 [交接说明](ai-runtime-handoff.md)。Harness 链接表示参考仓库中的路径，需另行检出该仓库；不要求沿用旧设备绝对路径。

只读设计准备已完成。阶段 6B 应交付“真实目录发现 → 当前策略校验 → 完整内容持久化 → 模型请求与用户入口”的闭环；现有枚举和卡片只能作为接入基础。正式实现仍需等待阶段 6A 最终冻结来源及迁移清单。

**引用基线与核对结果**

- 阶段 5：`135f/ShellSpan`，当时 HEAD 为 `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`，其 53 个未提交累计文件已逐项核对 SHA-256，后来整合为 `3e40eef`。可迁移清单已保存于 [交接清单](ai-runtime-handoff-inventory.json)。以下 ShellSpan 证据指该累计基线。
- Harness：`D:/Developer/deepseek-harness`，HEAD 为 `49a606bc5b5934603f22a26957a07dc799ab0291`，核对时工作区无修改。
- 阶段 6A：仅观察 ac59 在 **2026-09-04 07:20–07:22，UTC+8** 的接口。`user_questions.rs` 在读取期间改变，不能称为冻结快照。观察到的 `tool_pipeline.rs` SHA-256 为 `4D35A1B8875F3733CBD9B05B10E04163C935E18E5F0B0CC983B0CB361B867EF5`；其问答分支仅用于确定集成位置。
- 已读取适用 AGENTS 指令、Harness Skills 的 README/src/tests、Skills 子系统说明及相关防御规则；前端设计已读取 shadcn 技能和现有组件。未运行 CLI、安装、测试、live 请求，未创建或修改文件。

**当前缺口有明确代码证据**

| 位置 | 已有能力与缺口 |
|---|---|
| [event.rs:43](../src-tauri/src/agent_runtime/event.rs) | 已有 `SkillCatalog`、`SkillInvocation` source kind；生产代码搜索未发现目录发现、skill loader 或 slash producer。fixture 中的示例不是生产能力。 |
| [driver.rs:795](../src-tauri/src/agent_runtime/driver.rs) | `ensure_model_context` 按现有 `producer_id` 去重，不能承担目录版本比较、完整 replacement 或空目录退休。 |
| [driver.rs:313](../src-tauri/src/agent_runtime/driver.rs) | pre-step hook 发生在 claim 之前；hook context 没有已 claim 消息，且是同步接口。直接加 slash 会混入 queued 输入。 |
| [session.rs:801](../src-tauri/src/agent_runtime/session.rs) | 三个 `begin_*` 方法持久化 claim、StepStart 和 UserMessage；`AgentClaimedStep` 当前是空标记，未提供可恢复的 claim 明细接口。 |
| [tool_pipeline.rs:1337](../src-tauri/src/agent_runtime/tool_pipeline.rs) | 普通 native 结果超过 8 KiB 会转换为 artifact 摘要；完整 skill 正文不能无条件沿用。 |
| [surface.rs:194](../src-tauri/src/agent_runtime/surface.rs) | 普通工具结果编码为 JSON；需要显式支持 skill 的规范正文呈现，才能与 slash 注入一致。 |
| [native/filesystem.rs:720](../src-tauri/src/agent_runtime/native/filesystem.rs) | 已有 local frozen cwd、remote frozen root、SFTP、路径约束和有界读取；接口私有且错误多为字符串，目录枚举本身缺少 Skills 所需的整体数量/时间限制。 |
| [ai-conversation-node-seat.tsx:132](../src/components/ai/workspace/ai-conversation-node-seat.tsx) | 已能显示通用上下文来源；尚无 user-invocable 列表、真实选择入口及结构化 Skills 状态。 |

Harness 可直接借鉴的行为是：调用中立目录、独立可见性标志、完整 replacement、incomplete 不替换、执行入口重查策略，以及只扫描已 claim 的直接用户文本。见固定提交的 [tool-skill 实现](https://github.com/deepseek-ai/deepseek-harness/blob/49a606bc5b5934603f22a26957a07dc799ab0291/packages/skill/tool-skill/src/index.ts)、[registry 实现](https://github.com/deepseek-ai/deepseek-harness/blob/49a606bc5b5934603f22a26957a07dc799ab0291/packages/skill/skill/src/index.ts) 和 [filesystem 实现](https://github.com/deepseek-ai/deepseek-harness/blob/49a606bc5b5934603f22a26957a07dc799ab0291/packages/skill/skill-filesystem/src/index.ts)。

需要明确保留的差异：Harness 默认还扫描 home/custom 根、支持跟随 symlink、接受额外布尔拼写，正文没有大小上限或版本协议。这些不能直接迁入本阶段。

**目录、加载和刷新协议**

建议新增 `agent_runtime/skills.rs`，集中承载 Skills 类型、严格解析、排序去重、规范渲染及版本计算；新增 `skill_runtime.rs` 承载异步发现、当前策略验证和 step 输入准备。能力接口只提供现有消费者实际需要的两项操作：

- `observe(scope, limits, cancellation)`：返回完整目录观察或明确 incomplete/unavailable 状态。
- `load_current(scope, exact_name, invocation_kind, limits, cancellation)`：重新确认当前获胜定义及策略，返回完整、不可变的载入结果。

生产消费者必须同时包括 driver、`skill` 工具和用户列表 IPC；不能只做测试实现或注册空 slot。

作用域由 Rust 从 Session 冻结 target 和 capability scope 推导，不能由模型或 renderer 提交任意根路径。首版只发现：

```text
<frozen-root>/.agents/skills/<entry>/SKILL.md
<frozen-root>/.agents/skills/<entry>.md
```

不递归扫描更深层，不向 `.git` 祖先扩张，不扫描 home、插件目录或市场。名称以 frontmatter 为准，并校验 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。

本地必须使用 frozen cwd；远端必须使用 frozen rootPath 和现有 DB/credentials/known_hosts 链路。远端 `local_root` 是传输用途，不能作为 Skills 根。没有目标、没有根或目标类型不支持时，返回明确的 unavailable 状态，禁止回退进程 cwd。

将文件系统的受限读取能力抽为内部可复用接口，由 native 文件工具和 Skills provider 共用。需返回结构化的 absent、denied、I/O failure、scope drift、cancelled、limit exceeded，不能通过匹配错误文本判断“目录为空”。继续执行 canonical containment、逐级 no-symlink/reparse 检查和远端 profile 身份校验；补上 root 身份变化检查。现有路径预检不等同于消除了打开文件时的竞态，读取句柄与读取前后身份检查也必须覆盖。

解析规则建议如下：

- 使用项目已有 `serde_yaml`，不引入手写 YAML 解析器；严格验证映射、重复键、字段类型、单文档和 frontmatter 分隔符。
- `name`、`description` 必须为非空字符串；正文完整保留，不使用 `trim()` 改写指令。
- 两个可见性字段仅接受真正 YAML boolean；缺省均允许。`"false"`、`yes/no`、`on/off`、`0/1`、null 等不能静默落回默认，报告字段错误并拒绝该定义。这是相对 Harness 的明确收紧。
- legacy invocation 字段如 `userInvocable`、`disableModelInvocation` 拒绝并指出规范字段名。
- 普通未知元数据保留为有界、无执行能力的扩展，并给出诊断；`allowed-tools` 等绝不转化为授权。不能一概拒绝所有未知字段，否则项目现有 shadcn 技能本身就无法发现。

重复名称先确定获胜定义，再过滤 model/user 可见性。首版单根内按规范化相对路径的稳定字节顺序 first-wins，记录 winner、shadowed 路径及原因；不能依赖目录返回顺序或 locale。获胜定义禁用某入口时，不回退到同名低优先级定义绕过禁用。

每个**新模型 step**都进行有界目录重观察；首版不依赖 watcher 或进程级 once cache。这样外部编辑、`apply_patch`、传输、shell 写入均在下一 step 被重新发现。工具执行入口仍独立重查，避免目录与执行之间的策略变化。以后可用 watcher 优化，但不能改变该正确性保证。

观察结果区分：

| 状态 | 对当前目录的处理 |
|---|---|
| complete，非空 | 原子替换完整获胜列表 |
| complete，确认为空或 Skills 子目录不存在 | 替换为空；曾发布的模型目录必须追加退休消息 |
| malformed entry，但其余发现完成 | 记录诊断，移除失效定义；正常兄弟项仍可用 |
| 临时读取失败、枚举中途变化、超时、整体超限 | incomplete；保留同作用域 last-good，不能发表残缺 replacement |
| scope/root/profile drift 或授权撤销 | 当前作用域 unavailable/retired；last-good 仅作为历史，不能继续授权调用 |

目录包含全部获胜项及两套 policy；模型摘要另行过滤、排序、归一化和限长。摘要可以截短，**条目列表不能截成前 N 项后冒充完整目录**。整体超过上限应明确失败。

目录至少有两种版本：完整目录 `snapshotRevision`，以及模型实际发布条目的 `modelCatalogDigest`。正文变化更新内容版本，不必重复发送相同摘要；旧目录、旧调用正文和旧 hash 永不改写。工具隐藏或移出 capability scope 时，即使目录读取失败，也应根据已知的可见性撤销发表空退休目录。

**模型调用、slash 和持久化**

两套策略必须按以下四组合分别测试：

| modelInvocable | userInvocable | 模型目录及工具 | 用户列表及 slash |
|---|---|---|---|
| true | true | 可用 | 可用 |
| true | false | 可用 | 不可用 |
| false | true | 不可用 | 可用 |
| false | false | 不可用 | 不可用 |

模型工具采用严格参数 `skill({name})`，不接收文件路径或替代 target。执行时重新验证：该工具当前确实可用、Session 当前作用域有效、名称仍为当前获胜定义、最新 frontmatter 允许 model invocation。不能只隐藏 schema。

`skill` 在阶段 5 scheduler 中作为独占屏障：先等待已运行调用收束，再执行载入及提交结果，随后才接纳后续调用。它仍消耗原有工具预算，仍受取消、before/after/failure hook 和动态权限约束。不能提高全局 8 KiB 限额来迁就 Skills；应为已验证的完整 skill 结果设置专用有界路径。

slash 准备放在 `begin_*` 成功之后、首次 `RequestHeader` 之前：

1. 从本 step 的 durable claim 对应消息中取得直接用户输入；仅接受直接用户来源及 ingress 身份。
2. 按 `(^|\s)/exact-name(?=\s|$)` 扫描，按首次出现顺序去重。
3. queued 未 claim、runtime/plugin/form/session-reference、agent-generated、已注入内容全部排除。
4. 未知或 user-disabled 名称保留普通原文，不注入。已知技能的读取/限额失败必须成为明确结果，不能假装成功载入。
5. 用户原文保持原样；完整 skill instructions 放在背景上下文和目录之后。

需要修补 `AgentClaimedStep`：提供实际 claim 的消息身份，且恢复时可从日志重建，不能只依赖本次返回值。当前 claim 记录没有 step scope，且多行 append 可能留下完整行前缀；必须定义 claim→StepStart→UserMessage 的合法前缀恢复，不能让消息已出 Inbox 却无法继续准备。

建议用一个版本化的 **`SkillStepPrepared` 持久事实**记录：

- session/turn/step、实际 claim 的直接用户消息 IDs；
- 本次完整目录发布内容及 digest，或无需发布；
- 所有 slash 候选的确定结果；
- 成功载入的完整指令、规范渲染文本与 provenance。

由 `surface.rs` 将这个事实投影成带 `SkillCatalog` / `SkillInvocation` 来源的消息，避免再写一套重复正文事实。单个 step 的准备事实受整体事件上限约束，超限整体失败，不提交“前几个成功”的半批。`SkillCatalogObserved` 可单独保存调用中立目录及诊断，不直接进入模型输入。

模型工具的 durable `ToolResult` 保存相同 `LoadedSkill` 数据；`surface.rs` 从其已存规范正文产生工具消息。两条入口使用同一 renderer，正文形态一致：

```text
<skill_content name="...">
<skill_resources>目标作用域与相对资源基准</skill_resources>
<skill_provenance>来源、版本及内容标识</skill_provenance>
<skill_instructions>完整正文</skill_instructions>
</skill_content>
```

provenance 至少包含：协议/renderer 版本、provider/source identity、target kind/id、冻结根与根身份、技能相对路径、resource base、调用入口、catalog revision、file hash、instruction hash、rendered hash；用户调用还记录消息 IDs，模型调用记录 request/call ID。不要持久化凭据。

这里有两项必须处理的既有约束：

- [session.rs:3022](../src-tauri/src/agent_runtime/session.rs) 会脱敏事件。需在 Skills 提交前做同规则预检；若脱敏会改变完整正文或规范输出，明确拒绝完整载入，不能保存原文 hash 配被改写正文，也不能绕过脱敏。
- [session.rs:3060](../src-tauri/src/agent_runtime/session.rs) 的批量写入不是断电事务。准备事实已提交后，恢复只能重用已存内容；不得重读已改变的文件。读取完成但尚未落盘就崩溃，没有可重放内容，此时重新读取属于一次新的未完成准备，必须取得新版本。

首次请求、网络重试和恢复都要检查准备事实；同一 step 不重复注入，包括当时未知、后来才出现的名称。压缩后若当前目录不再位于可见 surface，重新发表完整当前目录；恢复已提交调用仍使用原正文。继承父任务上下文时，还需过滤不匹配子任务 target/root 的 Skills 目录和指令，不能凭父日志扩展子任务作用域。

所有新增模型输入落入 surface 后重新估算预算，并实际执行压缩/超限判断；仅记录 token 估值不足。压缩后再次计算。不可为了通过预算把完整技能截成摘要。

初始限额可集中定义为：最多 1,024 个候选目录项、256 个有效技能、单文件 128 KiB、单次发现累计读取 8 MiB、摘要 500 个 Unicode 标量、单次规范载入输出 96 KiB、每 step 最多 16 个唯一调用且全部新增输入不超过 128 KiB；每次观察/加载有明确 deadline。它们是待实现校准的起始值，最终仍受既有 128 KiB message、256 KiB event 和日志总量限制。远端连接、枚举和读取都要落实 deadline；单纯停止等待后台阻塞线程不算取消完成。

资源只提供基准，不自动递归读取。后续资源访问继续经过原 read/exec/网络工具的策略和授权；技能文字、frontmatter 和 slash 都不能改变 permission mode、capability scope 或 approval。

**前端与阶段 6A 接口衔接**

用户需要能在首次调用前发现 user-only 技能。新增只读、Session 地址化的 Skills 列表 IPC，服务端从 Session 推导冻结目标，返回 user-invocable 条目、revision、fresh/stale/unavailable 状态和有界诊断。新任务未有 Session 时，可复用 create-session 流程先建立冻结 Session，再查询目录，不启动模型。

composer 的 Skills 入口列出名称和摘要，标记 user-only；选择后只向草稿插入 `/name `，仍走现有 submit→Inbox 流程，不添加绕过 Inbox 的 invoke IPC。打开菜单重新查询，切换任务时清除旧查询结果；后台返回旧 Session 结果不能覆盖当前列表。stale 列表需明确显示，服务端执行校验始终为准。

复用已有 `DropdownMenu`、`InputGroup`、`Badge`、`Alert`、`Marker` 和 `Collapsible`；无需安装 Command/Popover 或重建聊天滚动体系。完整指令、来源、版本及错误从 typed facts 展示，两套 projection 都处理，同步中英文。未支持的旧 metadata 作为旧式上下文显示，不能推断为当前可调用目录。

具体切入文件如下，新增文件名为建议：

| 工作 | 切入点 |
|---|---|
| Skills 领域类型、解析、渲染、版本 | 新增 `agent_runtime/skills.rs` |
| 异步发现、载入与 step 准备 | 新增 `agent_runtime/skill_runtime.rs` |
| 有界目标文件能力及真实 local/remote provider | [native/filesystem.rs](../src-tauri/src/agent_runtime/native/filesystem.rs)、[native_adapter.rs](../src-tauri/src/agent_runtime/native_adapter.rs) |
| 生产装配、列表查询与生命周期 | [runtime.rs](../src-tauri/src/agent_runtime/runtime.rs)、[commands.rs](../src-tauri/src/agent_runtime/commands.rs)、[lib.rs](../src-tauri/src/lib.rs) |
| claim 后准备、重新预算、重试复用 | [driver.rs](../src-tauri/src/agent_runtime/driver.rs)、[compaction.rs](../src-tauri/src/agent_runtime/compaction.rs) |
| 独占 skill 调用与规范 schema | [tool_pipeline.rs](../src-tauri/src/agent_runtime/tool_pipeline.rs)、[model.rs](../src-tauri/src/agent_runtime/model.rs) |
| 持久验证、前缀恢复和模型投影 | [event.rs](../src-tauri/src/agent_runtime/event.rs)、[session.rs](../src-tauri/src/agent_runtime/session.rs)、[recovery.rs](../src-tauri/src/agent_runtime/recovery.rs)、[surface.rs](../src-tauri/src/agent_runtime/surface.rs) |
| IPC 类型及订阅、查询 | [tauri.ts](../src/lib/tauri.ts)、[agent-session.ts](../src/types/agent-session.ts)、[agent-session-adapter.ts](../src/lib/ai/agent-session-adapter.ts) |
| controller、composer、真实展示 | [use-ai-session-controller.ts](../src/components/ai/workspace/use-ai-session-controller.ts)、[ai-composer-seat.tsx](../src/components/ai/workspace/ai-composer-seat.tsx)、[ai-conversation-node-seat.tsx](../src/components/ai/workspace/ai-conversation-node-seat.tsx) |
| 两套 projection 和本地化 | [agent-session-projection.ts](../src/lib/agent-session-projection.ts)、[conversation-projection.ts](../src/lib/ai/conversation-projection.ts)、两个 locale 文件 |

ac59 当前预览新增了 `ask_user_question`、`QuestionRequested/Answered/Cancelled`、完整问答身份和 scheduler barrier 分支。正式串接时：

- 在最终 scheduler 中并列接入 Skills 屏障，保留问答 waiting/resume 和未执行调用处理。
- 问答答案即便包含 `/name`，仍是 Form/工具结果，不能伪装成直接用户输入。
- 问答恢复和模型重试复用同 step 的 Skills 准备事实；真正开始新 step 才重新发现。
- event 版本、recovery match、schema fixture、controller/adapter 字段以 6A 最终源合并，不能用 135f 整文件覆盖。
- 旧日志缺少 Skills 扩展应正常重启并按需初始化；未知未来协议明确拒绝，不能假定默认允许。顶层 event version 是否变化由 6A 最终格式决定，不单方面重置命名空间。

**可执行验收与阶段 6B 门禁**

| 验收组 | 必须观察到的结果 |
|---|---|
| 真实发现 | 临时 frozen root 中 bundle、flat 和项目 shadcn 格式均被发现；嵌套树不发现；重复顺序不受 OS 枚举顺序影响，诊断含胜负来源。 |
| YAML 与 policy | 四组合；缺省；引号布尔、yes/no、数值/null、legacy key、重复键、非法 YAML、未知字段、CRLF、多行摘要；歧义不能变为允许。 |
| Provider 请求闭环 | 经真实 Runtime 和本地 provider mock HTTP 接收器捕获请求：首请求含完整目录；`skill` 结果后的请求含完整正文和 provenance；不能只断言 Rust 内部对象。 |
| 用户端到端 | 实际 controller 提交 `/name`，观察 Inbox enqueued→claimed→durable invocation→provider 请求；列表选择和手工输入都覆盖。 |
| 刷新与退休 | 新增、改名、摘要变化、全部删除、目录消失后重建、body-only、工具可见性丢失；下一个新 step 出现正确 replacement，历史内容不变。 |
| incomplete | 列目录失败、单文件暂时失败、半次枚举、超时/超限均保留 last-good，不冒充空；恢复后发布完整新目录。 |
| 执行重校验 | 列表后撤销 model/user flag、删除、改名、重复赢家改变、scope 撤销；直接伪造模型调用也必须拒绝。 |
| slash 来源和去重 | 句中、首尾及 Unicode whitespace；路径、分数、标点粘连不匹配；同 step 多消息只注入一次；未 claim、Form、plugin/runtime、agent-generated/injected 均不触发。 |
| 限额 | UTF-8 多字节、limit−1/exact/+1、超大单块、wrapper 转义与 metadata 膨胀、多个技能累计、目录总量；所有超限明确失败，不截 head。 |
| 崩溃与重放 | claim 各前缀、读后未写、准备事实已写未请求、工具正文已写未继续、JSONL 尾部中断；重启无消息丢失、无重复注入，已落盘正文不因文件改变而重读。 |
| 压缩与继承 | 压缩后目录重新可见；调用历史 hash 保持；父子不同 target/root 不继承可用技能或资源权限。 |
| local/remote 安全 | 本地存在诱饵、远端不存在时不得回落本地；跨 target 同名不串库；路径穿越、绝对路径逃逸、symlink/junction、profile/root drift 均拒绝。远端生产 provider 用隔离 SFTP fixture 测，不能只用内存假 provider。 |
| 预算、取消和权限 | 载入后重新预算，超窗不发请求；取消贯穿连接/读取/提交；skill→敏感读/写仍触发原策略；阶段 5 admission、顺序提交、动态 barrier 和 child budget 回归通过。 |
| UI 与协议 | 两套 projection、IPC adapter、controller、composer、卡片、cold Session 列表、中英文及键盘操作；旧 metadata 不崩溃，不从模型正文反解析 provenance。 |

正式实现时新增聚合门禁 `test:ai:stage6b`，纳入对应 Rust parser/provider/runtime/recovery 测试、真实 provider mock 请求测试、前端 adapter/controller/projection 测试和隔离 SFTP 验证；同时运行阶段 5 scheduler 门禁及阶段 6A 最终指定的问答回归。新增跨语言 fixture 应来自真实运行日志，保留旧 v4 fixture 的重启覆盖。`pnpm build` 和相关 Rust 编译检查也应通过；不将旧的 UI `test:ai:phase6` 当作本阶段完整验收。

本阶段门禁不扩展到 home 扫描、插件市场、安装技能或任意资源自动加载，也不为已知 shadcn CLI SDK/zod 问题调整依赖。完成证据必须是上述生产路径真实输出，不能以新增事件、mock 卡片或未连接生产装配的接口代替。

本回合停止在设计报告；尚未实施或执行任何验收。
