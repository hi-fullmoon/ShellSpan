# Deployment Workflow 图编辑器与本地部署 UI 重构计划

> 状态：Ready for implementation
> 日期：2026-09-17
> 实施方式：严格串行；每个阶段新建一个独立 Codex 会话窗口
> 适用范围：ShellSpan 本地部署中心前端
> 依赖基线：Deployment Workflow v3 已收口后的正式 `DeploymentWorkflow*` 类型与入口

## 1. 结论

本次重构采用 `@xyflow/react` 替换现有手写 SVG、绝对定位与 Pointer Event 画布，并把本地部署中心改造成由边框分隔的连续工作区。部署中心页面主体不再使用 Card 风格；工作流列表、工具栏、画布、配置区、运行列表、运行详情和版本列表通过 `border`、`Separator`、可调整分栏与独立滚动区建立层级。

重构只改变前端投影、交互和布局，不改变 Deployment Workflow v3 的协议、native node catalog、编译器、审批、执行、恢复或审计边界。节点输入 binding 继续是语义真相；React Flow edge 只能由 binding 投影，不能成为第二份持久化状态。

计划分为六个阶段：

```text
阶段 0 视觉与交互契约、基线测试
  → 阶段 1 React Flow 适配层与 Store 原子操作
    → 阶段 2 设计态画布替换
      → 阶段 3 无 Card 工作台壳层与响应式布局
        → 阶段 4 准备、运行、版本与覆盖层重构
          → 阶段 5 全量验证、视觉证据与文档收口
```

阶段不可并行。每个阶段必须在新的会话窗口中完成实现、验证和交接；下一阶段先复核上一阶段的退出条件和 `git status --short`，不得依赖未完成的口头约定。

## 2. 当前基线与问题

### 2.1 权威代码位置

- `src/components/workbench/deployment-workflow-center.tsx`：设计页、工作流列表、节点库、配置区、手写画布、窄屏拓扑列表和页面壳层；当前约 1047 行。
- `src/components/workbench/deployment-workflow-runtime.tsx`：准备、审批、运行、证据、Artifact、版本和回滚体验；当前约 903 行。
- `src/lib/deployment/editor.ts`：模板、edge 投影、兼容输出、拓扑顺序和本地校验。
- `src/lib/deployment/types.ts`：工作流、布局、端口、运行投影和 Artifact 类型。
- `src/stores/deploymentWorkflowStore.ts`：语义草稿、布局草稿、选择、连接、移动、校验和保存。
- `src/stores/deploymentWorkflowRunStore.ts`：运行、节点、attempt、事件、Artifact 和 Release 投影。
- `src/test/deployment-workflow-page.tsx`：宽、中、窄、AI 挤压和运行视图的视觉夹具。
- `docs/design/evidence/deployment-workflow-phase4/` 至 `phase6/`：重构前视觉与交互基线。

### 2.2 当前主要问题

1. 画布自行计算尺寸、绘制 SVG 贝塞尔线并处理 Pointer Capture，无法自然支持端口拖拽连接、edge 重连、缩放、平移、框选、适配视图和自动聚焦。
2. 节点移动在 Pointer Move 中直接写 Zustand，拖动期间会高频重建完整 draft 和 layout。
3. 页面主体、侧栏、节点、运行节点、审批分组和 Artifact 分组大量嵌套 Card，边框、圆角、留白和标题层级重复。
4. 运行页以节点 Card 网格表示 DAG，无法直观看出真实依赖关系，也不能和设计态共享同一投影。
5. `deployment-workflow-center.tsx` 和 `deployment-workflow-runtime.tsx` 体积过大，布局、领域投影、交互和覆盖层耦合。
6. 历史回归测试仍断言 `CardAction`，与新的“部署页面不使用 Card 风格”要求冲突，需要迁移为区域、工具栏和焦点语义断言。

## 3. 固定产品与技术决策

### 3.1 不变的领域边界

