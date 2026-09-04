# ShellSpan AI Panel 向 DeepSeek Harness 对齐计划清单

> 当前状态（Stage 7）：6A–6D 累计实现已安全接入 main 工作目录，保留 `1ac0c1e4` Turn 聚合与 `31ce4343` system-prompt snapshots。最终门禁、逐场景视觉更改、有效性能样本、Provider 3 PASS / 5 SKIP 和 Windows NOT RUN 见 [Stage 7 验收](ai-runtime-stage7-validation.md)。唯一现行交接入口为 [交接说明](ai-runtime-handoff.md)。未提交、暂存或推送；本页其余 Phase 0–6 计数和当时暂停状态均为历史，不作为当前总目标完成声明。

> 历史状态：本页记录此前 AI Panel Phase 0–6 与当时的离线/live 验收，不代表 2026-09-04 Runtime 补齐目标全部完成。
> 决策：一次性切换事件协议，不兼容、不迁移、不读取旧 Agent 会话  
> 范围：Agent Runtime、会话事件、Conversation/Activity 投影、AI Panel 对话渲染与统计  
> 参考实现：`/Users/zhengbiwen/Developer/deepseek-harness`

> 历史交接：阶段 1–5 Runtime 修复已合入 main；当时暂停的 6A WIP 已由后续独立任务继续。请以 [跨设备交接](ai-runtime-handoff.md) 和 [Runtime 完整范围清单](ai-runtime-harness-remediation-plan.md) 为当前状态依据；本页历史勾选项及 live 记录不能替代新累计代码验收。

## 1. 目标结果

完成后，同一组确定性 Agent 事件在 ShellSpan 中应形成与 DeepSeek Harness 一致的对话语义：

```text
系统提示词
用户消息
已思考
  ├─ 上下文注入
  ├─ Reasoning
  ├─ Tool / Retry / Error
  └─ 其他模型可见过程
最终回答
统计行
```

- [x] Conversation 只显示用户需要阅读的对话过程，不再直接堆叠 Agent/Turn/Step/Request 生命周期。
- [x] Activity 独立承载完整运行轨迹和状态变化。
- [x] 模型实际可见的 system prompt、context、tools 和历史能够从持久事件中还原。
- [x] reasoning、文本、工具调用和 usage 在 Runtime 层结构化，不由 React 猜测。
- [x] Turn 结束后过程自动折叠，最终回答保持可见。
- [x] 统计值来自事件事实；无法证明的字段不显示、不估算。
- [x] 在固定 fixture、固定视口和固定主题下通过视觉回归。

## 2. 已确认的工程决策

- [x] 不兼容旧 Agent Session Event v2/v3。
- [x] 不实现旧日志迁移器、兼容读取器或降级投影。
- [x] 新协议前后端原子切换，不保留双写和运行时 feature flag。
- [x] 旧会话使用新的存储命名空间隔离，不自动删除旧文件。
- [x] 不直接依赖 DeepSeek Harness 的 Cordis/UI 包；只移植协议语义、投影规则和验收行为。
- [x] 保留 ShellSpan 的 Rust Runtime、Tauri 边界和现有 Workspace 外壳。
- [x] 继续使用现有 shadcn chat primitives：`MessageScroller`、`Message`、`Bubble`、`Marker`、`Collapsible`。
- [x] 不伪造 `@deepseek-ai/...` producer；界面只展示实际参与请求组装的来源。
- [x] 不逐字复制 DeepSeek Harness 的 system prompt；ShellSpan 根据自身工具、权限和安全合同组装提示词。

## 3. 非目标

- [x] 不把 Ask 会话迁移到 Agent Runtime。
- [x] 不重写 AI Panel 外壳、宽度调整、Drawer 或 Composer 状态机。
- [x] 不引入第二套聊天滚动系统、消息气泡组件或颜色系统。
- [x] 不为缺少能力的 provider 伪造 reasoning、cache usage 或精确 token 统计。
- [x] 不为了截图相似而显示实际上没有注入的 skill catalog、plugin 或 agent instructions。
- [x] 不恢复已删除的 Legacy AI Panel 或旧会话 UI。

## 4. 实施顺序与依赖

```text
Phase 0 基线
  ↓
Phase 1 新事件协议与存储硬切
  ↓
Phase 2 Prompt / Provider / Streaming 规范化
  ↓
Phase 3 Conversation / Activity 投影重写
  ↓
Phase 4 Turn Process / Renderer / Stats
  ↓
Phase 5 视觉对齐与回归
  ↓
Phase 6 清理、文档与发布门禁
```

