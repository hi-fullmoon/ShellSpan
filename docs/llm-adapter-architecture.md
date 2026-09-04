# ShellSpan 多模型适配架构设计

状态：设计提案，未实施。2026-09-05 基于当前工作区源码，包括正在进行的会话模型切换和图片相关修改。本文不改变 `agent-runtime-vnext.md` 所描述的现有运行契约。

## 1. 决策

采用 deepseek-harness 的统一 LLM 服务、路由注册、模型能力解析、请求快照和适配器私有回放机制，在 ShellSpan 的 Rust Runtime 中实现。继续复用现有事件日志、工具调度、图片存储、重试和系统钥匙串。

第一阶段使用编译期注册的 Rust 协议适配器。先提取已有 Chat Completions、OpenAI Responses、Ollama 实现，再增加 Anthropic Messages。DeepSeek、Qwen、Kimi、GLM、MiniMax 等已有 Chat Completions 变体通过显式兼容配置复用同一协议实现；如果后续确实需要独立传输或专属文件接口，再注册专用适配器。

不在本次设计中引入 Cordis、Node sidecar、动态下载插件或第二个 Agent Runtime。pi-ai 具有可复用的厂商实现，但直接接入当前 Rust 请求链路需要额外进程、IPC、打包和取消传播；先把适配接口建立起来，将来有足够多新增协议需求时再评估单独的桥接适配器。

目标验收：新增一个已有协议的新模型只需增加目录或用户配置；新增一种协议只需实现并注册适配器，主 Loop、工具审批、重试调度和 Conversation 不增加厂商分支。

## 2. 现状与差距

| 当前位置 | 已有能力 | 需要改变的地方 |
| --- | --- | --- |
| `src-tauri/src/agent_runtime/model.rs` | `ModelAdapter`、`ModelRegistry`、统一请求、增量、响应和错误 | 近 4,000 行含测试；工厂总是构造 `HttpModelAdapter`，协议通过 `AiProviderKind` 分派，传输、序列化、解析和工具定义集中在一起 |
| `src-tauri/src/agent_runtime/provider.rs` | 共享 JSON 描述厂商兼容性、推理和容量 | 同一结构混合协议行为、厂商默认值、模型前缀规则；有运行时域名推断和硬编码例外 |
| `src/lib/provider-contract.ts` | 前端与 Rust 共享静态数据 | 前端仍独立解析能力；推理、容量、视觉信息需要跨多个来源组合 |
| `src-tauri/src/agent_runtime/images.rs` | 不可变图片引用、限额、取消、请求解析 | `vision_route()` 依赖协议、profile 和精确模型白名单，能力来源独立于普通模型目录 |
| `budget.rs` / `compaction.rs` | 请求预算与压缩预算 | 主预算读取 hint、视觉路由和 provider 容量；压缩直接读取 provider 容量，解析路径不同 |
| `src/types/ai.ts` / `aiSettingsStore.ts` | 多个提供方配置、全局默认、钥匙串引用 | 一条 `AiProviderProfile` 同时包含连接和一个模型；推理选项是固定联合类型 |
| `registry.rs` / `driver.rs` | 会话中可换模型；`run_step()` 固定 provider/adapter，重试沿用 | 将固定范围扩展到能力、兼容配置、凭据和预检，统一预检与正式调用使用的版本 |
| `ModelContentBlock::Reasoning.provider_item` | 保存部分原生推理数据 | 私有回放信息没有独立、统一的适配器来源和兼容性封装 |
| `request_log.rs` | 请求头、请求序列与每次尝试 | 现有 header 变化判断不覆盖完整端点、兼容配置和能力修订 |

已经存在的抽象应继续使用。此次重构的中心是让这些抽象各自承担清晰的职责，而不是重写事件、工具或会话系统。

## 3. 分层与目录

```text
React 设置页 / 模型选择器
    │ Tauri：保存路由、列出模型、解析能力、提交 ModelSelection
    ▼
Rust LlmRuntime
    ├── RouteStore：版本化连接配置、模型覆盖、认证引用
    ├── AdapterRegistry：adapterId → Arc<dyn LlmAdapter>
    ├── Catalog：内置厂商与模型数据、用户覆盖
    └── prepare_model → PreparedModel（固定配置与凭据）
                           │
Agent Driver / Compaction / Subagent
    │ prepare_request：历史投影、图片、预算、请求记录
    ▼
PreparedCall → 选定协议适配器 → HTTP / SSE / NDJSON
    │                         ↑
    └── StreamDelta + Result<ModelResponse, LlmError>
                     │
             现有事件日志与投影
```

