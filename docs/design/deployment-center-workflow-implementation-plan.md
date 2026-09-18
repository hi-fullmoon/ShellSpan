# Deployment Workflow 实施计划

> 依据：`docs/design/deployment-center-workflow-design.md`  
> 实施方式：严格串行；每个阶段使用独立 Codex 会话  
> 兼容策略：不实现 旧版 兼容编译、旧运行渲染、旧产物适配或历史数据迁移

> 后续专项：工作流正式上线后的 React Flow 图编辑器与无 Card 本地部署 UI 重构，按 [`deployment-workflow-xyflow-ui-refactor-plan.md`](./deployment-workflow-xyflow-ui-refactor-plan.md) 的六个独立会话阶段实施。本文件的阶段 4–6 与既有验收证据保留为初次交付历史，不作为后续 UI 结构的约束。

## 1. 实施原则

1. 工作流 是唯一的新部署模型。新增代码不得继续扩展固定 Docker Compose 表单协议。
2. 每个阶段都必须在自己的会话内完成实现、测试和交接；下一阶段只在上一阶段验收通过后开始。
3. 阶段内保持主分支可构建、相关测试可运行，不用“后续阶段会补齐”掩盖当前阶段的失败。
4. Rust 是 schema、图、路径、能力、审批覆盖、产物完整性和副作用执行的最终权限边界。
5. 前端只消费节点目录和只读投影，通过高层 IPC 发起操作，不逐节点解释工作流。
6. 工作流语义修订与布局修订独立；布局变化不进入 `planDigest`。
7. 旧部署代码只允许在切换完成前作为暂存实现存在，不为其增加适配层。最终阶段删除旧入口和未再使用的实现。
8. 旧数据库内容不转换、不读取，也不在本计划内自动删除。工作流使用独立表；如需清理旧表，应另行获得明确授权。
9. 不提供任意 Shell、任意 SSH 命令或用户执行器。所有节点由 native registry 注册并使用固定 executable/argv 或固定 remote request。
10. 所有阶段都要避开工作区中与部署中心无关的现有改动，不做全仓无关格式化。

## 2. 固定产品决策

- 一个工作流恰好一个审批节点，一次运行的副作用只能落在一个 target。
- 跨节点文件只通过 `artifact.bundle` 句柄传递。
- 首版静态站点只支持版本目录与原子相对 `current` 符号链接切换。
- 自动恢复由 runtime 固定补偿计划驱动，不由用户画失败分支。
- 节点输入绑定是语义真相；画布连线只是输入绑定的投影。
- canonical plan 冻结 workflow revision、source、target、artifact、节点版本、配置、固定动作和补偿动作。
- 人工回滚始终创建新的 `rollback` run 并重新预检、审批和执行。
- `SHELLSPAN_DEPLOYMENT_WORKFLOW` 是独立、restart-scoped、默认开启且对无效值 fail-closed 的功能门禁。
- 首轮完整交付覆盖 Docker Compose 和静态站点；systemd、外部 Artifact Provider、多主机和签名策略留作后续扩展，不阻塞 工作流 首次上线。

## 3. 阶段依赖

```text
阶段 0 协议与编译器
  → 阶段 1 持久化与 Artifact CAS
    → 阶段 2 Docker Compose 端到端链路
      → 阶段 3 静态站点端到端链路
        → 阶段 4 工作流编辑器
          → 阶段 5 运行、产物、版本与回滚体验
            → 阶段 6 可靠性、安全、E2E 与切换收口
```

阶段不可并行实施。后续阶段必须先检查上一阶段的退出条件和测试结果。

## 4. 阶段 0：协议、节点目录与编译器

### 目标

建立不依赖 UI 和执行器的 工作流 领域核心，使一份工作流定义可以被 native 层可靠校验并编译为稳定的 canonical plan 草案。

### 实施范围

- 新增 `protocol/deployment/workflow.md`，固化：
  - `DeploymentWorkflowDefinition` 与 `DeploymentWorkflowLayout`；
  - 节点、端口、输入绑定、条件、重试和 effect class；
  - `ArtifactBundleManifest`、descriptor 与 opaque handle；
  - immutable run plan、node attempt、receipt、evidence、compensation；
  - canonical JSON 和 SHA-256 digest 规则；
  - 数量、长度、JSON、并行度、超时和重试硬上限。
