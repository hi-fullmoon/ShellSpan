# ShellSpan AI 面板 DeepSeek Harness 化实施记录

> 状态：Phase 0–7 已实施，V2 为唯一生产入口<br>
> 完成日期：2026-09-03<br>
> 应用版本：2.1.0<br>
> 范围：ShellSpan 桌面端右侧 AI 面板与 Agent Runtime v3 合同

## 1. 完成结论

ShellSpan 保留了右侧 320–720px AI 外壳，面板内部已切换为统一 Workspace：Ask 与 Agent
共享会话 Header、稳定节点对话流、Composer、错误恢复和历史入口，业务差异只存在于 adapter。
Agent 仍由 Rust Runtime 独占执行、审批和 committed event log；React 不执行工具，也不保存第二份
Agent 业务状态。

`AiPanel` 现在直接装配 `AiWorkspaceController`。旧 `LegacyAiPanelContent`、`aiPanelV2`、content
selection/test injection seam、旧 Agent Conversation/Tool/Approval UI 和旧会话弹窗已删除。这里没有保留
“以后再接”的 V1 生产树。

Ask 暂不迁移到 Agent Runtime。双 adapter 是当前正式边界，不是双写：

- Ask adapter 读取现有 `aiStore`/AI stream，并保持只读工具语义；
- Agent adapter 读取 Rust Runtime snapshot 与 committed events；
- 两者只共享 `AiSessionView`、`AiConversationNode` 和 Composer intention 合同。

## 2. 不可变外壳

[`ai-panel.tsx`](../src/components/ai/ai-panel.tsx) 只负责：

- TitleBar 已有 open/close store wiring；
- desktop 右侧 `aside`；
- compact viewport 的已安装 `Drawer`；
- 默认 400px、最小 320px、最大 720px；
- 至少保留 480px 主内容宽度；
- `shellspan.aiPanelWidth` 恢复与延迟持久化；
- pointer capture + `requestAnimationFrame` resize；
- ArrowLeft/ArrowRight 每次 24px，以及 Home/End；
- resize separator 的 accessible name、orientation、min/max/now。

发送、投影、审批、Queue mutation、rename、历史和详情均不在该文件中。320、400、720、窗口不足、
pointer、keyboard、desktop aside 与 compact Drawer 由 `ai-panel.test.ts` 和
`ai-panel-characterization.test.tsx` 锁定。

## 3. 当前前端边界

```text
AiPanel shell
  └─ AiWorkspaceController
      ├─ useAiSessionController      UI intention / optimistic reconcile / route
      ├─ AskSessionAdapter           aiStore + Ask stream
      └─ AgentSessionAdapter         committed Runtime client
          ├─ conversation-projection stable keyed nodes
          └─ agent-session-projection Activity only

AiWorkspaceRoot
  ├─ conversation | sessions | toolDetails | artifactDetails
  ├─ MessageScroller (唯一滚动 owner)
  └─ AiComposerSeat
      ├─ Queue Dock
      ├─ Approval takeover
      ├─ Ask/Agent preset
      ├─ Agent permission selector
      └─ provider/model settings entry
```

关键文件：

- `src/components/ai/ai-panel.tsx`：不可变外壳与 V2 唯一入口；
- `src/components/ai/workspace/`：Workspace、Composer、Session Browser、Queue、Approval、Details；
- `src/lib/ai/session-adapter.ts`：统一可见合同；
- `src/lib/ai/ask-session-adapter.ts`：Ask 正式 adapter；
- `src/lib/ai/agent-session-adapter.ts`：Agent Runtime adapter；
- `src/lib/ai/conversation-projection.ts`：Ask/Agent 稳定 keyed nodes；
- `src/lib/ai/composer-machine.ts` 与 `submission-policy.ts`：纯状态机和 Queue/Steer 策略；
- `src/lib/agent-session-client.ts`：subscribe-first、buffer merge、gap backfill/full resync；
- `src-tauri/src/agent_runtime/`：唯一 Agent 执行架构与 v3 event contract。

## 4. Phase 0–7 结果

| Phase | 已完成结果 | 主要证据 |
| --- | --- | --- |
| 0 | 冻结宽度、resize、aside/Drawer、Ask/Agent 事件 fixtures。像素截图没有作为发布判据；可重复的 semantic DOM/component characterization 是当前基线 | `ai-panel.test.ts`、`ai-panel-characterization.test.tsx`、`src/test/fixtures/` |
| 1 | Shell 与业务内容分离；迁移期 seam 已在 Phase 7 删除 | `AiPanelShell`、`AiPanelResizeHandle` |
| 2 | Ask/Agent adapter、统一 view/node union、稳定 renderer map；无 Agent 双写 | `src/lib/ai/`、projection tests |
| 3 | Hero/Active、Conversation/Activity、常驻 Composer、三档 container density、单运行指示 | `test:ai:phase3` |
| 4 | Composer reducer、IME/快捷键、detached draft、Queue/Steer/Stop、optimistic reconcile 与失败恢复 | `test:ai:phase4` |
| 5 | Approval takeover、Session Browser、Tool/Artifact details、Activity、route return focus/anchor、lazy artifact | `test:ai:phase5` |
| 6 | v3 `clientSubmissionId`、Inbox update/remove/reorder、session rename、revision conflict、commit-before-publish、v2/v3 read compatibility | `test:ai:phase6`、Rust session tests |
| 7 | V2 唯一默认入口；删除 Legacy/flag/旧 UI；恢复权限和设置的真实入口；文档、性能诊断与全量门禁收口 | 本文与最终质量门 |