建议目录：

```text
src-tauri/src/llm/
  mod.rs                 服务入口与公共类型
  types.rs               请求、内容、增量、响应、能力
  adapter.rs             适配器与固定调用接口
  registry.rs            编译期适配器注册、路由校验
  routes.rs              路由存储、修订号、原子更新
  catalog.rs             内置目录、覆盖与精确模型解析
  runtime.rs             prepare_model / prepare_request / stream
  projection.rs          历史转换与请求图片投影协调
  replay.rs              回放来源与版本校验
  credentials.rs         复用 CredentialManager 的认证解析
  errors.rs              稳定错误 code 与分类
  transport/             HTTP、SSE、NDJSON、大小限制、超时
  adapters/
    chat_completions/    序列化、流解析、兼容配置
    responses/           Responses 原生实现与回放
    ollama/              Ollama 原生实现
    anthropic/           后续 Messages 实现

protocol/llm/
  catalog.json           内置目录与迁移后的兼容预设
  catalog.schema.json    数据校验，不包含密钥
  fixtures/              共用序列化与协议测试样例
```

`agent_runtime/model.rs` 在纯提取阶段可暂时 re-export 类型，迁移完导入后删除。`default_model_tools()` 等 Agent 工具定义移动到现有工具所有者，不进入通用 LLM 模块。`ai.rs` 最终只保留 Tauri 命令和已有偏好迁移入口。

通用 LLM 模块通过小型图片解析接口使用现有 `ImageStore`，不直接依赖 `AgentEntry`、审批或 SSH 执行结构。图片解码和不可变存储仍由当前实现负责。

## 4. 三个独立概念：路由、模型、选择

### ProviderRoute：连接

一条路由描述一个实际连接，可服务多个模型。同一厂商的官方 API、公司代理和个人代理是三个不同的 routeId；品牌名称不是连接身份。

主要字段：`id`、`revision`、`displayName`、`presetId?`、`adapterId`、`baseUrl`、`auth`、`compat`、`models?`、`modelOverrides?`、`defaults`、`retryPolicy`、`timeouts`。

- `adapterId` 选择协议代码，例如 `chat-completions`、`responses`、`ollama`、`anthropic-messages`。
- `presetId` 只在配置解析时提供目录和兼容默认值。迁移后不依据 URL 或模型名在发送请求时猜测厂商。
- `auth` 为 `none` 或系统钥匙串引用，预留独立认证提供器扩展点。OAuth 不在首期实现范围内。
- 需要密钥却无法解析时返回 `MISSING_CREDENTIAL`，不回退到另一条路由或环境中的其他密钥。
- `models` 指定时替换内置模型列表；`modelOverrides` 只覆盖已存在条目，两者不能同时设置。未知 override id 在保存时拒绝。
- 完全自定义的路由需要协议、端点和非空模型声明。目录未包含的模型可手动添加后使用，不隐式假定它具备工具或图片能力。
- 当前 URL 限制继续生效：禁止 URL 用户信息，HTTPS 为默认，仅现有允许的本机地址使用 HTTP。

### ModelDescriptor：模型事实

`routeId + modelId` 标识实际模型；同名模型经过不同网关可能具有不同能力。描述包括 `contextWindow`、`maxOutputTokens`、`inputModalities`、`toolCalling`、`reasoning` 和可选图片预算策略。

能力使用明确的 supported / unsupported / unknown 状态，避免把未知当作支持。`reasoning.efforts` 是适配器发布的有序字符串 ID 与显示名称，界面不再依赖 `AiReasoningEffort` 固定枚举。wire 参数拼写只存在于适配器配置中。

容量元数据要区分提供方上限与 ShellSpan 的保守预算。`ResolvedModel` 输出最终有效限制及来源，例如内置目录、用户声明、保守应用限额；日志记录实际用于本次调用的值。图像 token 估算仍标注为估算，不能伪装成服务端 usage。

### ModelSelection：会话选择