- `DeploymentWorkflowDefinition.nodes[*].inputs` 是唯一连接真相。
- React Flow edges 每次从 input bindings 投影；不在组件、Store 或数据库中增加独立 edge 状态。
- 节点位置来自 `DeploymentWorkflowLayout.nodes`。
- 节点移动只产生 layout dirty；连接、重连、断开、增删节点和修改参数产生 semantic dirty。
- native validator 继续是最终权威；前端连接检查只负责即时反馈。
- 运行只消费 native compiler 生成的 immutable plan，不从 React Flow 图解释或逐节点调用 effectful IPC。
- 不新增任意 Shell、任意 SSH、脚本节点或绕过审批的入口。

### 3.2 `@xyflow/react` 使用方式

- 计划基线版本为 `@xyflow/react@12.11.6`；阶段 1 开始时重新读取 npm registry，若版本已变化，只允许升级到经过 API 和回归验证的新版本，并在交接中记录理由。
- 依赖使用精确版本，`pnpm-lock.yaml` 同步更新。
- 只引入 `@xyflow/react/dist/base.css`，不采用默认节点/Card 主题；视觉由 ShellSpan semantic token 控制。
- 使用 controlled `nodes`/`edges` 投影，但拖动中的临时坐标留在画布适配层，只在 `onNodeDragStop` 或多选拖动结束后批量提交 Store。
- 每个端口使用稳定 Handle ID：`input:<portName>` 与 `output:<portName>`。
- 设计态允许连接和选择；运行态复用投影和节点骨架，但禁用拖拽、连接、删除和重连。
- `nodeTypes`、`edgeTypes`、事件函数和默认配置必须保持稳定引用；自定义节点使用 `React.memo`。
- viewport 是个人 UI 状态，首轮只保留在当前会话或按 workflow ID 保存到前端 UI 状态，不写入语义定义，也不因缩放触发保存按钮。

### 3.3 “不使用卡片风格”的边界

部署中心范围内不得把 Card 作为布局、分组或信息展示容器：

- 页面主体不得导入或渲染 `Card`、`CardHeader`、`CardContent`、`CardAction` 等组件。
- Dialog、Drawer 内部也改用语义 heading、Field、Table、ScrollArea、Separator 和紧凑列表，不嵌套 Card。
- 节点必须有可识别边界，但它是图节点块而不是 Card：无阴影、无抬升层级、紧凑内边距、细边框、轻量圆角，并明确显示输入/输出 Handle。
- 状态和风险使用现有 Badge/Alert 变体与 semantic token，不硬编码颜色或手写暗色覆盖。
- 空态、加载态、Toast、确认操作继续使用现有 Empty、Skeleton/Spinner、sonner/Toast Store 和 Dialog/AlertDialog 语义。
- 不修改部署中心以外页面的 Card 使用。

## 4. 目标信息架构与布局

### 4.1 宽容器

```text
WorkbenchPageHeader
┌──────────────────────────────────────────────────────────────────┐
│ 设计｜准备发布｜运行记录｜版本         校验  刷新  新建  保存 │
├──────────────┬──────────────────────────────────┬────────────────┤
│ 工作流列表    │ 画布工具栏                        │ 节点配置        │
│ 搜索/状态     ├──────────────────────────────────┤ 输入与参数      │
│ 最近运行      │                                  │ 风险与能力      │
│              │         React Flow 画布           │                │
│              │                                  │                │
├──────────────┴──────────────────────────────────┴────────────────┤
│ 校验问题 / 草稿状态 / 当前选择                                  │
└──────────────────────────────────────────────────────────────────┘
```

- 左栏建议 224–260px，右栏建议 300–360px，中部占剩余宽度。
- 使用现有 Resizable primitive；分隔线本身承担区域边界，不再用 `gap-3` 隔开面板。
- 工作流列表在四个 Tab 中保持可达，避免切换到运行或版本后失去工作流上下文。
- 节点库不长期占据半个左栏；使用工具栏入口打开可搜索 Drawer，或在左栏通过紧凑分段切换工作流/节点库。

### 4.2 中等容器与 AI 面板挤压

- 主区域只保留画布或当前业务视图。
- 工作流列表、节点库和配置区使用带固定标题的 Drawer。
- Header 操作区保持单行，搜索框使用 `min-w-0 flex-1`。
- 所有断点以 `WorkbenchPage` container query 为准，不使用 viewport `sm`/`lg` 代替。

### 4.3 窄容器