后续 Phase 不得通过临时前端字段绕过前置协议工作。任何 model-visible 数据都必须先进入持久事件，再进入投影和 UI。

## 5. Phase 0：冻结可比较基线

### 5.1 工作区与证据

- [x] 在开始实现前记录当前分支、工作区修改和相关文件状态。
- [x] 不覆盖当前未提交修改；冲突文件逐个合并。
- [x] 建立一组不请求真实模型的确定性 Agent Session fixture。
- [x] 固定 fixture 的事件时间、token usage、provider、model、reasoning level 和权限。
- [x] 保存当前实现的 DOM 快照与截图作为 before 证据。
- [x] 保存 DeepSeek Harness 对应场景的结构和截图作为目标证据。
- [x] 确保对比双方使用相同视口、主题、字体缩放和内容。

### 5.2 基准场景

- [x] 简单 `hello`，包含 system prompt、context、reasoning 和最终回答。
- [x] 无 reasoning 的直接回答。
- [x] reasoning 流式生成。
- [x] 单次工具调用与工具结果。
- [x] 多次工具调用。
- [x] retry 后成功。
- [x] provider error / max tokens / cancel。
- [x] partial history / pagination。
- [x] 完整 usage 与缺失 usage 两种情况。

### Phase 0 验收

- [x] 同一 fixture 连续运行时，事件、DOM 和截图稳定。
- [x] 不再使用两次真实模型请求的截图作为主要对齐判据。
- [x] 每个后续 Phase 都能复用相同 fixture。

## 6. Phase 1：Agent Session Event 新协议硬切

### 6.1 协议切换

- [x] 将唯一支持的 Agent Session Event envelope 升级为 v4。
- [x] Rust 与 TypeScript 类型在同一提交中切换。
- [x] 删除 v2/v3 反序列化、版本分支、兼容测试和旧 mutation 兼容规则。
- [x] 更换 Agent Session 存储命名空间，使旧会话不进入新 Session 列表。
- [x] 新 Runtime 遇到旧 envelope 时明确拒绝，不尝试部分恢复。
- [x] 更新 fixture、snapshot、IPC payload 和测试 helper 到 v4。

### 6.2 消息来源与 provenance

- [x] 用结构化 provenance 替换当前过窄的 message source。
- [x] 支持 `user`、`runtime`、`plugin`、`skill-catalog`、`agent-instructions`、`skill-invocation`、`session-reference`、`form`。
- [x] provenance 至少包含稳定 kind、显示 label、producer id 和可选 metadata。
- [x] source 是数据事实，不允许 renderer 根据文本内容推测来源。

### 6.3 请求与响应事件

- [x] `request/header` 记录完整的 provider、model、reasoning、请求原因和 series 边界。
- [x] `request/header` 记录模型实际接收的 system prompt。
- [x] `request/header` 记录模型实际接收的 tool schemas。
- [x] `assistant/chunk` 支持 `textDelta`。
- [x] `assistant/chunk` 支持 `reasoningDelta`。
- [x] `assistant/chunk` 支持 `toolCallDelta`。
- [x] `assistant/chunk` 支持 provider 返回的 usage 更新。
- [x] `assistant/message` 保存有序 content blocks，而不是单一字符串。
- [x] `assistant/message` 保存最终 usage、stop reason 和 interrupted 状态。

### 6.4 Usage 合同

- [x] 定义 uncached input tokens。
- [x] 定义 cache read tokens。
- [x] 定义 cache write tokens。
- [x] 定义 output tokens。
- [x] 定义 reasoning tokens。
- [x] 定义 total tokens。
- [x] 明确每个字段的缺失语义，禁止用 `0` 代表未知。

### 6.5 时间合同

- [x] 请求开始、首 reasoning chunk、首 text chunk、完成和中断都由 Runtime 时间戳表达。
- [x] 能由事件计算 TTFT、reasoning duration 和 LLM duration。
- [x] UI 不再使用组件 mount 时间作为模型耗时。

### 主要文件

- `src-tauri/src/agent_runtime/event.rs`
- `src-tauri/src/agent_runtime/session.rs`
- `src/types/agent-session.ts`
- `src/lib/agent-session-client.ts`
- `src/test/fixtures/agent-session.ts`

### Phase 1 验收