```ts
// 提案类型；最终 IPC 类型从 Rust DTO 生成或通过同源 schema 校验。
interface ModelSelection {
  routeId: string;
  modelId: string;
  reasoningEffort?: string;
}
```

全局默认、Session 选择与子 Agent 选择分别存储。修改全局默认不改变现有会话；修改 Session 选择对下一个 Step 生效。前端提交 routeId/modelId，不再在每次启动或切换时提交整份端点配置。

子 Agent 默认在创建时继承父级固定选择，后续跟随自己的配置策略，父 Session 换模型不自动改变已启动子任务。压缩默认使用当前 Step 的固定模型与连接；将来允许指定压缩模型时，它也必须走同一准备入口并记录独立来源。

### 能力解析规则

1. 合并内置预设和用户路由配置，验证 adapterId 与兼容配置类型。
2. 根据 `models` 或 `modelOverrides` 形成精确模型目录，查找原样 modelId；不随意小写化厂商模型 ID。
3. 由适配器验证配置能否表达该模型，产出 `ResolvedModel`，将能力与协议实现限制取交集。
4. 应用请求参数并验证：推理等级必须在列表中，输出上限不得超过有效限制，工具调用必须得到明确支持。
5. 对未知容量的自定义模型要求显式配置；内置目录中的保守默认值必须显示来源。取消依赖 `ctx-` / `context-` 名称暗示容量的运行逻辑。

兼容字段采用每种适配器的强类型结构。可描述系统角色、输出上限字段、推理编码、累计流、usage 选项、严格工具 schema 等已实现行为；不提供任意 JSON patch 或脚本执行。字段必须有序列化实现和测试才可接受。

## 5. 服务接口与请求生命周期

对外服务提供 `list_routes()`、`list_models(route_id)`、`resolve_model(selection)`、`prepare_model(selection)`、`prepare_request(model, request)` 和 `stream(call, cancellation, sink)`。模型发现是独立的 `discover_models(draft)` 操作，只返回待采纳候选，不自动改变有效目录。

注册表中每个 adapterId 只能注册一次；路由指向已注册适配器。发布候选路由集合前校验所有条目，成功后原子替换 `Arc<RouteSnapshot>`。重复 ID、未知适配器和无效配置使候选失败，保留此前有效状态并返回明确错误。

适配器的概念接口如下，具体 Rust 类型在实现阶段补齐：

```rust
trait LlmAdapter: Send + Sync {
    fn id(&self) -> AdapterId;
    fn resolve_model(&self, route: &ResolvedRoute, model: &str)
        -> Result<ResolvedModel, LlmError>;
    // 声明类型转换、发现、回放恢复等协议能力。
}

#[async_trait]
trait PreparedCall: Send + Sync {
    fn snapshot(&self) -> &RequestSnapshot; // 无密钥，可记录
    async fn stream(
        &self,
        attempt: AttemptContext,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, LlmError>;
}
```

`PreparedModel` 固定路由版本、适配器 Arc、模型能力、兼容配置、端点、认证解析结果、重试策略和超时策略。`PreparedCall` 再固定该次逻辑请求的内容与图片投影。准备对象不实现包含密钥的 Debug/Serialize；事件只接收无密钥 DTO。

一个 Step 的顺序：

1. 从已提交 Session 选择获取并固定 `PreparedModel`，预检和正式请求共用它。这样 `apply_pre_step_hooks()` 与 `run_step()` 不会分别读到不同代配置。
2. 用固定模型的有效容量计算预检预算，必要时压缩。压缩调用拥有独立请求 ID 和 purpose，但复用这份连接与模型事实。
3. 完成 inbox、Skill、工具 schema 和历史装配；投影历史、解析图片，进行最终预算校验，生成 `PreparedCall`。
4. 先持久化请求快照与 start，再发送网络请求。读取图片失败等准备错误不应形成一个已经发送的请求记录。
5. 接收增量；返回成功响应后由 Runtime 提交 assistant/message，并进入原有工具流程。
6. 普通瞬时重试复用 PreparedCall，分配新 attempt/requestId。上下文溢出后的压缩属于内容变更，必须重新 prepare_request 并记录新快照，不能伪装成相同请求。

