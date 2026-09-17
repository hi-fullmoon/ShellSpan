# Deployment Workflow React Flow UI 重构验收记录

> 状态：阶段 0–4 已完成，阶段 5 待实施
> 基线日期：2026-09-17
> 适用计划：[`deployment-workflow-xyflow-ui-refactor-plan.md`](./deployment-workflow-xyflow-ui-refactor-plan.md)

## 1. 阶段 0 契约

- 部署中心目标结构是无 Card 的连续分栏工作区；区域由边框、`Separator`、可调整分隔手柄和独立滚动层区分。
- `DeploymentWorkflowDefinition.nodes[*].inputs` 是唯一连接真相。设计态和运行态 edge 都由 binding 投影，不持久化第二份 edge 状态。
- 节点移动只修改 layout；连接、断开、增删节点和参数修改只按既有规则修改 semantic definition。
- 运行图是 native 运行投影的只读 DAG，不解释执行，也不暴露移动、连接、删除或重连入口。
- 审批、取消、reconciliation、Artifact retention、审计导出和人工回滚继续经过既有高层 coordinator 与 native 权限边界。
- 阶段 0 不安装 `@xyflow/react`，不替换手写画布，也不改变现有视觉。

## 2. 视觉夹具参数契约

入口：`?deploymentVisual=1`

| 参数 | 支持值 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `scenario` | `wide` / `medium` / `narrow` / `ai` | `wide` | 固定工作台容器基准 |
| `view` | `design` / `prepare` / `runs` / `versions` | `design` | 直接进入四个主视图 |
| `overlay` | `approval` / `artifact` / `evidence` / `rollback` | 无 | 打开阶段 5 需要复用的长内容覆盖层 |
| `locale` | `zh-CN` / `en-US` | `zh-CN` | 双语视觉检查 |

推荐覆盖层组合：

- `view=prepare&overlay=approval`
- `view=runs&overlay=evidence`
- `view=runs&overlay=artifact`
- `view=versions&overlay=rollback`

稳定定位点：`deployment-visual-fixture`、`deployment-visual-workbench`、`deployment-visual-ai-panel`、`deployment-workflow-canvas`、`deployment-topology-list`、`deployment-prepare-view`、`deployment-runs-view`、`deployment-versions-view`、`deployment-approval-dialog`、`deployment-artifact-drawer`、`deployment-evidence-dialog`、`deployment-rollback-dialog`。

## 3. 重构前视觉基线

历史 Phase 4–6 截图和验收文档保持只读，本计划不覆盖原图或改写旧结果。阶段 0 复测使用 Chromium、`1500 × 900` viewport，并测量工作台容器而非 viewport：

| 场景 | 目标页面容器 | 当前滚动归属 | 横向溢出基线 |
| --- | ---: | --- | ---: |
| 宽 | 1418 px | 页面主体固定；工作流列表、节点库、手写画布和 Inspector 各自滚动；画布拥有水平滚动 | 0 px |
| 中 | 858 px | 页面主体固定；手写画布滚动；工作流、节点库和 Inspector 进入 Drawer 正文滚动层 | 0 px |
| 窄 | 428 px | 页面主体纵向滚动；不渲染画布，拓扑列表随页面滚动；Drawer 正文独立滚动 | 0 px |
| AI 挤压 | 778 px | 与中等容器相同；右侧 AI 面板独立，不参与工作台滚动 | 0 px |

阶段 5 必须以同一组容器宽度复测新的连续分栏实现，并把新截图写入 `docs/design/evidence/deployment-workflow-xyflow-refactor/`；不得覆盖 `deployment-workflow-phase4/` 至 `phase6/`。

## 4. 阶段 0 行为护栏

