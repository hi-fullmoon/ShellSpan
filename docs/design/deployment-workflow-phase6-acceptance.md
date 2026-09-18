# Deployment Workflow 阶段 6 验收证据

> 日期：2026-09-17  
> 范围：可靠性、安全、E2E 与工作流最终切换
> 结论：阶段 6 退出条件通过；阶段 0–6 整体计划通过，明确延期能力除外

## 前置阶段复核

- 阶段 4 的宽/中/窄/AI 编辑器证据仍与当前 工作流 组件结构一致；
- 阶段 5 的准备、审批、运行、Artifact、版本、人工回滚、焦点和长内容收缩链测试继续通过；
- 工作流 compiler、独立持久化/CAS、Docker Compose、静态站点、编辑器和运行体验均通过最终全量测试；
- 生产代码不查询旧部署表，不读取、转换或渲染旧版数据；旧记录保持不变，物理表仅改名为 `deployment_legacy_*`。

## 启动恢复矩阵

每个需要审批的副作用节点统一使用以下 native 判定；判断只依赖冻结 plan、持久化 projection/attempt/receipt 和 executor 的只读 reconciliation：

| 边界状态 | 恢复行为 | Fail-closed 结果 |
| --- | --- | --- |
| 未开始 | 不执行副作用；保留精确 approved plan | `approved` 或副作用前取消 |
| 执行中 | 用原 run/node/attempt/plan 幂等键调用 read-only `reconcile` | 已完成、未开始、确定失败、已补偿或 `state_unknown` |
| 已完成 | 验证 receipt 的 run/node/attempt/target/plan/payload digest | receipt 缺失或漂移即 `state_unknown` |
| 已补偿 | 验证原 effect 与补偿 receipt/冻结补偿身份 | 证据完整才保留 compensated |
| 证据不完整 | 不写入、不重试、不切换、不重启、不清理 | `state_unknown` |

审批、启动和恢复还会验证 workflow revision/definition digest、canonical plan、target profile/host identity、Artifact CAS、target Release content、node type/version 和 executor version。启动 effect 前再次执行只读 target preflight，完整 target snapshot/capabilities digest 必须仍与审批一致。

## 安全和有界数据

- native repository 在写入时限制 event 16 KiB、node summary 16 KiB、output 64 KiB、receipt 8 KiB、approval summary 64 KiB、plan 512 KiB；
- 工作流 审计导出限制为 2 MiB/1,000 事件，输出值只导出 digest，远端文本、endpoint、用户名、本地路径和审批细节不进入文档；
- 事件只接受 `deployment.*` i18n key；远端 stdout/stderr 不作为标题、summary key、receipt 或审计字段；
- 常见 Secret 字段名和 literal marker 在持久化边界拒绝；工作流只保存 credential/config reference；
- 审批 wire 只接受 `approvalSource: manualUi`；Agent、Quick Action 和 recovery 不能声明审批权限；
- 不存在任意命令节点、effectful 单节点 IPC 或前端逐节点解释执行。

## 可靠性与故障覆盖

自动化覆盖：

- 同 target lock 串行与不同 target 并行；
- attempt-scoped 重复幂等键与 repository 唯一约束；
- 断网/远端 worker 模糊结果进入 `state_unknown`，不盲重试；
- 进程停止、应用重启、取消前后与只读恢复；
- 磁盘余量不足在 CAS 发布前失败；
- manifest/blob 篡改、缺失 blob、并发发布和 lease 保护；
- target/artifact/receipt/plan/node/executor version 漂移；
- Docker Compose、静态站点、验证失败固定恢复、审计导出与人工回滚新 run。

## 最终切换