路由或凭据变更在同一后端服务内串行发布，修订号覆盖端点、模型配置和密钥变更。准备过程读取配置、解析密钥后检查修订仍有效，冲突则重新准备；冻结成功后使用同一组连接与凭据。已有 Step 保持原快照；显式取消仍能立即终止。删除路由使后续准备失败，不能回落到默认模型。

保存新路由配置通过乐观版本检查防止并发编辑覆盖。持久化成功后发布内存快照再通知 UI；发布本身应是已验证对象的无失败交换。钥匙串与数据库不是同一事务，保存工作流必须保留旧引用并能恢复：新密钥先写独立版本记录，数据库提交新引用后发布，失败时清理未引用记录。迁移已有凭据时保留原 providerId 记录可读，不覆盖正在被旧配置引用的密钥。

## 6. 统一流语义，保留现有 Rust 调用方式

保留 `StreamDelta + Result<ModelResponse, LlmError>`，无需逐字复制 deepseek-harness 的 `AsyncIterable<StreamChunk>`。异步函数的唯一返回是该次尝试唯一的终止信号；适配器不得返回后继续向 sink 发送事件，也不允许私下启动重试。

- 文本、推理和工具调用共享稳定 block index，按首次出现顺序分配。
- 工具参数 delta 保留原始字符串；完成后解析为现有 `ModelToolCall.arguments: Value`，通过校验后才允许进入工具调度。无效 JSON 产生协议错误，不能构造空参数继续执行。
- sink 增量只负责流式展示；成功返回的最终内容是提交权威。保留 ShellSpan 的最终响应校验和单次 assistant/message 提交，不引入第二个提交者。
- 解析器必须读取尾部 usage 再完成；总量采用最后有效累计值，避免累加重复 usage。未报告的计数使用 None，缓存与未缓存输入避免重叠。
- 失败尝试的已显示内容保留在 Activity/既有中断记录中，但不作为成功历史重复送入模型。失败的部分工具调用不会被执行。
- 继续保留取消、首字节/空闲超时、帧大小、总响应大小、工具 ID/参数大小等现有限制。
- 错误沿用当前分类并补充稳定 code，例如 `UNKNOWN_ROUTE`、`UNKNOWN_MODEL`、`UNSUPPORTED_OPTION`、`UNSUPPORTED_REASONING_EFFORT`、`MISSING_CREDENTIAL`、`QUOTA_EXCEEDED`。配额不足与瞬时限流分开，前者不按普通限流重试。

重试配置归路由，执行权归现有 `retry.rs` 与对应调用者。主请求、压缩与子 Agent 使用同一错误分类和重试规则；禁止适配器 HTTP 层重试与 Runtime 重试叠加。

## 7. 历史回放与模型切换

将私有原生状态从通用推理内容中移到 assistant 响应上的 `ReplayEnvelope`：

```text
ReplayEnvelope
  version
  adapterId + replayFormatVersion
  source: routeId, modelId, replayDomainId
  response: 最小、允许列表内的原生元数据
  blocks: 与已提交内容块一一对应的私有元数据
```

`replayDomainId` 是持久化的无密钥身份，由路由的端点、账号身份和协议语义变化决定；不使用内存指针，也不直接由密钥散列产生。纯显示名称或超时调整不必让历史失效，无法证明账号连续性的认证替换应更新此 ID。

恢复时先核对 envelope 版本、adapterId、回放域和内容对应关系，再由适配器判断同模型或跨模型恢复是否可行。不能只因为两条路由都叫 OpenAI，就发送另一端点产生的 response id 或签名。

无法恢复时保留通用文本与工具调用链，并由目标协议决定如何处理普通 reasoning 文本；私有签名、原生 item 和 response id 不跨域传递。若目标协议无法在这些条件下形成合法历史，返回明确的历史不兼容错误，不猜造签名或偷偷删除工具结果。工具 ID 重映射必须同时作用于调用和结果，并保持稳定。

回放原生元数据保留在后端日志内，前端只接收确有展示意义的投影。对来源不明的旧 `provider_item` 不推断可信身份。

## 8. 图片与容量统一

保留 ImageRef、不可变文件、图片解码限额和现有安全检查。把 `vision-contract.json` 分成两类事实：全局图片安全限额继续由图片模块拥有，模型是否支持视觉及其请求预算迁入统一目录。