| 行为 | 自动化护栏 |
| --- | --- |
| binding 是 edge 真相 | `src/lib/deployment/__tests__/editor.test.ts` |
| 移动只产生 layout dirty | `src/stores/__tests__/deploymentWorkflowStore.test.ts` |
| 连接与断开产生 semantic dirty | `src/stores/__tests__/deploymentWorkflowStore.test.ts` |
| 保存保持 revision/layoutRevision 分离 | `src/stores/__tests__/deploymentWorkflowStore.test.ts` |
| 画布与窄屏列表使用同一节点和 binding | `src/components/workbench/__tests__/deployment-workflow-center.test.tsx` |
| 审批、运行证据、Artifact、回滚与 Toast 不回退 | 两组 workbench 组件测试 |

## 5. 阶段验证日志

### 阶段 0：契约与基线

- 修改前定向门禁：4 个文件、17 个测试通过。
- 修改后定向门禁：4 个文件、19 个测试通过。
- `pnpm build`：通过；仅保留项目既有的 ineffective dynamic import 与 chunk size warning。
- `git diff --check`：通过。
- 实际渲染：Chromium `1500 × 900` 下测得页面容器分别为 1418 / 858 / 428 / 778 px，四种场景文档横向溢出均为 0 px。
- 宽容器滚动层实测为 254 px 工作流列表、254 px 节点库、784 px 画布和 318 px Inspector；画布 `scrollWidth=1160 / clientWidth=784`，水平滚动由画布承担。
- 中容器画布为 824 px，AI 挤压画布为 744 px；两者的 `scrollWidth` 均为 1160 px，侧栏不占据主区域。窄容器不显示画布，428 px 页面正文承担纵向拓扑列表滚动。
- 宽、中、AI 场景均能把键盘焦点放到图节点；窄场景能把焦点放到拓扑行的配置按钮。
- 覆盖层参数在 Chromium `430 × 800` 下直接打开成功：审批 `398 × 736`、Artifact `360 × 800`、证据 `398 × 704`、回滚 `398 × 480`；正文滚动层与 Footer 均可见，横向溢出均为 0 px。初始焦点分别落在批准按钮、Drawer 关闭按钮、审计导出按钮和可读 Release Select。

后续阶段必须在这里追加各自的验证结果、偏差、视觉证据和已知限制，不得删除阶段 0 基线。

### 阶段 1：Flow 适配层

- npm registry 在安装前返回 `@xyflow/react` 的 `latest=12.11.6`；与计划基线一致，因此使用 `@xyflow/react@12.11.6` 精确版本，并同步更新 `pnpm-lock.yaml`。
- `src/styles/base.css` 只在 `components` layer 引入 `@xyflow/react/dist/base.css`，未引入默认主题 CSS。
- 新增纯函数 `flow-projection.ts`：从 definition、layout、catalog 和 selected node 构造强类型 Flow nodes；edge 只从 input binding 投影，使用可逆稳定 ID，并为缺失 layout/catalog 提供确定性安全降级。
- 新增纯函数 `flow-connection.ts`：提供 `input:<portName>` / `output:<portName>` Handle 编解码，以及方向、节点/端口、port type、Artifact type、input 占用、自连接和环路的结构化校验结果。
- Store 新增 `moveNodes`、`disconnectInput` 和 `reconnectInput`；批量移动只产生 layout dirty，断开与原子重连只修改 input binding 并产生 semantic dirty。生产画布、Card 和手写 SVG 保持阶段 0 原状。
- 阶段 0 进入门禁复核：4 个文件、19 个测试通过；`pnpm build` 通过。
- 阶段 1 规定门禁：4 个文件、24 个测试通过；`pnpm build` 通过；`git diff --check` 通过。扩展复核包含阶段 0 两组组件测试，共 6 个文件、34 个测试通过。
- 构建仍只有项目既有的 ineffective dynamic import 与 chunk size warning。`pnpm peers check` 额外显示两个既有 emnapi peer 告警，以及 React Flow 间接依赖 `zustand@4.4.0` 所带 `use-sync-external-store@1.2.0` 的 React peer 声明未覆盖 React 19；TypeScript、全部定向测试和生产构建均验证通过，后续阶段继续观察运行时行为。
- Chromium `1500 × 900` 复测页面容器 1418 / 858 / 428 / 778 px，四种场景文档横向溢出均为 0 px。宽、中、AI 场景的旧画布 viewport 分别为 784 / 824 / 744 px，`scrollWidth` 均为 1160 px，水平滚动继续归旧画布；窄容器仍由页面正文纵向滚动并显示拓扑列表。宽、中、AI 均可聚焦 `source` 图节点，窄场景可聚焦拓扑配置按钮。
- 与计划无功能偏差。批量选择和 viewport 仍作为 React Flow 会话态留给阶段 2 画布适配层管理，没有写入领域 definition/layout 或新增第二份持久化图状态。
- 阶段 2 必须继续以 input binding 为唯一 edge 真相，使用 `moveNodes` 在拖动结束后一次提交，并通过 `reconnectInput` 原子处理 edge 重连；不得把 Flow nodes/edges 或 viewport 写入领域模型。

