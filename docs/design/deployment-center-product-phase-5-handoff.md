# 部署中心完善：最终验收与交接

日期：2026-09-25。实际工作树：`/Users/zhengbiwen/.codex/worktrees/7f64/ShellSpan`。任务：`01a0d857-da61-76f0-9c21-ea6019e98284`。

阶段 5 已完成当前批准范围的最终验收。阶段 1–4 的真实执行结果继续有效，本阶段补齐双语、实际渲染、键盘焦点及异常反馈检查。不创建后续任务；没有 commit、tag 或推送。

## 最终产品范围

默认入口是既有工作流列表、编辑器、部署记录与版本页签。源码、数据和只读部署检查仅从工作流设置进入。Application/Environment/SourceBinding 及历史记录继续保留。没有接回独立应用概览或四步向导，没有新增接管平台。

本阶段只修改有证据的局部问题：

- 运行失败提示展示同一 run/plan 的 `compose.restore` 回执已记录，明确本次发布仍失败，历史恢复回执不能证明当前服务状态。没有改变运行状态或新增推断性的业务记录。
- 修复英文窄容器中“只读核对”和“审计证据”按钮与提示文字重叠；操作仍在原提示右侧，仅局部修正占位，不改共享 Alert。
- 审批和取消按钮在文字收起时仍有中英文可访问名称。
- 版本、运行、检查报告和审批有效期的日期跟随应用语言，避免英文界面继续使用系统中文日期格式。

## 本阶段验证

| 检查 | 结果和边界 |
| --- | --- |
| WebKit 实际渲染 | 104 个场景通过：中英 × 1418/858/778/428 px × 13 个视图/状态 |
| 响应式 | 主内容使用独立容器宽度，浏览器视口保持 1500 px，以检查容器收缩；弹框另使用对应宽度的真实视口，428 px 时高度为 740 px |
| 视图/状态 | 工作流列表、运行布局、运行空态、加载态、真实历史版本表、版本空态、真实失败及恢复回执、状态未知展示契约、准备进度、真实阻塞检查报告、发布审批、历史回退审批、设置切换配置 |
| 滚动和焦点 | 审批正文有实际溢出并独立滚动，Footer 留在视口且无顶部分隔线；Tab 保持在弹框，Escape 关闭并返回触发按钮；设置关闭后再打开配置不会抢回焦点；窄版本表横向滚动后操作可获焦点且位于容器内 |
| 实际截图 | 检查中英窄提示、审批、配置，以及版本表操作区域；截图保存在忽略目录 `.phase4-acceptance/phase5-ui/` |
| 原生界面 | 专用 Phase3 app 加载最新 1433 前端；实际检查约 1462×920 窗口下 1238/838 px 内容区的工作流、编辑器、部署记录、版本、英文既有配置及可读选项；Escape 返回工作流设置按钮；英文版本日期显示 `Sep 25, 2026 at 6:37 PM`，随后恢复中文并收起 AI 面板 |
| 前端测试 | 10 文件、90 测试通过，包含新增 5 项真实回执/状态提示/日期/双语键回归 |
| 构建 | `pnpm build` 通过；保留既有分包体积和无效动态导入提示 |
| 渲染入口类型 | `pnpm exec tsc --project tests/deployment-ui/tsconfig.json` 通过 |
| 范围检查 | `pnpm check:ai-styles` 和 `git diff --check` 通过 |

可复验：在本工作树执行 `node scripts/verify-deployment-ui.mjs`。脚本只启动回环 Vite 和 WebKit，渲染项目现有组件、阶段 2–4 保存的真实输出和只读导出的隔离版本记录；结束关闭服务。空态、加载、准备中和状态未知是组件展示契约，不伪造运行或远端证据，不替换 IPC、SSH 或凭据实现，不触发发布、保存、核对或远端写入。

机器结果：[阶段 5 渲染矩阵](deployment-center-product-phase-5-ui-evidence.json)。版本表来源：[隔离历史记录只读导出](deployment-center-product-phase-5-native-render-data.json)。其中工作流为 `workflow-8f807b4d-05a0-48a7-a70c-aff803cd8b0b`，历史版本为 `release-aca5ac128b042166`，不是本阶段新执行。

## 真实执行证据汇总

本阶段未重复完整生命周期。后端代码未改动，沿用阶段 4 的 81 项后端测试、真实 UID:GID 权限测试，以及 773.76 秒真实应用生命周期验收。