- 不渲染需要横向拖动的无限画布，使用拓扑顺序的紧凑行列表。
- 每行用上下 Separator 区分，不使用 Card。
- 节点行显示名称、执行域、状态、上下游数量和配置入口。
- 输入 binding 继续使用可读 label 的 Select；配置在 Drawer 中完成。
- 窄屏列表必须能够完成添加、删除、连接、断开、参数修改、校验和保存，是画布的完整键盘/触摸替代界面。

### 4.4 运行视图

宽容器采用：

```text
┌ 运行列表 ┬────────────── 只读 DAG ──────────────┬ 节点详情/时间线 ┐
│ 状态/时间│ 节点状态、进度、当前执行路径          │ attempt/evidence│
└──────────┴──────────────────────────────────────┴─────────────────┘
```

- 运行图复用设计态 flow projection 和节点骨架，不再使用节点 Card 网格。
- `state_unknown`、运行中、等待审批等持续状态继续使用上下文 Alert。
- 节点详情、attempt、日志预览、receipt、evidence 和 Artifact 入口放入右侧检查器。
- 中窄容器将检查器切换为 Drawer；运行列表在窄屏位于顶部或独立 Drawer。

## 5. 目标组件与模块边界

计划拆分为以下结构；阶段实施可根据现有依赖微调文件名，但不得重新合并为单个超大组件：

```text
src/components/workbench/deployment/
  deployment-workspace-shell.tsx
  deployment-workflow-tabs.tsx
  workflow-list-pane.tsx
  workflow-editor-toolbar.tsx
  workflow-canvas.tsx
  workflow-node.tsx
  workflow-topology-list.tsx
  node-library-drawer.tsx
  node-inspector.tsx
  validation-status-bar.tsx
  runtime-workspace.tsx
  runtime-flow.tsx
  runtime-node-inspector.tsx
  release-list.tsx
  approval-dialog.tsx
  artifact-drawer.tsx
  evidence-dialog.tsx

src/lib/deployment/
  flow-projection.ts
  flow-connection.ts
```

约束：

- `flow-projection.ts` 是无 React、无 Store 的纯函数模块。
- `flow-connection.ts` 负责 Handle 解析、端口兼容、自连接、目标输入占用和本地环路检查。
- 组件通过明确 props 或窄 Zustand selector 读取状态，不在每个节点中订阅完整 draft。
- `deployment-workflow-center.tsx` 最终只负责编排页面级状态、Tab 和覆盖层。
- `deployment-workflow-runtime.tsx` 最终只保留兼容导出或薄编排；若无需兼容导出则删除。
- 不创建 `src/lib` 根级 barrel。

## 6. 会话与阶段执行规则

每个阶段必须遵循以下流程：

1. 新建独立 Codex 会话窗口，标题使用本计划规定的会话名。
2. 首先完整阅读仓库 `AGENTS.md`、本计划、上一阶段交接和本阶段直接涉及的源文件。
3. 运行 `git status --short`，记录进入会话前已有改动；不覆盖或格式化无关变更。
4. 复核运行上一阶段退出门禁；失败时先修复或明确停止，不带失败进入下一阶段。
5. 只实施本阶段范围，不预先夹带下一阶段的大规模重构。
6. 新行为先补纯函数或 Store 回归测试，再切换 UI。
7. 每次编辑使用现有 shadcn primitives 和设计 token；需要使用具体 shadcn 组件时先通过项目 package runner 查看当前 docs。
8. 会话结束前运行本阶段全部验证，更新交接记录；除非用户明确要求，不创建 commit、tag 或 push。
9. 下一阶段只依赖仓库代码、测试结果和书面交接，不依赖上一个会话的隐式上下文。

## 7. 阶段 0：视觉契约、行为基线与测试护栏

### 会话名

`部署工作流 UI 重构 0：契约与基线`

### 目标

在修改实现前固化新的无 Card 布局、React Flow 数据边界和必须保持的业务行为，使后续阶段有可执行、可测试的验收依据。

### 实施范围

- 更新 `docs/design/deployment-center-workflow-design.md` 的编辑器布局、节点展示和运行视图章节：
  - 移除“同级 Card gap-3”和“节点卡片”表述；
  - 写明连续分栏、边框隔离、紧凑密度和运行态只读 DAG；
  - 写明 React Flow 只是投影和交互层。