### 阶段 2：React Flow 设计画布

- 新增 `workflow-canvas.tsx` 与 `workflow-node.tsx`，宽/中/AI 容器的设计态画布已改为受控 React Flow；旧手写 SVG、固定画布宽高、Pointer Capture 和逐帧 Store 写入代码已从 `deployment-workflow-center.tsx` 删除。现有页面 Card 壳层、左右侧栏和窄屏 `TopologyList` 保留给阶段 3 重构，运行页未提前修改。
- Flow nodes/edges 每次由 `projectDeploymentFlow` 从 draft definition/layout 投影；edge 选择和 viewport 只保存在组件会话态。连接、断开与重连分别调用 `connectInput`、`disconnectInput`、`reconnectInput`，未在 Store 或领域模型增加 edge 集合。
- 自定义节点显示可读名称、类型版本、执行域、副作用、风险、选择、问题数和只读状态，并使用 `input:<portName>` / `output:<portName>` Handle。选中、问题和只读除语义颜色外还有 Badge、图标、文案或虚线边界，不只依赖颜色。
- 鼠标和多选拖动期间只更新画布临时 nodes；`onNodeDragStop` 使用一次 `moveNodes` 批量提交。普通方向键及 `Alt+方向键` 都经过同一布局提交路径，并通过本地化 live region 播报新位置。
- React Flow 默认 Delete 被关闭，nodes/edges 也标记为不可由默认删除流移除；节点继续使用 Inspector 的明确删除入口，选中 edge 后通过明确的“断开输入连接”按钮调用 Store。edge 重连在验证通过后原子替换 binding。
- 画布提供放大、缩小、Fit View、恢复默认 viewport、框选和平移；10 个及以上节点显示 MiniMap。viewport 按 workflow 保存在当前组件会话，不触发 semantic/layout dirty。
- `ariaLabelConfig`、节点、edge 与每个 Handle 均有中英文辅助文案；结构化连接失败码映射到双语 Toast。补齐无版本 `DeploymentPortType` 的双语 label，避免端口类型内部 key 暴露给用户；视觉夹具同步 `appStore.locale`，确保 `locale=en-US` 真正覆盖组件文案。
- 阶段 1 进入门禁复核：核心 4 个文件、24 个测试通过；扩展 6 个文件、34 个测试通过；`pnpm build` 通过。
- 阶段 2 规定门禁加新增画布测试：5 个文件、32 个测试通过。扩展复核包含 editor、runtime 与 locale key 集合测试，共 8 个文件、42 个测试通过；`pnpm build`、`pnpm check:ai-styles` 与 `git diff --check` 通过。构建仍只有项目既有的 ineffective dynamic import 与 chunk size warning。
- Chromium `1500 × 900` 实测页面容器仍为 1418 / 858 / 428 / 778 px，四种场景文档横向溢出均为 0 px。宽、中、AI 的 React Flow viewport 分别为 784 / 824 / 744 px，`scrollWidth === clientWidth`，无限画布通过 pan/zoom 而非 DOM 横向滚动；窄容器画布尺寸为 0 且 edge 不渲染，428 px 页面正文继续显示并滚动完整拓扑列表。
- 宽场景真实显示 10 个节点、12 条由 binding 投影的 edge、22 个 Handle、控制器与 MiniMap。节点最终宽度为 256 px，相对模板 280 px 列距保留 24 px Handle 操作间隙。实际操作验证：点击节点同步 Inspector；普通方向键把 `source` 从 x=0 移到 x=12 并启用保存；鼠标拖动在停止后启用保存；Fit View 从 `translate(0,0) scale(1)` 调整为 `translate(65px,176.434px) scale(0.596715)`；键盘选择 edge 后可显式断开；从 `build.output:bundle` 拖到清空的 `candidate.input:bundle` 能把 edge 从 11 恢复到 12 并把问题数从 1 恢复到 0；把 `build → preflight.bundle` 重连到已清空的 `candidate.bundle` 后旧 edge 消失、新 edge 出现，对应缺失输入问题从 candidate 转移到 preflight。
- 中文与英文宽画布、中文窄拓扑和英文 AI 挤压场景已实际检查。全新标签页及一次正常 reload 的 console warning/error 均为空；阶段 1 记录的 `use-sync-external-store@1.2.0` React 19 peer 元数据告警未在真实画布运行中表现为错误。HMR 与浏览器 viewport 连续切换期间曾出现一次 Chromium `ResizeObserver loop completed with undelivered notifications`，在全新加载和 reload 中均不可复现，未记录为稳定运行缺陷。
- 与计划无功能偏差。阶段 2 没有生成阶段 5 的正式截图证据目录，也没有重构页面壳层、Card、运行页或覆盖层；这些范围继续留给阶段 3–5。
- 阶段 3 必须保持本阶段的 projection/Store 边界、稳定 `nodeTypes`/`edgeTypes`、drag-stop 单次提交、显式 edge 删除、viewport 会话态和窄屏完整替代路径；连续分栏重构不得把 React Flow viewport 写入 definition/layout，也不得恢复 DOM 横向滚动。