| 行为 | 证据 |
| --- | --- |
| 独立构建、冻结源码、实际镜像身份 | [阶段 1](deployment-center-product-phase-1-handoff.md) 与 [产物身份](deployment-center-product-phase-1-evidence.json) |
| 配置关联、真实缺失条件、修订竞争 | [阶段 2](deployment-center-product-phase-2-handoff.md) 与 [检查记录](deployment-center-product-phase-2-evidence.json) |
| 准备、审批、端口/配置冲突、真实发布 | [阶段 3](deployment-center-product-phase-3-handoff.md)、[后端记录](deployment-center-product-phase-3-evidence.json)、[原生发布记录](deployment-center-product-phase-3-native-evidence.json) |
| 数据权限、重启、升级、历史 bundle 回退、HTTP 失败恢复、丢失回执及保留清理 | [阶段 4](deployment-center-product-phase-4-handoff.md) 与 [完整生命周期结果](deployment-center-product-phase-4-lifecycle-evidence.json) |

阶段 4 初次、升级、回退、失败运行分别是 `run-a983ae8a-6a41-4fbd-a308-e1680ba1fe57`、`run-136dd035-fd98-49f9-8153-af9a24ed7770`、`run-caa6a4ef-cfde-46a3-9372-b2dfbb2e4864`、`run-e78cf57e-bbe4-4e8b-8140-046531c9cc40`。真实两条 API 写入的完整对象和文件摘要经重启、升级、回退、恢复及清理校验；恢复后原运行仍为 failed。

## 明确限制

- 这是本机 Linux/arm64 Docker/Compose fixture 的验收，不是生产部署。没有在本阶段连接、检查或写入 `175.178.66.45`，没有操作生产草稿，也没有改写原始 for-you 项目。
- 原生界面沿用旧 Phase3 容器，只验证最新前端和已有历史记录；不声称最新后端的全新原生发布通过。热更新期间旧容器出现 Tauri 事件取消监听的 `listeners[eventId].handlerId` 异常，未据此宣称原生宿主无运行错误，也未扩大修改到其他模块。WebKit 独立矩阵没有浏览器运行异常。
- 未新增恢复失败现场、每个上传/更新/验证边界的逐一断网，以及完整 30 分钟原生过期等待。已有真实丢失回执/重新打开数据库、故意 HTTP 失败恢复、真实时钟过期守卫分别证明其对应路径，不能替代所有故障组合。
- 未验证生产代理、外部 HTTPS 入口、生产数据迁移、Windows/Linux 桌面打包或多架构运行。没有持续在线监控承诺，历史成功与当前服务状态必须分开理解。
- 首期仅一个受管服务/镜像；未知服务和非空目录仍需人工迁移；env_file、secrets 等未支持能力继续阻塞。单实例更新可能短暂中断。版本回退不还原共享数据，不保证应用数据结构的迁移兼容性。
- 保存的工作流节点名称属于既有可编辑数据，仍保留原名；没有为切换语言重写历史节点或配置。

## 清理与改动归属

已执行 `docker compose -f tests/deployment-e2e/compose.yml -p shellspan-deployment-e2e down --volumes`，仅清理该项目容器、网络和专用卷。没有清理其他 Docker 项目或全局镜像。1433/1435 服务与专用原生实例已关闭；原生语言恢复中文，AI 面板保持 400 px 并收起。真实历史证据 JSON 保留。

本阶段新增 `runtime-lifecycle.test.tsx`、`tests/deployment-ui/`、`scripts/verify-deployment-ui.mjs` 及本阶段文档/记录；局部修改 runtime、runtime-utils、检查报告日期、审批日期和双语文案。继承阶段 1–4 的全部未提交内容，不覆盖默认仓库，不建立新工作树，不开子代理。

HEAD：`bc3de48f76e57bd65c5420937b4b40b599a2e13b`。Node `24.21.0`，pnpm `11.1.1`，Playwright `1.63.0`。后端目标与工具版本沿用阶段 1–4 记录。

最终源码/测试快照共 1117 个文件，SHA-256：`45ba1bbc9046bfb8125af3815d73aeb1496d0784e6637de5593939124ae3cfcc`。范围为 Git tracked + untracked、非 ignored 的 `src/`、`src-tauri/`、`protocol/`、`scripts/`、`tests/`、`.gitignore`、`package.json`、`pnpm-lock.yaml`；按路径排序，对每项依次输入「路径 + NUL + 文件 SHA-256 原始字节」，再取整体 SHA-256。文档和生成截图不纳入该源码摘要。
