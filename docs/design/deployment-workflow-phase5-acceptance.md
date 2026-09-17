# Deployment Workflow 阶段 5 验收证据

> 日期：2026-09-17  
> 范围：运行、审批、产物、版本与人工回滚体验  
> 视觉夹具：`?deploymentVisual=1&scenario=<wide|medium|narrow|ai>&view=<prepare|runs|versions>&locale=zh-CN`

## 阶段 4 前置门禁

修改阶段 5 前实际复核：

- 阶段 4 宽三栏、中 Drawer、窄拓扑列表和 AI 挤压四张证据与当前代码一致；
- `pnpm test`：211 个测试文件通过、1903 个测试通过、1 个文件/测试跳过；
- `pnpm test:deployment:e2e`：3/3 真实隔离 SSH/SFTP、静态 Release 和 Docker-in-Docker 测试通过；
- 工作流 高层 IPC 仍只有 coordinator 级 prepare/approve/start/cancel/reconcile 与只读投影，没有 effectful 单节点入口。

## 阶段 5 交付

- 准备发布展示 native 审批前节点的单调有界进度、必需能力、未保存语义漂移、计划过期和工作流停用门禁；
- 审批 Dialog 按“发布什么 / 发布到哪里 / 将发生什么 / 如何验证 / 失败怎么办”展示可读摘要；
- 运行视图展示顶层状态、运行图、节点状态、attempt、耗时、有限进度、事件日志预览、receipt/evidence 和审计入口；
- `state_unknown` 展示证据缺口节点，并且只提供 read-only reconciliation；
- Artifact Drawer 展示 manifest、组件、digest、source、producer、run/node/release refs、lease 和 retention；
- 版本视图展示 current、previous 和可回滚 Release；
- 人工回滚解析 retained `release_previous`，重新只读 preflight、prepare 和 immutable plan freeze，创建新的 `rollback` run，再走普通 approve/start；原 run 保持不可变；
- 运行/事件/attempt 均使用稳定分页；事件标题通过 i18n summary key 展示，不把远端输出作为标题；
- 一次性操作使用去重 Toast，等待审批、运行、恢复门禁和未知状态使用上下文 Alert，取消与回滚使用确认 Dialog。

## 实际渲染矩阵

使用 Playwright Chromium，viewport 为 `1500 × 900`，以 `WorkbenchPage` 容器宽度而不是 viewport 断点测量运行视图。

| 场景 | 页面容器 | 运行视图结构 | 文档横向溢出 | 结果 |
| --- | ---: | --- | ---: | --- |
| 宽 | 1418 px | `288 px + 1086 px` 运行列表/运行详情双栏 | 0 | 通过 |
| 中 | 858 px | 826 px 单栏自然纵向布局 | 0 | 通过 |
| 窄 | 428 px | 396 px 单栏运行卡片与独立内部滚动 | 0 | 通过 |
| AI 挤压 | 778 px | 746 px 单栏，右侧 AI 面板独立 | 0 | 通过 |

截图：

- [宽运行视图](./evidence/deployment-workflow-phase5/wide.png)
- [中等容器](./evidence/deployment-workflow-phase5/medium.png)
- [窄容器](./evidence/deployment-workflow-phase5/narrow.png)
- [AI 面板挤压](./evidence/deployment-workflow-phase5/ai.png)

## 长内容、焦点与键盘

在 `430 × 800` viewport 实测：

| 覆盖层 | 外框 | 正文滚动区 | Footer | 横向溢出 | 初始焦点 |
| --- | --- | --- | --- | ---: | --- |
| 审批 Dialog | `398 × 736` | `396 × 545` | 固定于 `y=654..767` | 0 | “批准并执行” |
| Artifact Drawer | `360 × 800` | `scrollHeight=2015 / clientHeight=683` | 固定于 `y=731..800` | 0 | Drawer 内关闭控件 |
| 回滚 Dialog | `398 × 480` | 正文独立收缩 | 固定于 `y=526..639` | 0 | 可读 Release Select |
| 审计证据 Dialog | `398 × 704` | `396 × 557` | 固定于 `y=682..751` | 0 | Dialog 内首个控件 |

审批和回滚均通过 Escape 关闭，并在 Base UI 关闭动画完成后把焦点显式返回原触发按钮。组件回归测试同时覆盖初始焦点、焦点返回、键盘触发和状态语义。

截图：

- [窄屏长审批](./evidence/deployment-workflow-phase5/approval-narrow.png)
- [窄屏长 Artifact manifest](./evidence/deployment-workflow-phase5/artifact-narrow.png)
- [窄屏人工回滚](./evidence/deployment-workflow-phase5/rollback-narrow.png)
- [窄屏审计证据](./evidence/deployment-workflow-phase5/evidence-narrow.png)

## 自动化验证

- `pnpm test`：213 个测试文件通过、1910 个测试通过、1 个文件/测试跳过；
- `pnpm build`：通过；仅保留项目既有 dynamic import 和 chunk size warning；
- `cargo test --manifest-path src-tauri/Cargo.toml`：931 个 lib 测试、5 个 contract probe 测试通过，40 个显式环境测试 ignored；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `pnpm check:rust:includes`、`pnpm check:ai-styles`、`pnpm check:llm:catalog`：通过；
- `pnpm test:deployment:e2e`：3/3 通过。

新增回归覆盖包括：

- run/event/attempt 稳定分页与 attempt 切换；
- native 审批前节点进度；
- plan 过期/语义漂移使审批失效；
- evidence/receipt/日志预览与 Artifact 引用/retention；
- finalizer 不改变顶层部署结果（继承并继续通过 coordinator 测试）；
- retained previous Release 创建新的 rollback run、再次批准并执行成功，原 run 仍为成功且未修改；
- Strict Mode 下编辑和运行操作 Toast 去重；
- 审批、证据、manifest、回滚长内容收缩链和焦点语义。

## 范围确认

- 未读取、转换或展示 旧版 历史；
- 未删除旧代码、未切换最终生产门禁；
- 未新增 systemd、外部 provider、多主机或签名能力；
- 未新增 effectful 单节点 IPC，rollback 只通过高层 coordinator；
- 未创建 commit、tag 或 push。