- [x] 任意新会话只产生 v4 事件。
- [x] v4 日志能够无损往返序列化。
- [x] 未知 usage 与真实 `0` 可区分。
- [x] 旧事件不会出现在新 Session Browser 中。
- [x] Rust 与 TypeScript fixture 对同一事件字段达成一致。

## 7. Phase 2：Prompt、Context、Provider 与 Streaming 规范化

### 7.1 Prompt assembler

- [x] 将当前硬编码 system prompt 替换为可测试的 assembler。
- [x] 根据 ShellSpan 的真实权限、工作区、工具和 Runtime 能力组装提示词。
- [x] 固定 section 顺序，保证同输入得到同 prompt。
- [x] 将最终 prompt 原文写入 `request/header`。
- [x] tool schemas 与发送给 provider 的内容来自同一份结构，不允许记录副本漂移。
- [x] 为 prompt assembler 添加 golden tests。

### 7.2 Context injection

- [x] Runtime context 作为非用户消息进入事件流。
- [x] Agent instructions 作为独立来源进入事件流。
- [x] 仅在真实技能目录参与请求时记录 skill catalog。
- [x] 仅在真实 plugin 参与请求时记录 plugin context。
- [x] 所有注入项都有稳定 producer 和显示 label。
- [x] 注入内容既进入 model surface，也进入可回放事件。

### 7.3 Provider adapter

- [x] 为 MiniMax、DeepSeek、OpenAI-compatible 建立明确的能力配置。
- [x] 解析 provider 原生 `reasoning_content` 或等价字段。
- [x] 支持 OpenAI Responses 风格的结构化 reasoning/content。
- [x] 将 `<think>...</think>` 作为 Runtime fallback 解析，而不是 UI 主路径。
- [x] 正确处理 MiniMax 累计流，避免重复文本和 reasoning。
- [x] 正确合并 tool call name、arguments 和 call id 增量。
- [x] provider 支持时请求流式 usage；不支持时不发送不兼容参数。
- [x] 保持 content block 的 provider 顺序。

### 7.4 模型历史

- [x] reasoning、assistant text、tool call 和 tool result 以正确顺序进入下一 Step 的模型历史。
- [x] compaction 前后的 model-visible surface 可从 committed events 重建。
- [x] 中断响应不会被错误标记为完整回答。

### 主要文件

- `src-tauri/src/agent_runtime/model.rs`
- `src-tauri/src/agent_runtime/driver.rs`
- `src-tauri/src/agent_runtime/surface.rs`
- `src-tauri/src/ai.rs`

### Phase 2 验收

- [x] 捕获的请求 body 与 `request/header` 中的 prompt/tools 一致。
- [x] MiniMax 累计流不会产生重复字符。
- [x] reasoning 不依赖 React 字符串解析即可完整回放。
- [x] provider 未返回 usage 时，日志保持未知而不是生成估算值。
- [x] 下一 Step 能看到上一 Step 的结构化 assistant/tool 历史。

## 8. Phase 3：Conversation 与 Activity 投影重写

### 8.1 投影边界

- [x] 建立 `projectAgentChatNodes`，只生成对话可读节点。
- [x] 建立或收紧 `projectAgentActivityNodes`，承载完整生命周期和诊断轨迹。
- [x] Conversation 与 Activity 读取同一有序 committed event window。
- [x] React 不创建第二份业务状态或第二条事件流。

### 8.2 Conversation 映射

- [x] system prompt → `systemPrompt` node。
- [x] runtime/plugin/skill context → `contextInjection` node。
- [x] user message → `userMessage` node。
- [x] reasoning blocks → `reasoning` node。
- [x] tool/retry/error → turn process child nodes。
- [x] assistant content blocks → `assistantMessage` node。
- [x] completed turn → `turnProcess` 与 `turnTail`。
- [x] usage → durable stats projection。

### 8.3 Activity 映射

- [x] session/agent/turn/step/request lifecycle 只进入 Activity。
- [x] 相同状态实体使用稳定 key，状态更新覆盖节点而不是追加重复行。
- [x] request header/context/usage 不再共用会造成类别漂移的 marker。
- [x] error、retry 和 cancellation 保留足够诊断信息。

### 8.4 排序和不完整历史

- [x] 同 `seq` 派生的多个节点具有确定顺序。
- [x] 分页 prepend 不改变已有 node key。
- [x] partial history 缺少 turn 边界时不进行误导性折叠。
- [x] streaming chunk 不为历史节点制造新 identity。

### 主要文件