- 保留 Phase 4–6 旧截图与验收文档作为历史基线，不覆盖原图、不修改旧结果。
- 在现有视觉夹具中补充稳定的 test id 和场景参数，为后续截图复用；不在本阶段改视觉。
- 新增或调整测试，锁定以下业务行为：
  - 输入 binding 是 edge 真相；
  - 移动节点只使 layout dirty；
  - 连接和断开使 semantic dirty；
  - 保存后 revision/layoutRevision 行为保持不变；
  - 窄屏拓扑列表与画布使用同一节点和 binding 数据；
  - 运行、审批、Artifact、回滚和 Toast 现有行为不回退。
- 记录当前宽、中、窄、AI 挤压四种页面尺寸和 scroll ownership，作为阶段 5 对比基准。

### 预期改动

- `docs/design/deployment-center-workflow-design.md`
- `src/test/deployment-workflow-page.tsx`
- `src/components/workbench/__tests__/deployment-workflow-center.test.tsx`
- `src/components/workbench/__tests__/deployment-workflow-runtime.test.tsx`
- 必要时增加一份 `docs/design/deployment-workflow-xyflow-ui-refactor-acceptance.md` 骨架

### 验证

```bash
pnpm exec vitest run \
  src/lib/deployment/__tests__/editor.test.ts \
  src/stores/__tests__/deploymentWorkflowStore.test.ts \
  src/components/workbench/__tests__/deployment-workflow-center.test.tsx \
  src/components/workbench/__tests__/deployment-workflow-runtime.test.tsx
pnpm build
```

### 退出条件

- 新设计契约不存在 Card 风格歧义。
- 当前业务行为被测试固定，后续删除旧 UI 不会误删业务能力。
- 视觉夹具可稳定进入设计、准备、运行和版本场景。
- 相关测试与构建通过。

### 新会话启动提示

> 按 `docs/design/deployment-workflow-xyflow-ui-refactor-plan.md` 实施阶段 0。先检查工作区和当前 Deployment Workflow 测试，只完成视觉/交互契约、视觉夹具基线和行为护栏；不要安装 React Flow，不要开始替换画布。完成全部阶段 0 验证并按计划交接。

## 8. 阶段 1：React Flow 适配层与 Store 原子操作

### 会话名

`部署工作流 UI 重构 1：Flow 适配层`

### 目标

建立经过单元测试的数据投影、连接校验和原子 Store 操作，不切换生产画布。

### 实施范围

- 使用 pnpm 安装并精确锁定 `@xyflow/react`。
- 在 `src/styles/base.css` 的正确 layer 中引入 React Flow base CSS；不得引入默认主题 CSS。
- 实现 `flow-projection.ts`：
  - 由 definition、layout、catalog 和 selected ID 构造强类型 Flow nodes；
  - 由 input bindings 构造稳定 Flow edges；
  - edge ID 必须可逆映射到 source/output/target/input；
  - 缺失 catalog/layout 时提供安全投影，不修改领域定义。
- 实现 `flow-connection.ts`：
  - Handle ID 编解码；
  - 相同端口类型与 Artifact type 兼容；
  - 拒绝自连接、未知端口、输入/输出方向颠倒和新环路；
  - 一个目标 input 同时最多一个 binding；
  - 返回结构化失败原因，由 UI 映射 i18n。
- 扩展 `deploymentWorkflowStore`：
  - `moveNodes` 批量提交布局；
  - `disconnectInput`；
  - `reconnectInput` 原子替换旧、新 binding；
  - 必要的批量选择状态与 UI viewport 状态；
  - 保证 dirty、issues 和 revision 语义不变。
- 新增纯函数和 Store 单元测试，覆盖合法连接、类型错误、Artifact 不兼容、重复输入、环路、断开、重连和多节点移动。

### 禁止事项

- 不改 Rust、IPC 或协议类型。
- 不把 Flow Node/Edge 类型写进领域模型。
- 不把 edges 保存到 Zustand 或数据库。
- 不在拖动每一帧写 draft。
- 不删除旧 `WorkflowCanvas`。