请求图片投影基于 PreparedModel：模型支持的输入格式、总图片数、总请求字节、单图尺寸和 token 估算共同生成确定性投影。预算计算读取实际投影计划，协议序列化消费同一计划，避免预算按缩略图计算而实际发送原图。

首期保留现有产品行为：含图片历史或待发送图片时，切换到不支持图片的模型返回 `IMAGE_MODEL_UNSUPPORTED`。这也是当前 `select_model()` 的行为，不在基础重构中偷偷改变。

后续如需要 deepseek-harness 的纯文本降级，可增加显式会话策略 `historyImages: placeholders`：只替换历史图片，保留附件身份并记录投影策略；新提交和 inbox 中尚未消费的图片继续要求视觉模型。界面应明确提示“该模型无法读取历史图片”。这项行为单独验收。

主请求、预检、压缩和上下文用量 UI 均使用同一 ResolvedModel；压缩可以有自己的更低输出策略，但不得重新从另一个目录猜测上下文容量。图片不会因压缩被删除，沿用现有附件保留机制。

## 9. 设置和界面职责

增加以 Rust 为权威的 Tauri 命令，命名在实施时与现有风格对齐：

| 操作 | 输入 | 输出 |
| --- | --- | --- |
| 列出路由 | 无 | 无密钥路由、revision、配置状态 |
| 保存路由 | 配置、expectedRevision | 校验后的配置与新 revision |
| 列出模型 / 解析选择 | routeId / ModelSelection | 模型列表或 ResolvedModel DTO |
| 发现模型 | 未保存草稿与可选临时密钥 | 候选 ID 与可得元数据 |
| 验证模型调用 | 草稿与所选模型 | 明确的连接/认证/所选能力验证结果 |
| 选择 Session 模型 | sessionId、ModelSelection、可选解析版本 | 已提交 Session snapshot |

`GET /models` 或 Ollama 列表成功只证明发现成功，不代表工具调用和图片输入可用。发现结果在用户采纳时填充目录，缺失的容量或能力需要配置，不凭一次列表响应启用全部功能。

设置页按连接管理，每条连接下面可添加多个模型；常用模型选择器按连接分组。推理选项、图片按钮和上下文容量都取自后端 DTO，组件不再根据 modelId、域名或品牌写判断。前端可做输入格式校验，最终语义校验由后端负责。

`aiSettingsStore` 最终成为编辑草稿和后端状态缓存，不再直接通过通用 preferences 写入路由。测试连接时输入的密钥仍只作为临时参数；普通路由、Session 选择和事件 DTO 不返回密钥。

先完成后端解析与已有单模型 UI 的兼容接线，再升级为一连接多模型界面，避免一次同时重做交互和协议处理。

## 10. 持久化与兼容迁移

配置与会话日志分开版本化。新路由配置使用独立 schemaVersion，不能复用事件版本号。

### 配置迁移

每条旧 `AiProviderProfile` 转换为一条同 ID 路由，并把旧 `model` 放入单元素模型列表。保留原 ID、显示名称、端点、认证要求、重试配置和选择；不因为端点相同自动合并用户的连接。

旧 `kind` 映射到 adapterId：`openAi → responses`、`openAiCompatible → chat-completions`、`ollama → ollama`。旧 profile/域名规则仅在迁移时解析一次，将有效兼容行为写入新配置。已有大小写行为、Qwen instruct 例外、GLM 推理编码、MiniMax 累计片段等先通过夹具保留。

旧容量 hint 迁移为显式容量配置并保留来源；不改模型 ID。未知或不合法条目标记为待修复，保留原配置用于诊断，不静默丢弃。迁移具备幂等标记，先保留旧配置备份再提交新文档。

### 会话格式

纯代码提取阶段继续使用 Event v4，不增加新字段。正式引入路由快照、开放推理 ID 与 ReplayEnvelope 时，建议在同一次版本升级中进入 Event v5：当前 Rust/TypeScript 读者均严格识别 v4，不能把未声明字段当作兼容性承诺。

在可交付 v5 前提供单独的离线 v4→v5 转换器，转换不是生产 Reader 的隐式分支：