- `src/lib/ai/conversation-projection.ts`
- `src/lib/agent-session-projection.ts`
- `src/lib/ai/conversation-node.ts`
- `src/lib/ai/agent-session-adapter.ts`

### Phase 3 验收

- [x] `hello` fixture 的 Conversation 中不出现重复“Agent 状态”。
- [x] “回合状态”“步骤状态”“模型请求 stop”不再作为聊天正文出现。
- [x] Activity 仍可查看完整生命周期。
- [x] 相同事件重放两次得到完全相同的 node keys 和顺序。
- [x] pagination、streaming 与 full replay 的最终投影一致。

## 9. Phase 4：Turn Process、Renderer 与 Stats

### 9.1 Turn Process 状态机

- [x] system prompt 位于 Turn Process 外。
- [x] user message 位于对应 Turn Process 之前。
- [x] 当前生成中的 reasoning/process 默认展开。
- [x] Turn 完成后 context、reasoning、tool、retry、error 折叠进“已思考”。
- [x] 最终 assistant answer 始终保持可见。
- [x] partial/incomplete turn 不自动折叠。
- [x] 展开状态按 session + turn + answer generation 保存。
- [x] streaming 更新不反复重置用户手动展开状态。
- [x] 折叠控件支持键盘、焦点恢复和 `aria-expanded`。

### 9.2 语义 renderer

- [x] 实现 `SystemPromptRow`。
- [x] 实现 `ContextInjectionRow`。
- [x] 实现 `ReasoningRow`。
- [x] 实现 `TurnProcessRow`。
- [x] 实现 `StatsLine` / `TurnTail`。
- [x] assistant renderer 直接消费 content blocks。
- [x] 删除 React 中的 `<think>` 主路径解析。
- [x] 删除 React mount-time reasoning duration。
- [x] 所有新增文案进入 locale，不在 JSX 中散落硬编码字符串。

### 9.3 shadcn 与聊天组件约束

- [x] Conversation 继续由唯一 `MessageScroller` 管理滚动。
- [x] 行继续使用 `Message`，消息表面继续使用 `Bubble`。
- [x] system/context note 使用 `Marker` 或基于现有 primitive 组合。
- [x] 折叠使用已安装的 `Collapsible`。
- [x] 分隔使用 `Separator`，不手写带边框的占位元素。
- [x] 颜色只使用 semantic tokens。
- [x] 不新增手写 sticky-to-bottom、ResizeObserver 或第二滚动监听器。

### 9.4 Stats 投影

- [x] 显示 turn 数和 step 数。
- [x] 显示 LLM duration 和 tool duration。
- [x] 显示 TTFT。
- [x] 显示 tokens/s。
- [x] 显示 input、output、reasoning tokens。
- [x] 有数据时显示 cache read/write 与命中率。
- [x] 缺失字段按组隐藏或标记不可用。
- [x] session stats 与单 turn stats 采用同一计算口径。
- [x] pagination/compaction 后统计结果保持稳定。

### 主要文件

- `src/components/ai/workspace/ai-conversation-node-seat.tsx`
- `src/components/ai/workspace/ai-conversation.tsx`
- `src/components/ai/assistant-message-content.tsx`
- `src/components/ai/chat-primitives.tsx`
- `src/components/ai/ai-panel.css`

### Phase 4 验收

- [x] streaming、completed、failed、cancelled 四种 Turn 状态均有确定布局。
- [x] 键盘可展开/折叠过程，焦点不会因 streaming 丢失。
- [x] stats 全部可以追溯到 fixture 中的事件字段。
- [x] renderer 不读取 Runtime 未记录的隐式状态。
- [x] 没有新增平行 chat primitives。

## 10. Phase 5：视觉对齐与视觉回归

### 10.1 视觉项目

- [x] 对齐系统提示词、上下文注入和 reasoning 的图标语义。
- [x] 对齐标题、正文、辅助信息的字号和颜色层级。
- [x] 对齐消息气泡宽度、圆角和内容区边界。
- [x] 对齐 process 行间距、缩进、分隔线和展开箭头。
- [x] 对齐最终回答与统计行之间的节奏。
- [x] 对齐 Composer 上方内容区的底部留白。
- [x] 保持 ShellSpan 现有 320–720px 面板宽度合同。
- [x] light/dark 均使用现有 semantic tokens。
- [x] reduced-motion 下不依赖动画传递状态。

### 10.2 Playwright 截图矩阵