### 阶段 3：连续分栏工作台

- 阶段 2 进入门禁复核：扩展 8 个文件、42 个测试通过；`pnpm build`、`pnpm check:ai-styles` 与 `git diff --check` 通过。构建仅保留既有的 ineffective dynamic import 与 chunk size warning。
- `deployment-workflow-center.tsx` 已拆出 `deployment-workspace-shell.tsx`、`deployment-workflow-tabs.tsx`、`workflow-list-pane.tsx`、`workflow-editor-toolbar.tsx`、`workflow-topology-list.tsx`、`node-library-drawer.tsx`、`node-inspector.tsx`、`validation-status-bar.tsx` 和共享编辑器 UI helper。设计态根节点不再导入或渲染 Card；准备、运行、版本和 Runtime 覆盖层实现未在本阶段改写。
- 宽容器使用连续三栏 Resizable，初始实测为工作流列表 255 px、画布 821 px、Inspector 340 px；两个分隔手柄均可聚焦并带本地化辅助名称。键盘把首个手柄从 18 调整到 23 后布局即时变化。
- 中等与 AI 挤压容器只挂载主画布，工作流列表、可搜索且按 category 分组的节点库、Inspector 均通过固定标题 Drawer 打开。节点库 Drawer 在 `1500 × 900` viewport 中实测标题区 73 px、正文 ScrollArea 783 px；关闭后焦点返回“节点库”触发按钮。
- 窄容器通过工作台容器宽度观测与 `48rem` / `72rem` container-query 阈值选择唯一布局；最终 DOM 完全不含 React Flow 画布，而不是保留隐藏的 0×0 Flow。10 个拓扑行继续使用同一 definition、catalog 和 binding，行内 Select 显示“冻结源码 · 源码快照”/“Freeze source · Source snapshot”等可读 label；添加、删除、连接、断开、参数、校验和保存入口均可达。Inspector Drawer 实测正文滚动层 794 px，关闭后焦点返回原拓扑行“配置”按钮。
- 公共 Tabs、校验、刷新、新建、保存重组为固定单行操作区；设计态外的三个 Tab 在宽容器仍显示工作流列表入口。窄英文 Tabs 只在自身横向滚动层内滚动，操作按钮保持 32 px 高且未换行，页面无横向溢出。
- Scroll ownership 已统一：页面主体固定且 `overflow-hidden`；宽容器工作流列表与 Inspector 各自使用全宽 ScrollArea，React Flow 负责画布 pan/zoom；中等容器由画布和 Drawer 正文各自滚动；窄容器拓扑 ScrollArea 独立滚动，校验状态栏固定在底部。内容 padding 均位于滚动层内部。
- Chromium `1500 × 900` 实测工作台外框 1420 / 860 / 430 / 780 px，对应内部页面容器 1418 / 858 / 428 / 778 px。宽、中、窄、AI 场景的文档级与工作台级横向溢出均为 0 px；宽/中/AI 分别挂载 1 个 React Flow，窄场景全页为 0 个 React Flow 且挂载 1 个拓扑列表。
- 中文宽、中文窄、英文宽、英文窄以及英文 AI 挤压场景均已实际渲染检查。宽画布方向键把 `source` 从 x=0 移到 x=12 并启用保存；Fit View 从 `translate(0px, 0px) scale(1)` 调整为 `translate(68px, 180.75px) scale(0.625)`。全新中文宽屏标签页和随后英文窄屏导航的 warning/error 日志均为空。HMR 迭代期间旧标签页记录过一次不可复现的 `ResizeObserver loop completed with undelivered notifications`；全新加载未复现。
- 阶段 3 规定门禁：中心组件与 Store 共 2 个文件、14 个测试通过。扩展复核覆盖 editor、Flow 投影/连接、Store、画布、中心、Runtime 与 locale key 集合，共 8 个文件、43 个测试通过；`pnpm build`、`pnpm check:ai-styles` 和 `git diff --check` 通过。
- 与计划无功能偏差。为同时满足 container-width 响应和窄屏不挂载 Flow，`DeploymentWorkspaceShell` 使用与 Tailwind container query 相同的 `48rem` / `72rem` 阈值观测自身（即 WorkbenchPage 内容）宽度；CSS 可见性与操作区仍使用 `@min-*` container query。该会话态布局值不进入 workflow definition、layout 或 Store，也不触发 dirty。
- 阶段 4 必须保留设计态无 Card、三栏初始比例、窄屏不挂载 Flow、Drawer 焦点返回、底部状态栏和阶段 2 的投影/Store 语义；只继续重构准备、运行、版本及部署覆盖层，不得重新把 Runtime Card 或只读运行图职责塞回设计态组件。