- 在 `src-tauri/src/deployment/` 内建立清晰子模块：workflow schema、port types、node registry、compiler、canonicalization 和 validation error。
- 注册设计文档中的 MVP 节点描述符，只实现 descriptor/config validator，不执行副作用。
- 编译器完成 schema、节点版本、端口、DAG、可达性、artifact 兼容矩阵、target、审批覆盖、验证覆盖、补偿覆盖和危险配置校验。
- 编译结果包含拓扑层、串行 target effect lane、节点配置摘要、输入摘要、计划摘要所需的结构化风险信息。
- 前端 `src/lib/deployment/` 增加与 IPC wire format 对齐的 工作流 类型；避免 `any` 和根级 barrel。
- 不实现 旧版 → 工作流 转换，不修改旧定义，也不接受混合版本图。

### 测试

- Rust 单元与属性风格测试覆盖：环路、悬空绑定、类型错误、未知节点、越权审批、不可达副作用、跨 target 副作用、条件限制和大小上限。
- 同一语义不同对象键顺序得到同一 digest；节点、参数或连接变化改变 digest；纯布局变化不改变 digest。
- TypeScript fixture 与 Rust fixture 对关键 wire payload 保持一致。

### 退出条件

- registry 能列出所有 MVP 节点和可读元数据。
- 静态站点与 Docker Compose 模板定义 fixture 均可编译。
- 恶意或非法工作流在 native 边界被拒绝。
- `cargo test --manifest-path src-tauri/Cargo.toml` 与相关前端测试通过。

## 5. 阶段 1：工作流 持久化、Artifact CAS 与高层 IPC

### 目标

让工作流、布局、运行节点、attempt、输出、artifact、receipt 和事件具备可验证的持久化基础，并提供前端唯一允许使用的高层 IPC。

### 实施范围

- 新增独立工作流数据表，不转换或读取旧部署表：
  - workflow identity/revisions/layouts；
  - runs/run nodes/node attempts/run outputs；
  - artifacts/artifact refs/effect receipts；
  - 工作流 run events 和当前投影。
- 约束 revision、plan、attempt、event、receipt 的身份字段不可变，并保证事件 sequence 连续。
- 保存语义时生成新 workflow revision；仅移动节点时只生成 layout revision。
- 删除改为归档/停用；存在 run 或 artifact ref 时拒绝物理删除。
- 建立 `deployment-artifacts` CAS：临时写入、fsync、摘要校验、原子发布、manifest/blob 分离、lease 和保留投影。
- 实现 bundle/descriptor/handle 的严格解析与消费前完整性验证。
- 在 `src/lib/ipc/tauri.ts` 和 Rust command 注册中提供设计文档列出的高层命令；命令不得暴露可绕过 coordinator 的 effectful 单节点调用。
- 实现 `SHELLSPAN_DEPLOYMENT_WORKFLOW` 门禁；关闭时只允许只读查看、取消、恢复和审计类操作。

### 测试

- repository 测试覆盖 revision 竞争、layout 独立修订、不可变记录、事件连续性、归档限制和分页。
- CAS 测试覆盖摘要篡改、manifest 引用缺失 blob、并发发布、lease 保护、尺寸上限和清理排除集合。
- IPC 测试覆盖命令名、参数映射、返回类型与门禁行为。

### 退出条件

- 工作流语义、布局和 revision 可独立保存与重开。
- Artifact 写入后可按 opaque handle 验证读取，路径不会暴露到前端。
- 所有新 IPC 都经过类型化适配层并注册到 Tauri。
- 数据库、Rust 和相关前端测试通过。

## 6. 阶段 2：Run Coordinator 与 Docker Compose 垂直链路

### 目标

以 工作流 compiler、scheduler、approval、ledger 和 coordinator 完整执行 Docker Compose 模板，不调用旧部署编排入口。

### 实施范围

- 实现 `DeploymentNodeExecutor` 契约及 `validate_config / plan / execute / reconcile / compensate` 生命周期。
- 实现 Run Coordinator：
  - 审批前节点执行与 plan 冻结；
  - topo ready queue、fail-fast、本地并行上限；
  - 同 target effect lane 与部署锁；
  - attempt 幂等键、状态投影、有限进度和事件；
  - finalizer 与主运行结果分离；
  - 协作式取消和先 reconcile 后重试。
- 实现 Docker Compose 所需节点：source snapshot、Docker Buildx、Compose bundle、target preflight、candidate、approval、SFTP、prepare release、load image、compose deploy、HTTP verify、可选 Nginx reload、release commit、notify。
- 复用安全的底层 SSH/SFTP、固定 RemoteRunner 和凭据能力，但不复用旧固定流程编排。
- 审批摘要展示展开后的固定动作、风险、目标、artifact、验证和补偿；批准绑定精确 `planDigest` 与过期时间。
- 实现节点 attempt、receipt、evidence、reconcile 和 Compose 固定补偿。