### 验证

```bash
pnpm exec vitest run \
  src/lib/deployment/__tests__/editor.test.ts \
  src/lib/deployment/__tests__/flow-projection.test.ts \
  src/lib/deployment/__tests__/flow-connection.test.ts \
  src/stores/__tests__/deploymentWorkflowStore.test.ts
pnpm build
```

### 退出条件

- 相同 definition/layout 始终产生稳定 nodes/edges。
- 连接校验有结构化、可本地化的结果。
- 连接、断开和重连仅修改 input binding。
- 多节点移动只修改 layout 并且只提交一次 Store 操作。
- 新依赖、类型检查和测试全部通过；生产 UI 仍保持原状。

### 新会话启动提示

> 按 `docs/design/deployment-workflow-xyflow-ui-refactor-plan.md` 实施阶段 1。先复核阶段 0 交接与测试，只增加 `@xyflow/react`、纯投影/连接模块和 Store 原子操作；不要切换现有画布或重做页面样式。完成阶段 1 验证并交接。

## 9. 阶段 2：设计态画布替换

### 会话名

`部署工作流 UI 重构 2：React Flow 设计画布`

### 目标

用 React Flow 完整替换宽/中容器中的手写画布，同时保持窄屏拓扑列表和现有页面壳层暂时不变。

### 实施范围

- 新建 `workflow-canvas.tsx` 与 `workflow-node.tsx`。
- 自定义节点显示：
  - 可读名称、类型版本、执行域、副作用等级和问题状态；
  - 左侧输入 Handle、右侧输出 Handle；
  - 端口名称和类型提示；
  - 选中、校验错误、只读状态通过边框和语义 token 表示，不能只依赖颜色。
- 实现画布交互：
  - 选择节点并同步 Inspector；
  - 拖动和多选拖动，结束后批量提交位置；
  - 从输出 Handle 连接到输入 Handle；
  - 重连和删除 edge；
  - 连接过程中只高亮合法目标；
  - Fit View、放大、缩小和恢复视图；
  - 节点数量达到阈值时显示 MiniMap，少量节点不显示；
  - pane 点击清除选择，但不丢失未保存修改。
- 使用 `ariaLabelConfig` 提供中英文画布、控制器、Handle、节点和 edge 辅助文案。
- 禁止 React Flow 默认 Delete 行为绕过确认或 Store；删除节点继续走显式操作，删除 edge 走 `disconnectInput`。
- 删除旧 SVG、绝对定位、Pointer Capture、固定画布宽高和手写拖拽代码。
- 保持现有窄屏 `TopologyList` 为完整替代入口。

### 测试

- 节点与 edge 数量、Handle ID 和可读标签。
- 合法连接调用正确 binding；非法连接不写 Store 并显示原因。
- edge 删除与重连的原子行为。
- 拖动结束前不写 layout，结束后只提交一次。
- 节点选择、pane 清空、Fit View 和 keyboard focus。
- 画布与窄屏拓扑列表从同一 definition 投影。
- React Strict Mode 下不重复提交或重复 Toast。

### 验证

```bash
pnpm exec vitest run \
  src/lib/deployment/__tests__/flow-projection.test.ts \
  src/lib/deployment/__tests__/flow-connection.test.ts \
  src/stores/__tests__/deploymentWorkflowStore.test.ts \
  src/components/workbench/__tests__/deployment-workflow-center.test.tsx
pnpm build
```

### 退出条件

- 手写画布实现已完全删除。
- 用户能在画布完成选择、移动、连接、重连和断开。
- semantic/layout dirty 语义与重构前一致。
- 键盘可聚焦和移动节点，屏幕阅读器提示已本地化。
- 窄屏仍可独立完成所有编辑操作。

### 新会话启动提示

> 按 `docs/design/deployment-workflow-xyflow-ui-refactor-plan.md` 实施阶段 2。复核阶段 1 的投影、连接和 Store 测试，用 React Flow 完整替换设计态手写画布；保留当前页面壳层和窄屏拓扑列表，不提前重构运行页。完成阶段 2 验证并交接。

## 10. 阶段 3：无 Card 工作台壳层与响应式设计

### 会话名