### 阶段 4：运行与发布体验

- 阶段 3 进入门禁复核：扩展 8 个文件、43 个测试通过；`pnpm build`、`pnpm check:ai-styles` 与 `git diff --check` 通过。构建仅保留既有的 ineffective dynamic import 与 chunk size warning。
- `deployment-workflow-runtime.tsx` 已缩减为运行页编排，并拆出 `runtime-workspace.tsx`、`runtime-flow.tsx`、`runtime-node-inspector.tsx`、`release-list.tsx`、`approval-dialog.tsx`、`artifact-drawer.tsx`、`evidence-dialog.tsx` 与共享 Runtime UI helper。部署中心设计、准备、运行、版本及部署覆盖层均不再导入或渲染 Card。
- 准备发布改为固定标题、正文 ScrollArea 与固定底部主操作区；revision、节点数、retention、能力 Badge、停用、semantic dirty、过期、plan drift、prepare progress 与 capability failure 门禁保持。审批仍绑定原有 `approveAndStart` coordinator，准备和审批动作没有下沉到单节点调用。
- 运行记录宽容器使用连续三栏 Resizable，实测运行列表 / DAG / Inspector 为 255 / 820 / 339 px；中等、窄和 AI 挤压容器只保留只读 DAG，运行列表与 Inspector 进入固定标题 Drawer，关闭后焦点返回原触发按钮。运行图由 `projectDeploymentFlow` 从 workflow definition/layout 投影 edge，再与 `DeploymentRunNodeRecord` 合并 status、duration、attempt、bounded progress 和 evidence gap；10 节点、12 条 binding edge 与 native run 投影一致。
- 运行图未注册连接、重连、拖动、删除或布局写入处理器，`nodesDraggable`、`nodesConnectable`、`edgesReconnectable` 均关闭，Delete 行为禁用。为让 React Flow 计算只读 edge 几何，每个节点保留两个 `aria-hidden`、`tabIndex=-1`、`pointer-events:none`、`opacity:0` 的内部 anchor；真实渲染中暴露的连接 Handle 数为 0，console warning/error 为 0。
- 节点 Inspector 继续展示可读 attempt Select、bounded progress、节点事件、Artifact 入口和完整运行时间线；`state_unknown` 只显示只读 reconciliation，不显示取消或其他修改入口。活动运行取消仍经过确认 Dialog 与原有 `cancel` coordinator。
- 版本视图改用 Table 展示 current/previous Release、Artifact 身份、启用时间与操作；人工回滚仍创建新的 rollback run，并重新执行 prepare、approval 与 start。Artifact Drawer 使用描述列表和紧凑组件行，保留 reference、lease、current/previous retention 与 protected 语义；Evidence Dialog 分为输出、receipt 和日志区域，审计导出仍走类型化 IPC。
- Approval、Evidence、rollback Dialog 与 Artifact Drawer 都保持 `overflow-hidden`、固定 Header/Footer、`min-h-0 flex-1` 正文 ScrollArea、Escape 关闭与焦点返回。Chromium `430 × 800` 实测：审批 `398 × 736`、证据 `398 × 704`、回滚 `398 × 480`、Artifact `360 × 800`；正文滚动层和 Footer 均可见，Card 数与文档级横向溢出均为 0。初始焦点分别落在“批准并执行”、审计导出、可读 Release Select 与 Drawer 关闭按钮；审批、证据、回滚的真实触发器焦点返回通过，Artifact 焦点返回由组件回归测试覆盖。
- Chromium `1500 × 900` 下 prepare、runs、versions 在四种工作台容器中的内部宽度仍为 1418 / 858 / 428 / 778 px，文档、工作台与当前主视图横向溢出均为 0，Card 数均为 0。prepare 与 versions 只由自身正文 ScrollArea 滚动；宽运行视图由运行列表和 Inspector 各自滚动，React Flow 负责 DAG pan/zoom；中、窄与 AI 场景由 DAG pan/zoom和对应 Drawer 正文滚动。宽/中/窄/AI 的运行 Flow 分别为 820 / 856 / 426 / 776 px 宽，全部显示 10 节点和 12 条真实 edge。
- 中文宽 prepare/runs、英文宽 versions、英文窄 runs、中文窄四个覆盖层均已实际渲染检查；临时截图只用于本阶段检查，没有提前创建或覆盖阶段 5 的正式证据目录。全新页面的 warning/error 日志均为空。
- 阶段 4 规定门禁：中心组件、Runtime 组件与 Run Store 共 3 个文件、19 个测试通过。扩展复核覆盖 Flow 投影/连接、两个 Store、设计画布、中心、Runtime 与 locale key 集合，共 8 个文件、48 个测试通过；`pnpm build`、`pnpm check:ai-styles` 和 `git diff --check` 通过。
- 与计划无功能偏差。阶段 5 必须继续保持 input binding 是唯一 edge 真相、运行图严格只读、覆盖层完整高度收缩链、四种容器 scroll ownership 与本阶段 coordinator/IPC 边界；正式截图仍应写入新的 `deployment-workflow-xyflow-refactor/` 目录，不得使用本阶段临时图替代。