## 5. 会话、Composer 与安全语义

- 新会话可选择 Ask/Agent，首次成功提交后 preset 锁定；切换类型会创建另一会话边界。
- Ask 与 Agent 使用同一 `AiComposerSeat`。
- idle/new 的 Enter 启动；running Agent 的普通 Enter 使用 busy preference（默认 next turn），
  Ctrl/Cmd+Enter 使用相反策略（默认 next safe step）。Shift+Enter 换行，IME composing/229 不提交。
- running 且空草稿时主动作是 Stop；Stop 等待 committed terminal event，而不是用命令返回伪造终态。
- detached payload 允许提交中继续输入；相同 operation 不会重复发送。失败草稿保留、可修改和重试。
- Agent v3 用 `clientSubmissionId` reconcile；Ask adapter 保留有时间窗的内容匹配，因为它不是 Runtime
  event producer。这是 adapter 边界，不是 Agent 兼容降级。
- Queue 编辑、删除、同 lane 重排和 rename 都带 `expectedRevision` 与 `clientOperationId`。UI 在 committed
  mutation/rename event 到达前不宣称完成；冲突会 refresh 并保留 retry surface。
- Approval 由 committed projection 派生并接管 Composer seat；目标、意图、effect、风险在主面板可见，
  完整参数、输出、evidence 与 approval metadata 在面板内详情 route 查看。React 不生成 approval authority。
- Agent 权限选择仍在 V2 Composer 可达；Full access 继续需要显式确认，断线后恢复 Request approval。

## 6. 滚动、详情与订阅生命周期

- `MessageScroller` 是唯一消息滚动 owner；Workspace 没有第二套 scroll listener/ResizeObserver。
- near-bottom follow、用户脱离跟随、jump-to-latest 由 primitive 管理；prepend 使用首个可见 node key +
  offset 恢复。
- session/tab/route anchor 分离；Tool/Artifact 返回恢复来源节点焦点。
- Artifact body 进入详情 route 后才读取；Tool JSON 不在主列表预渲染。
- Agent adapter 取消 UI subscription 时只 disconnect committed-event client，不调用 Runtime stop；后台任务继续。
- committed client 先订阅、再 snapshot/backfill、再合并 buffered frames；gap 做 bounded backfill 或 full resync。
- v2 历史继续可读；v3 mutation event 不允许伪装成 v2 envelope；旧 v1 Agent 导入保持只读。

## 7. 可访问性与样式

- Header、tabs、conversation log、Composer、Approval 和详情均有 landmark/role/name。
- icon-only 按钮有 `aria-label` 与 Tooltip；Drawer 有 `DrawerTitle`；确认弹层有 title/description。
- 运行状态只保留一个 `aria-live` 指示，不逐 token 朗读。
- 状态同时使用图标/文字，不只依赖颜色；审批不会默认聚焦批准按钮。
- streaming reconcile 与 route return 不丢失 Composer/来源动作焦点。
- 样式只使用 ShellSpan/shadcn primitives、semantic token、`gap-*` 与 container query；没有第二套颜色系统。
- motion 使用现有 primitive，CSS reduced-motion 全局规则继续生效；没有 AI 专用强制 shimmer。

shadcn CLI 在本机 Node 26 环境会被 MCP SDK 对 Zod `./v3` 子路径的
`ERR_PACKAGE_PATH_NOT_EXPORTED` 阻断。本阶段按既定例外直接核对 `components.json` 和本地 Base UI
primitives；未修改依赖，也未创建平行组件库。

## 8. 性能诊断

可重复命令：

```bash
pnpm benchmark:ai-panel
```

2026-09-03 本机开发态 Vitest microbenchmark 结果：

| 场景 | mean |
| --- | ---: |
| 5,000 条 Ask 消息恢复为稳定节点 | 1.4933 ms |
| 5,000 节点 memo revision 计算 | 0.2642 ms |
| 20 次 streaming revision | 0.0019 ms |