`部署工作流 UI 重构 3：连续分栏工作台`

### 目标

完成本地部署页面主体的大幅视觉调整，把设计页和公共导航改造成紧凑、无 Card、边框隔离的连续工作区。

### 实施范围

- 拆分 `deployment-workflow-center.tsx`，建立第 5 节约定的设计态组件边界。
- 保持 `WorkbenchPageHeader` 默认 padding 和高度；将 Tabs、校验、刷新、新建、保存组织为紧凑操作区。
- 宽容器使用连续三栏与 Resizable：工作流列表 / 画布 / Inspector。
- 中容器隐藏常驻侧栏，使用 Drawer 打开工作流列表、节点库和 Inspector。
- 窄容器使用无 Card 的拓扑行列表；每行用 Separator、紧凑标题区和配置入口组织。
- 工作流列表、节点库和配置区移除 Card 包装：
  - 列表使用选中行、Badge 和独立滚动层；
  - 节点库按 category 分组并支持搜索；
  - Inspector 使用 FieldGroup/Field 和固定标题区；
  - 校验问题放到底部状态栏和 Dialog，不占用画布主体。
- 所有 Input、Select、Button 在同一操作行视觉等高；Select 继续显示同源 `{ value, label }`。
- 统一 scroll ownership：页面主体不出现横向滚动；列表、画布、Inspector 各自滚动。
- 删除部署设计页全部 Card import 和 Card DOM。

### 测试与实际渲染

- DOM 回归：设计页根节点内不存在 `[data-slot="card"]`。
- 宽容器存在三栏和两个可访问分隔手柄。
- 中容器 Drawer 标题、正文滚动和焦点返回正确。
- 窄容器拓扑行可完成 binding 和配置。
- Header 操作在 AI 面板压窄时不换成两行。
- 使用视觉夹具实测：
  - 宽：页面容器约 1418px；
  - 中：约 858px；
  - 窄：约 428px；
  - AI 挤压：约 778px；
  - 中文和英文各至少检查一个宽场景和一个窄场景。

### 验证

```bash
pnpm exec vitest run \
  src/components/workbench/__tests__/deployment-workflow-center.test.tsx \
  src/stores/__tests__/deploymentWorkflowStore.test.ts
pnpm build
pnpm check:ai-styles
```

### 退出条件

- 设计页主体不再使用 Card 风格。
- 宽、中、窄和 AI 挤压布局均无文档级横向溢出。
- 三栏、Drawer 和窄屏列表使用同一领域数据。
- 长 Inspector 的标题固定、正文独立滚动。
- 双语、焦点、空态、加载态、只读态和错误态通过检查。

### 新会话启动提示

> 按 `docs/design/deployment-workflow-xyflow-ui-refactor-plan.md` 实施阶段 3。复核阶段 2 画布功能，把部署设计页重构为紧凑的连续分栏工作台并移除设计页全部 Card；不要改运行、Artifact、审批和版本视图。完成阶段 3 测试与四种容器实际渲染后交接。

## 11. 阶段 4：准备、运行、版本与覆盖层重构

### 会话名

`部署工作流 UI 重构 4：运行与发布体验`

### 目标

让准备发布、运行记录、版本、审批、证据和 Artifact 与新的无 Card 工作台统一，并用只读 React Flow 展示实际运行 DAG。

### 实施范围

- 拆分 `deployment-workflow-runtime.tsx`，但保持其对外导出在阶段内可渐进迁移。
- 准备发布：
  - 使用标题栏、描述列表、能力 Badge、Alert 和底部主操作区；
  - 移除摘要 Card 和能力 Card；
  - 保留 semantic dirty、过期、drift、停用和 prepare progress 门禁。
- 运行记录：
  - 左侧紧凑运行列表；
  - 中部只读 `runtime-flow.tsx`，复用 flow projection 与节点骨架；
  - 右侧节点详情/时间线 Inspector；
  - 运行节点显示 status、duration、attempt、bounded progress 和 evidence gap；
  - 禁止在运行图中移动、连接、删除或修改节点。
- 版本：
  - 使用 Table 或分隔行展示 current、previous 和 retained Release；
  - 回滚入口保持创建新 rollback run、重新 prepare/approve/start 的语义。