- 保留原日志和附件；临时输出完整新日志，通过结构、引用和投影校验后再原子切换。
- 保持已有事件的 seq、工具 ID、调用/结果关系、图像引用和审批事实。缺失的历史能力快照明确标记为 legacyUnknown，不以今天目录伪造当时事实。
- 旧 provider_item 若不能验证来源，迁移为不可执行的历史归档信息；普通内容仍能展示。恢复需要签名的请求必须重新准备或明确失败。
- 导入中的未完成 Step 转入既有恢复流程，不能因转换自动重放工具。迁移失败保留原文件，应用提示迁移状态。
- 当前版本运行时只读写 v5，测试夹具、前端类型、快照、分页、导出和相关脚本同批升级。转换器保留为显式工具。

请求快照至少包含 routeId、routeRevision、adapterId、modelId、目录版本、有效能力、推理选择、输出设置、投影策略、purpose 和内容引用。header 去重比较完整无密钥快照的确定性摘要，端点/兼容/能力变化都必须产生新 header；不只是比较 providerId/modelId。

记录图片投影版本、尺寸、不可变内容引用及必要的请求变体哈希，保证模型可见输入可重建；不把 base64 或钥匙串内容复制进事件。对应准备算法版本与固定样例属于回放验证的一部分。

## 11. 实施顺序与验收

| 阶段 | 交付 | 验收条件 |
| --- | --- | --- |
| A：协议提取 | 新 `llm/`，拆出三种现有协议和公共传输；保持现有接口 | Event v4 和请求 wire fixtures 行为不变；已有流解析、取消、usage 和工具链测试通过 |
| B：统一能力 | 精确模型目录、Rust resolver、强类型 compat、预算统一、前端能力 DTO | 同一选择的 UI/预检/压缩/实际请求容量一致；无效推理及 unsupported tool/image 在网络前失败 |
| C：配置与快照 | RouteStore、ModelSelection、多模型路由、PreparedModel/Call、后端设置命令；配置迁移与 Event v5 一次完成 | 更新路由不改变进行中的 Step；重试保持快照；转换可恢复、凭据不泄露、请求头覆盖配置变化 |
| D：完整回放 | ReplayEnvelope、跨路由校验、投影记录 | 同域合法回放保留；换端点/账号不发送旧签名；重启后身份判定仍成立 |
| E：新增协议 | Anthropic Messages + 目录声明 + 协议测试 | 主 Loop 与工具调度无厂商分支；文本、推理、工具回合、错误、usage、取消可通过同一套适配契约测试 |

C 阶段先把 D 所需 envelope 字段和无密钥来源结构纳入 v5 schema，D 阶段填充和验证行为，避免连续修改事件大版本。A/B 是最先可审查、可交付的工作；不将新增厂商作为基础拆分的前置条件。

重点测试按风险选择：

1. 现有协议回归：DeepSeek 推理回填、GLM 参数、MiniMax 累计流、Qwen instruct、Responses 原生 item、Ollama NDJSON。
2. 通用流契约：任意网络分片、尾部 usage、工具参数分片、并行调用顺序、无效 JSON、取消和失败后无工具执行。
3. 能力与预算：精确覆盖、未知模型、模型 ID 大小写、输出预算、视觉预算、压缩与普通请求一致性。
4. 并发：流式中换模型、保存端点、轮换密钥、删除路由；进行中 Step 和普通重试不混用配置，下一 Step 读取新版本。
5. 恢复：合法签名回放、跨路由隔离、旧格式迁移、partial request、待审批工具、图片附件重启后保留。
6. 前端：同一连接多个模型、推理选项来自 resolver、会话选择不改全局默认、配置失效可见且不静默换模型。

优先复用 `model.rs` 的协议夹具，以及现有 `test:ai:stage4`、`test:ai:stage3b`、`test:agent:runtime` 覆盖的行为；提取后同步更新测试路径。新适配器交付前使用授权凭据运行真实协议 smoke，并把离线 fixture 验证与真实服务验证分开报告。本设计阶段未执行这些运行测试。

## 12. 边界

首期不实现模型自动择优、跨厂商失败转移、任意脚本插件、后台自动刷新目录、OAuth 或静默图片降级。它们会引入额外选择、凭据或历史语义，需要单独产品决策。

新增内置协议仍是一次应用代码发布；用户可以在已支持协议上通过配置添加模型和网关。若未来引入 pi-ai 桥接，它必须满足相同的快照、事件、取消、回放和单次尝试契约，不能绕开 Rust Runtime。