### 测试

- 每个节点的 validate/plan/execute/reconcile/compensate 契约测试。
- scheduler 测试覆盖并行、target 串行、fail-fast、finalizer、取消、重试门禁和幂等。
- 模拟 SSH/RemoteRunner 的 Docker Compose 端到端测试覆盖成功、健康检查失败、自动恢复、未知状态和应用重启恢复。

### 退出条件

- Docker Compose 模板从创建、准备、审批、执行、验证到 commit 全程只走 工作流。
- 任一 effectful 节点在无已批准精确 plan 时不可调用。
- 每个副作用边界都能产生 receipt，恢复时只读检查后给出确定结论或 `state_unknown`。
- Rust、IPC 和部署相关集成测试通过。

## 7. 阶段 3：静态站点垂直链路

### 目标

在同一 compiler、scheduler、approval、artifact 和 ledger 上交付静态站点模板及其固定恢复能力。

### 实施范围

- 实现 `build.package-script@1`：固定 package manager executable/argv、冻结 package metadata/lockfile、隔离 workspace、allowlisted environment refs、有界输出、取消和超时。
- 实现 `artifact.collect@1` 与确定性 file-tree：路径规范化、稳定排序、mtime/权限归一化、默认拒绝符号链接、跨平台 content digest。
- 实现安全打包/解包限制：文件数、深度、总大小、单文件、路径穿越、设备文件、压缩炸弹。
- 实现 `release.prepare-files@1`、`deploy.static-switch@1`、`verify.http@2` 和 `release.commit@1`。
- 远端布局固定为 `releases/<releaseId>` 与原子相对 `current` 符号链接；能力不足时预检阻止运行。
- 切换失败或验证失败时仅使用已冻结 previous release 执行固定补偿并再次验证。
- 增加静态站点模板 fixture 和模板创建 API。

### 测试

- 文件树确定性、symlink、逃逸、zip-slip/tar traversal、压缩炸弹、相同 release 冲突和并发发布测试。
- package-script 参数注入、非 allowlist 环境变量、取消、超时和输出上限测试。
- Linux SSH/SFTP 集成测试覆盖首次发布、升级、切换前取消、切换后失败恢复、远端漂移和幂等重放。

### 退出条件

- 静态站点与 Docker Compose 共用所有核心基础设施，没有第二套 scheduler/approval/ledger。
- `dist` 从源码构建或从 snapshot 采集后均形成相同 Artifact Bundle 协议。
- 原子切换与固定恢复在真实 Linux 目标集成测试中通过。

## 8. 阶段 4：工作流编辑器与模板体验

### 目标

交付可创建、连接、配置、验证和保存 工作流 工作流的完整编辑体验，并在宽、中、窄容器中保持可用。

### 实施范围

- 将部署中心信息架构重构为工作流列表和工作流详情中的设计、准备发布、运行记录、版本入口。
- 提供静态站点、Docker Compose、导入已构建文件（可标 Beta）和空白工作流模板入口。
- 宽容器采用列表/画布/配置三栏；中等容器把节点库与配置放入 Drawer；窄容器使用完整可编辑的拓扑节点列表。
- 连接交互直接修改目标节点的 input binding，不维护第二份 edges 数据。
- 使用 native node catalog 驱动节点库、端口、配置 schema、effect class、能力和风险展示。
- 本地即时提示与 native validate 结果统一映射，native 仍是最终权威。
- 所有 Select 使用同源 `{ value, label }`；所有可见文案进入中英文 i18n。
- 长配置面板、校验列表和 Dialog 建立完整 `min-h-0`/`flex-1`/ScrollArea 收缩链。
- 提供键盘选节点、查看问题、配置和连接端口的替代路径。
- 使用现有 shadcn primitives 和设计 token；如需新增画布依赖，先明确选择理由并锁定版本。

### 测试与视觉检查

- 前端回归测试覆盖模板创建、节点增删、端口连接、可读 label、CardAction、revision 行为、错误映射、Toast 去重和窄屏列表等价性。
- 代表性宽度下实际渲染检查：宽三栏、中 Drawer、窄列表，以及 AI 面板挤压场景。
- 检查焦点、键盘、空态、加载态、保存冲突和错误态。

### 退出条件

- 用户能从模板创建并编辑两类可运行工作流。
- 保存后重开语义和布局准确恢复；移动节点不使 prepared plan 失效，修改语义会使其失效。
- 宽、中、窄三种容器实测通过，中英文键集合一致。

## 9. 阶段 5：运行、审批、产物、版本与人工回滚体验

### 目标