- 覆盖层：
  - Approval Dialog 按用户语义分段，使用 heading + Separator，不用 Card；
  - Artifact Drawer 使用描述列表和组件 Table/行列表；
  - Evidence Dialog 使用输出、receipt 和日志分区；
  - 保持固定 Header/Footer、`min-h-0 flex-1` 和仅正文滚动；
  - 保持 Escape、初始焦点和返回触发按钮行为。
- 删除运行相关页面和覆盖层中的 Card import/DOM。

### 测试与实际渲染

- 运行图节点状态与 `DeploymentRunNodeRecord` 一致。
- 运行图严格只读，不暴露连接、拖动或删除处理器。
- 选择运行节点后 Inspector 展示正确 attempt、事件、Artifact 和 evidence。
- `state_unknown` 只提供 read-only reconciliation。
- 审批过期、plan drift、取消、回滚、Artifact retention 和审计导出行为保持。
- DOM 回归：部署中心设计、准备、运行、版本与覆盖层均不存在 `[data-slot="card"]`。
- 四种容器下实测 prepare、runs、versions；窄屏实测长审批、Artifact、Evidence 和回滚。

### 验证

```bash
pnpm exec vitest run \
  src/components/workbench/__tests__/deployment-workflow-center.test.tsx \
  src/components/workbench/__tests__/deployment-workflow-runtime.test.tsx \
  src/stores/__tests__/deploymentWorkflowRunStore.test.ts
pnpm build
pnpm check:ai-styles
```

### 退出条件

- 部署中心所有主视图和覆盖层均完成无 Card 重构。
- 设计态与运行态共享投影逻辑，运行态严格只读。
- 用户仍能完成准备、审批、执行、取消、reconcile、审计、查看 Artifact 和人工回滚。
- 宽、中、窄与 AI 挤压场景的滚动、焦点和布局通过。

### 新会话启动提示

> 按 `docs/design/deployment-workflow-xyflow-ui-refactor-plan.md` 实施阶段 4。复核阶段 3 工作台，重构准备、运行、版本及所有部署覆盖层，移除剩余 Card，并用只读 React Flow 展示运行 DAG。不得改变审批、执行、恢复和回滚语义。完成阶段 4 验证和实际渲染后交接。

## 12. 阶段 5：全量验证、视觉证据与收口

### 会话名

`部署工作流 UI 重构 5：验收与收口`

### 目标

完成回归、安全边界、性能、可访问性、视觉证据和文档验收，删除已无用途的兼容代码，使重构达到可合并状态。

### 实施范围

- 删除旧手写画布、旧 Card 专用 helper、已迁移兼容导出和无用 i18n key。
- 搜索并确认部署中心没有：
  - Card import/DOM；
  - 第二份 edge 持久化状态；
  - 裸 `invoke`；
  - viewport 变化触发 semantic dirty；
  - effectful 单节点调用；
  - 内部 ID/enum 作为主要用户文案；
  - 硬编码颜色、暗色覆盖或无 i18n 文案。
- 校验最大 64 节点、16 输入/输出条件下的交互性能：
  - 拖动过程中不持续写领域 Store；
  - 自定义 node/edge type 引用稳定；
  - 不因选择一个节点重渲染全部重型 Inspector 内容。
- 完成键盘测试：Tab 节点/edge、Enter/Space 选择、方向键移动、Escape 清理选择、Drawer/Dialog 焦点返回；窄屏替代路径完整。
- 使用现有视觉夹具生成新的证据目录：
  - `docs/design/evidence/deployment-workflow-xyflow-refactor/`
  - `design-wide.png`
  - `design-medium.png`
  - `design-narrow.png`
  - `design-ai.png`
  - `prepare-wide.png`
  - `runs-wide.png`
  - `runs-narrow.png`
  - `versions-wide.png`
  - `approval-narrow.png`
  - `artifact-narrow.png`
  - `evidence-narrow.png`
  - `rollback-narrow.png`
- 完成 `docs/design/deployment-workflow-xyflow-ui-refactor-acceptance.md`，记录尺寸、scroll ownership、焦点、测试结果、已知限制和与本计划的偏差。
- 更新主设计文档最终状态；旧 Phase 4–6 验收保持历史不变。