- [x] 400px / light / collapsed。
- [x] 400px / light / expanded。
- [x] 560px / light / completed。
- [x] 720px / light / tool process。
- [x] 400px / dark / completed。
- [x] streaming reasoning。
- [x] retry/error。
- [x] missing usage。
- [x] 1x 与 2x device scale factor 至少各覆盖一组核心场景。

### 10.3 视觉基线规则

- [x] 截图只使用确定性 fixture，不依赖网络或真实模型速度。
- [x] 动态时间、随机 id 和光标动画在截图模式固定。
- [x] 字体加载完成后再截图。
- [x] 将像素差异与语义 DOM 断言同时作为门禁。
- [x] 视觉基线更新必须附带明确原因，不通过批量覆盖掩盖回归。

### Phase 5 验收

- [x] 核心 `hello` 场景与 DeepSeek Harness 的信息层级和折叠结构一致。
- [x] 所有目标宽度无横向溢出、截断错误或 Composer 遮挡。
- [x] dark mode 不出现硬编码浅色残留。
- [x] screenshot suite 在本机连续运行稳定。

## 11. Phase 6：清理、文档和发布门禁

### 11.1 删除旧路径

- [x] 删除旧 event version 常量和兼容解析器。
- [x] 删除旧 message source 类型。
- [x] 删除 lifecycle-to-conversation 旧映射。
- [x] 删除 UI `<think>` 计时与解析路径。
- [x] 删除无法基于事件证明的 usage 估算。
- [x] 删除不再使用的 fixture、snapshot 和测试 helper。
- [x] 搜索并移除新协议下不可达的 dead code。

### 11.2 文档

- [x] 更新 `docs/agent-runtime-vnext.md` 的事件合同和 UI 投影说明。
- [x] 更新 provider 能力与 usage/reasoning 支持矩阵。
- [x] 记录旧 Agent 会话不兼容且不加载。
- [x] 记录新存储命名空间和可选的人工清理方式。
- [x] 记录 visual regression 的运行和基线更新方式。
- [x] 记录“model-visible ⇔ logged”的工程约束。

### 11.3 真实 provider smoke tests

- [x] MiniMax：简单回答、reasoning、usage。
- [x] DeepSeek：简单回答、reasoning、usage。
- [x] OpenAI-compatible：无 reasoning 降级路径（DeepSeek V4 thinking-disabled live smoke）。
- [x] provider 不支持流式 usage 时仍能正常完成请求（录制 HTTP provider 合同）。
- [x] 对比日志中的 system/tools 与实际请求 body。

### Phase 6 验收

- [x] 仓库中不存在旧 Agent Event 兼容实现。
- [x] 新会话从创建、流式生成到完成可以完整重放。
- [x] 文档、类型、Runtime 和 UI 使用同一术语。
- [x] 所有无凭证条件下可执行的必需门禁通过。

## 12. 场景验收矩阵

| 场景 | Event | Conversation | Activity | Stats | Visual |
| --- | --- | --- | --- | --- | --- |
| 简单 hello | [x] | [x] | [x] | [x] | [x] |
| 无 reasoning | [x] | [x] | [x] | [x] | [x] |
| 流式 reasoning | [x] | [x] | [x] | [x] | [x] |
| 单工具调用 | [x] | [x] | [x] | [x] | [x] |
| 多工具调用 | [x] | [x] | [x] | [x] | [x] |
| retry 后成功 | [x] | [x] | [x] | [x] | [x] |
| provider error | [x] | [x] | [x] | [x] | [x] |
| cancel/interrupted | [x] | [x] | [x] | [x] | [x] |
| max tokens | [x] | [x] | [x] | [x] | [x] |
| partial history | [x] | [x] | [x] | [x] | [x] |
| pagination prepend | [x] | [x] | [x] | [x] | [x] |
| compaction | [x] | [x] | [x] | [x] | [x] |
| 完整 cache usage | [x] | [x] | [x] | [x] | [x] |
| usage 缺失 | [x] | [x] | [x] | [x] | [x] |

## 13. 建议提交拆分

### Commit 1：基线与协议

- [ ] 确定性 fixture 与 before 证据。
- [ ] Event v4。
- [ ] 新存储命名空间。
- [ ] 删除旧版本读取。
- [ ] Rust/TypeScript 序列化测试。

### Commit 2：Runtime 与 Provider

- [ ] Prompt assembler。
- [ ] context provenance。
- [ ] reasoning/text/tool/usage streaming 规范化。
- [ ] provider adapter tests。

### Commit 3：投影模型