把执行期的节点、尝试、证据、产物和 Release 状态完整呈现给用户，并提供不绕过审批的人工回滚。

### 实施范围

- 准备发布视图展示审批前节点进度、计划漂移、过期和能力缺口。
- 审批 Dialog 按“发布什么、发布到哪里、将发生什么、如何验证、失败怎么办”分组，不用内部 ID/enum 作为主文案。
- 运行图和时间线展示 node status、attempt、耗时、有限进度、receipt/evidence、日志预览和审计入口。
- `state_unknown` 展示证据缺口和只读 reconciliation 操作；等待审批、运行和恢复门禁使用上下文 Alert。
- Artifact Drawer/页面展示 manifest、组件、digest、来源、引用 run/release、lease 和保留状态。
- 版本视图展示 current、previous 和可回滚 Release。
- 人工回滚选择版本后创建新的 `rollback` run，重新 preflight、prepare、approve 和 execute；不修改原运行。
- 一次性保存、构建、刷新、导入结果使用 Toast；确认删除、停用、取消和回滚使用 Dialog，避免重复反馈。

### 测试与视觉检查

- 状态投影、分页、attempt 切换、证据查看、审批失效、回滚新 run 和通知去重测试。
- 长审批、日志、artifact manifest 在窄窗口中的滚动与固定 Header/Footer 检查。
- 可访问性测试覆盖焦点返回、Dialog 初始焦点、键盘操作和状态语义。

### 退出条件

- 用户可从 UI 完成准备、审批、执行、取消、reconcile、审计和人工回滚。
- 运行顶层状态与节点投影一致，finalizer 失败不会伪造部署结果。
- Artifact 和 Release 身份对用户可核验但不泄露本地路径或 Secret。

## 10. 阶段 6：可靠性、安全、E2E 与 工作流 切换收口

### 目标

完成崩溃恢复、安全边界、全链路测试和旧部署代码切换，达到正式启用条件。

### 实施范围

- 对每个副作用边界补齐启动恢复矩阵：未开始、执行中、已完成、已补偿、证据不完整。
- 验证 target/artifact/receipt/plan/node version 漂移时 fail closed，并进入重新准备或 `state_unknown`。
- 完成事件、日志、审计导出的大小限制、脱敏和远端文本隔离。
- 验证 Agent 和 Quick Action 只能创建草稿或请求准备，不能审批；验证 Secret 只以 reference 存在。
- 增加并发 target lock、重复幂等键、断网、进程崩溃、应用重启、磁盘不足和 CAS 篡改测试。
- 更新 `pnpm test:deployment:e2e` 覆盖 Docker Compose、静态站点、失败恢复、崩溃恢复、审计导出和人工回滚。
- 将部署中心生产入口切换到 工作流，删除旧前端 store actions、旧 IPC、旧固定流程编排、旧协议使用点和未再使用的测试 fixture。
- 保留旧数据库表但不再读取；不在本阶段自动删除用户旧数据。
- 更新协议、运维说明和门禁说明，记录已知限制与回滚门槛。

### 全量验证

```bash
pnpm test
pnpm build
pnpm review:frontend
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm check:rust:includes
pnpm check:ai-styles
pnpm check:llm:catalog
pnpm test:deployment:e2e
```

### 退出条件

- 设计文档第 19 节中除明确延期能力外的功能、安全、可靠性、UI 和测试验收项全部有证据。
- 新运行不再经过任何 旧版 类型、IPC 或执行入口。
- 门禁关闭时新建/修改/执行 fail closed，但取消、恢复和审计仍可用。
- 不存在明文凭据、任意命令入口、无批准副作用或路径逃逸。
- 所有相关测试和实际渲染检查通过。

## 11. 明确延期项

以下能力不属于首轮七阶段的完成门槛，应在 工作流 稳定后分别立项：

- 固定 systemd service 节点；
- OCI Registry、S3 或 HTTP Artifact Provider；
- 多主机串行/批次部署；
- `verify.signature`、SBOM policy 和签名信任链；
- Kubernetes、Nomad 或任意插件执行器。

任何延期能力仍必须通过 native node registry、typed ports、immutable plan、approval、receipt 和 reconcile 接入，不能引入自定义命令旁路。

## 12. 每阶段会话交接模板

每个阶段结束时必须在会话最终回复中给出：

1. 完成的交付物与主要文件；
2. 与本计划的偏差及原因；
3. 运行过的测试及结果；
4. 未运行测试及原因；
5. 已知风险和下一阶段必须继承的约束；
6. 当前 `git status --short`，区分本阶段改动与进入会话前已有改动；
7. 不创建 commit、tag 或 push，除非用户另行明确要求。