### 全量验证

```bash
pnpm test
pnpm build
pnpm check:rust:includes
pnpm check:ai-styles
pnpm check:llm:catalog
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm test:deployment:e2e
```

若真实 SSH/Docker 环境不可用，`pnpm test:deployment:e2e` 可以记录为未运行，但必须说明具体环境缺口；不得把缺少 E2E 环境写成“通过”。其余验证必须通过。

### 最终验收条件

- `@xyflow/react` 是设计态和运行态 DAG 的唯一画布引擎。
- 工作流 input bindings 仍是唯一连接真相。
- 部署中心主视图和覆盖层不存在 Card 风格。
- 语义 revision、布局 revision、审批失效和运行安全边界没有回退。
- 宽、中、窄、AI 挤压和长内容场景均有实际截图证据，无文档级横向溢出。
- 鼠标、触摸替代路径、键盘和屏幕阅读器文案可用。
- 所有必需验证通过，或对唯一允许缺失的环境型 E2E 给出明确记录。
- `git status --short` 中不存在不明改动；未创建 commit、tag 或 push，除非用户另行明确要求。

### 新会话启动提示

> 按 `docs/design/deployment-workflow-xyflow-ui-refactor-plan.md` 实施阶段 5。先逐项审计阶段 0–4 退出条件，再完成无用代码清理、全量测试、实际渲染、截图证据和验收文档。不要用窄测试代替计划中的全量门禁；缺少真实 E2E 环境时如实记录。完成后给出逐项验收结论和最终工作区状态。

## 13. 每阶段交接模板

每个阶段结束时，在会话最终回复和阶段交接记录中提供：

1. 阶段编号、会话名和完成状态。
2. 完成的交付物与主要文件。
3. 本阶段新增或改变的用户行为。
4. 与计划的偏差、原因和对后续阶段的影响。
5. 运行过的命令、测试数量与结果。
6. 未运行的验证及准确原因。
7. 实际渲染检查的容器尺寸、scroll ownership、横向溢出和焦点结果。
8. 已知风险、技术债和下一阶段必须继承的约束。
9. `git status --short`，区分进入会话前已有改动与本阶段改动。
10. 下一阶段的新会话启动提示，直接复制本计划对应段落。

## 14. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| React Flow nodes/edges 变成第二份领域状态 | 只允许纯函数投影；所有连接写回 input binding；单元测试验证往返 |
| 拖动导致 Zustand 高频更新 | 拖动中使用局部 Flow 状态，仅在 drag stop 批量提交 |
| edge 重连产生短暂非法图 | Store 提供原子 `reconnectInput`，不先断开再异步连接 |
| 删除节点绕过确认和依赖清理 | 禁用默认节点删除，统一走领域 Store 与确认 Dialog |
| React Flow 默认 CSS 破坏主题 | 仅引入 base CSS，使用 ShellSpan semantic token 和自定义节点 |
| 图功能在窄屏不可用 | 保留并升级完整拓扑列表，不把无限画布强塞入窄容器 |
| 运行图与真实运行不一致 | 运行图只消费 workflow definition + run node projection，不自行推断调度状态 |
| 大规模 UI 重构掩盖安全回退 | 每阶段只改前端；审批、effectful IPC、reconcile 和 rollback 回归测试持续运行 |
| 历史验收证据被误写 | 旧 Phase 4–6 文档和截图只读，新证据写入独立目录 |
| 多会话上下文丢失 | 严格退出门禁、书面交接、固定启动提示和每阶段重新检查工作区 |

## 15. 明确非目标

- 不修改 Deployment Workflow v3 schema、wire type、canonical digest 或数据库表。
- 不修改 Rust compiler、scheduler、executor、approval、reconciliation 或 compensation。
- 不新增节点类型、模板、systemd、Kubernetes、多主机或外部 Artifact Provider。
- 不引入自动布局引擎；首轮继续使用已保存位置和模板初始位置，Fit View 只调整 viewport。
- 不提供自由脚本、任意远程命令或用户自定义执行器。
- 不在本次重构中统一改造其他 Workbench 页面。
- 不创建 commit、tag、版本号或发布，除非用户另行明确要求。