- `Workbench`、主机部署入口、命令面板和 Sidebar 全部使用 工作流 store/组件；
- 删除旧 `deploymentStore`、旧部署中心/历史/全局 experience 组件、旧 TypeScript types 和相关 fixture/tests；
- 删除旧前端 IPC adapter；
- 删除旧 Rust commands、approval service、artifact transfer、planner、preflight、remote runner、repository、audit 和固定流程模块；
- 工作流 仍需的凭据解析与 Docker archive 身份校验已提取为低层、无编排权限的独立模块；
- Tauri 只注册 coordinator 级 工作流 command 和只读 projection/audit command；
- 旧 SQLite 数据未转换或删除，表仅改为 `deployment_legacy_*` 名称，生产路径无引用。

## 无版本代码命名

- Rust/TypeScript 类型、store、组件、文件名、IPC command、事件名和功能开关均使用无版本名称；
- schema 10 以保留数据的方式把旧表改名为 `deployment_legacy_*`，把工作流表改为标准 `deployment_*`；
- 部署端口、Artifact 句柄、mediaType、IPC、事件和文件名均不再携带版本标签；仅保留数值型 `schemaVersion` 用于结构校验。

## 门禁验证

`SHELLSPAN_DEPLOYMENT_WORKFLOW` 缺失时 admissions 默认开启；显式 false 或无效值时 fail closed。关闭门禁会拒绝创建、修改、归档、准备、审批和启动；只读、取消、reconcile 和审计继续可用。门禁在进程启动时读取，运行中不热切换。

## 实际渲染

使用 Playwright Chromium、`1500 × 900` viewport，以 `WorkbenchPage` container 实测 工作流 运行视图：

| 场景 | 容器宽度 | 文档横向溢出 | 结果 |
| --- | ---: | ---: | --- |
| 宽 | 1418 px | 0 | 双栏运行列表/详情通过 |
| 中 | 858 px | 0 | 单栏自然布局通过 |
| 窄 | 428 px | 0 | 完整运行卡片和内部滚动通过 |
| AI 挤压 | 778 px | 0 | container query 切换通过 |

窄屏审计 Dialog 在 `430 × 800` viewport 中为 `398 × 704`，正文 `513 px`，Footer 固定于 `y=638..751`，导出按钮完整可见且无横向溢出。

- [宽运行视图](./evidence/deployment-workflow-phase6/wide.png)
- [中等容器](./evidence/deployment-workflow-phase6/medium.png)
- [窄容器](./evidence/deployment-workflow-phase6/narrow.png)
- [AI 面板挤压](./evidence/deployment-workflow-phase6/ai.png)
- [窄屏审计与导出](./evidence/deployment-workflow-phase6/audit-narrow.png)

## 最终验证

- `pnpm test`：209 个测试文件通过、1866 个测试通过、1 个文件/测试跳过；
- `pnpm build`：通过；仅有既有 dynamic import 和 chunk size warning；
- `pnpm review:frontend`：测试与构建通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：874 个既有 lib 测试通过、39 个显式环境测试 ignored，5 个 contract probe 通过；schema 10 数据保留迁移回归另行通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `pnpm check:rust:includes`：通过，42 个 include 文件；
- `pnpm check:ai-styles`：通过；
- `pnpm check:llm:catalog`：通过，55 个模型与 4 个负例；
- `pnpm test:deployment:e2e`：真实隔离 Docker Compose/静态站点 2/2 通过，随后恢复、审计、回滚、锁、磁盘和 CAS 子门禁全部通过；
- `git diff --check`：通过。

## 偏差、限制与回滚门槛

计划范围内无功能偏差。构建仍保留仓库既有 dynamic import/chunk warning；Rust 仍报告若干为后续能力预留的 dead-code warning，不影响门禁。

明确延期：systemd、外部 Artifact Provider、多主机、签名/SBOM trust policy、Kubernetes、Nomad 和插件执行器。运行时回滚门槛与关闭 admissions 的操作见 [`deployment-workflow-operations.md`](./deployment-workflow-operations.md)。关闭门禁不删除数据，也不允许把 工作流 run 降级给旧执行器。

本阶段未创建 commit、tag 或 push。