这是相同机器、相同进程内的投影/memo 微基准，不是端到端渲染 SLA。组件测试另行证明：20 次当前
assistant 更新只重渲染该节点，不重渲染历史 user node；50 个 tool nodes 的参数 sentinel 不进入主对话
DOM；Artifact body 只在详情 route 加载。`MessageScrollerItem` 保留 `content-visibility: auto` 和
intrinsic-size containment。

## 9. Feature flag、迁移与回滚

最终状态没有运行时 AI 面板 feature flag，也没有可回退的 V1 React 树。本任务是本地 Phase 0–7
收口，没有可观测的外部“稳定发布周期”，因此不声称观察过不存在的生产周期。

迁移规则：

- `shellspan.aiPanelWidth` key/语义不变；
- Agent Session 不迁移，V2 直接回放现有 committed log；
- v2/v3 event logs 按版本兼容读取，新写入使用 v3；
- Ask 继续读取已有本地 conversation/message 数据；
- UI route/draft/anchor 不是 Agent 业务事实，丢失时安全回默认。

回滚由 Git 与版本化应用发布承担：回到经过验证的版本，而不是在进程内切换 Legacy UI 或 Runtime。
若目标版本不理解 v3 mutation event，应阻止不兼容降级或先使用明确支持 v3 只读的版本；不得改写
现有 event log。

## 10. Definition of Done 审计

### 外壳

- [x] 主工作区右侧 `aside`，compact 为 Drawer。
- [x] 320–720px、默认 400px、主内容 480px。
- [x] pointer+rAF、keyboard 24px、Home/End、持久化和窗口约束有自动化测试。
- [x] TitleBar open/close store wiring 未改，V2 close 动作调用同一 store。

### 对话体验

- [x] hero、active、running、waiting approval、failed、cancelled/completed 有明确 projection/layout。
- [x] Hero→Active 的 Composer textarea DOM identity 与焦点有组件测试。
- [x] user/assistant/reasoning/tool/artifact/approval/marker/retry/error 使用稳定 keyed union。
- [x] 一个 Turn 只显示一个 running indicator。
- [x] follow/detach/jump、prepend anchor、route return focus/anchor 有组件测试。

### Composer

- [x] Ask/Agent 共用一个 Composer；preset 首次提交后锁定。
- [x] idle/running/waiting/submitting/recovering 状态机为 table-driven tests。
- [x] Queue/Steer/Stop 动作和 locale 文案一一对应。
- [x] optimistic success 不重复，失败/timeout 恢复；Agent v3 id 可精确 reconcile。
- [x] IME、229、Shift+Enter、Ctrl/Cmd+Enter、repeat/连续提交有测试。

### Agent 安全与一致性

- [x] React 不执行工具、不生成 approval authority。
- [x] Agent 业务状态只来自 committed event log；Activity 与 Conversation 使用同一 event window。
- [x] terminal event 提交后才接受 terminal UI。
- [x] Queue/rename 是 Runtime mutation，revision conflict 可见，commit-before-publish 有 Rust 测试。
- [x] UI unsubscribe 不停止后台 Runtime。

### 工程质量

- [x] `ai-panel.tsx` 只保留 Shell 与 V2 controller 装配。
- [x] 无 Legacy 生产引用、无 `aiPanelV2`、无 content selection seam。
- [x] 无第二 Agent store/log、无第二滚动系统、无平行颜色系统。
- [x] locale-owned copy、icon accessible names、Drawer/Dialog title、reduced-motion 约束已审计。
- [x] 5,000/50 tools/20 streaming 有可重复诊断或组件证据。
- [x] TypeScript/Vitest/Vite/Rust fmt/clippy/test/diff gates 作为 Phase 7 最终门执行。

原基线中“V1 清理前保留一个稳定发布周期”不适用于这次没有外部发布观测面的本地实现任务。它由
Phase 0–6 分阶段门、Phase 7 完整回归和 Git/版本发布回滚替代；没有保留死 V1 树来伪造回滚能力。

## 11. 明确暂缓（P2 / 单独评审）

以下事项没有在本阶段实现，也不由占位 UI 暗示已实现：

- Ask 是否迁移到 capabilityless Agent Runtime；
- 任意附件的上传、权限、生命周期和保留合同；
- User Question / Plan Review 一等事件；
- 更广泛的 Runtime/Ask 统一或旧 Ask 数据迁移。

Queue mutation、rename 与 `clientSubmissionId` 已在 Phase 6 实现，不再属于暂缓项。

## 12. 最终验证命令

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
cargo +stable-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/x86_64-pc-windows-msvc --all-features --no-fail-fast
git diff --check
```

Windows 默认 GNU/Strawberry/MinGW 路径若再次出现 `export ordinal too large`，保留默认命令的完整
链接器证据，并用已安装 MSVC toolchain 运行同等 `--all-features --no-fail-fast` 全量测试。该注记只
描述本机工具链故障，不把它误报为代码失败或默认命令通过。