- [ ] Chat/Activity 分离。
- [ ] 新 conversation node union。
- [ ] stable key 与 partial history 规则。
- [ ] projection tests。

### Commit 4：UI 与统计

- [ ] Turn Process。
- [ ] semantic renderers。
- [ ] StatsLine。
- [ ] locale、accessibility 和组件测试。

### Commit 5：视觉与清理

- [ ] Playwright visual suite。
- [ ] CSS 对齐。
- [ ] live smoke tests。
- [ ] dead code 和旧测试删除。
- [ ] 文档与最终门禁。

## 14. 测试门禁

每个 Commit 至少运行其直接相关测试；最终合并前运行：

```bash
pnpm test:ai:phase3
pnpm test:ai:phase4
pnpm test:ai:phase5
pnpm test:ai:phase6
pnpm test:agent:runtime
pnpm test:scripts
pnpm test
pnpm build
pnpm benchmark:ai-panel
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features --no-fail-fast
git diff --check
```

补充门禁：

- [x] 新增 Playwright 视觉回归命令并纳入最终门禁。
- [x] `pnpm test:agent:providers:live` 在具备密钥时完成 MiniMax/DeepSeek smoke。
- [x] 5,000 节点 projection 和 streaming benchmark 无明显退化。
- [x] Rust clippy 无 warning。
- [x] TypeScript 无死分支、无未使用兼容类型。

## 15. 最终 Definition of Done

### 协议与 Runtime

- [x] 新协议是唯一可执行和可读取的 Agent 事件合同。
- [x] 每个模型可见输入都有持久事件证据。
- [x] reasoning、tool calls、usage 和时间均由 Runtime 结构化。
- [x] 旧会话不加载，代码中没有兼容读取路径。

### 投影与 UI

- [x] Conversation 与 Activity 职责清晰且来自同一事件窗口。
- [x] Conversation 不再显示重复生命周期 marker。
- [x] Turn Process 的展开、流式和完成折叠行为与目标一致。
- [x] 最终回答始终可读，统计口径可追溯。
- [x] 保留唯一 MessageScroller 和现有 shadcn primitives。

### 质量

- [x] fixture 场景矩阵全部通过。
- [x] 视觉矩阵全部通过。
- [x] MiniMax 与 DeepSeek live smoke 通过。
- [x] accessibility、locale、light/dark、reduced-motion 通过审计。
- [x] 全量 TypeScript、Vitest、Vite、Rust fmt/clippy/test 门禁通过。
- [x] 实现结果与本文档同步更新，不保留已完成但未勾选或未完成却已勾选的项目。

## 16. Phase 6 最终证据审计（2026-09-03）

- 清理：`rg` 仅在拒绝/缺失断言和 Phase 0 before 证据中找到旧版本或 lifecycle marker 字样；生产 union、renderer、兼容别名、UI `<think>` parser 和旧 benchmark payload 已删除。
- 合同：Rust/TypeScript v4 round-trip、v2/v3 硬拒绝、`sessions-v4`/`archives-v4` 隔离、prompt/tools 与实际 request body 一致性测试通过。
- 场景：`src/test/fixtures/__tests__/agent-session-phase6-matrix.test.ts` 对上表 14 行逐行验证 Event、Conversation、Activity、Stats，并绑定 visual scene。
- 视觉：18 个 Playwright 场景的像素与语义 DOM 矩阵连续两次通过；新增场景均按单场景、带原因方式建立基线。
- 性能：5,000 节点 restore/revision，以及 5,000 节点窗口 20 次 streaming 重投影 benchmark 通过。
- 全量门禁：Vitest 162 files / 1380 tests、scripts 29 tests、Vite build、Rust fmt、clippy `-D warnings`、Rust 461 unit + 5 contract probe、`git diff --check` 均通过。
- Live smoke：`pnpm test:agent:providers:live` 真实执行 MiniMax-M2.7 reasoning、DeepSeek-V4-Flash reasoning，以及 DeepSeek-V4-Flash thinking-disabled OpenAI-compatible 降级（3 executed / 1 optional skipped）。reasoning 路径验证非空回答、结构化 reasoning 与 provider usage；禁用 thinking 的路径验证非空回答、无 reasoning 与 usage。独立 Generic OpenAI-compatible Base URL/Model 未配置，因此可选扩展 smoke 保持 SKIP；不支持流式 usage 的必需行为由录制 HTTP provider 合同验证请求不发送 `stream_options` 且仍正常完成。
