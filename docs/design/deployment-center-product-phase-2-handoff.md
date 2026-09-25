# 部署中心完善：阶段 2 交接

日期：2026-09-25。实际工作树：`/Users/zhengbiwen/.codex/worktrees/7f64/ShellSpan`。基线 HEAD：`bc3de48f76e57bd65c5420937b4b40b599a2e13b`。本阶段任务：`01a0d668-4da2-7d63-b157-1c952de7df71`。

全部代码、命令和测试在上述工作树完成。未提交、创建 tag 或推送。原始 for-you 项目未改写；未连接或写入生产主机 `175.178.66.45`。设计和阶段 1 的所有未提交修改继续保留。

## 交付结果

- migration 11 持久化 Application、SourceBinding、Environment、ReadinessReport；应用可有多个环境，环境可先保存无工作流草稿。保存采用应用、源码、环境、工作流修订竞争校验及单事务更新。
- 部署中心默认进入应用列表和详情；提供四步接入、显式未跟踪文件选择、排除目录、可读 SSH/平台/方式选项、数据与接管字段、只读检查、保存后回显和高级编辑入口。窄容器使用列表 Drawer。
- 真实 Git 项目检测不执行构建脚本。Dockerfile/Compose/.dockerignore 生成先预览，按摘要确认后独占创建；拒绝已有文件和过期预览，不自动提交，也不自动纳入未跟踪文件。
- 配置字段仅映射唯一可识别节点角色，不重建图；自定义节点、连线、输出、历史修订保持原样。不可映射图和高级编辑器改动的受管字段进入只读/拒绝保存；其他环境存在受管字段漂移时整笔事务回滚。
- 报告包含状态、位置、检查时间、诊断及中英修复提示。可选远端检查走既有 SSH/SFTP、固定只读命令和审计设施，不建目录、不安装、不停止服务。数据挂载不能以 SSH 用户权限冒充容器 UID:GID 的实际访问能力。
- 新 deploy preparation 需要显式关联以及绑定当前修订、摘要、15 分钟有效期的报告；阻塞或未检查项目拒绝准备。原审批、CAS、目标冻结、取消和恢复机制保留。

## 阶段 2 退出条件及真实证据

| 条件 | 实际验证 |
| --- | --- |
| 从空态接入 for-you | 原生 Tauri 开发实例由空列表打开四步引导，选择真实项目，明确纳入 `public/og.png`、`src/styles/signal.css`，保存应用和工作流；重新加载后配置与报告仍存在 |
| 缺少条件可定位修复 | 原项目缺少 Dockerfile/compose.yaml，实际本地检查分别显示路径、阻塞状态和修复指引；未选择远端检查，所有远端项目保持未检查 |
| 不发生未授权远端写入 | 真实隔离 Linux SSH 测试对不存在目录报告 directory/disk/ownership 阻塞；SFTP 检查证明目录前后均不存在。生产服务器没有执行检查或发布 |
| 旧工作流显式关联 | 真实 SQLite 中创建带额外 verify 节点的工作流，显式关联后节点、输出和历史定义不变；多文件不可映射图拒绝保存并回滚；高级编辑字段漂移拒绝覆盖 |
| 修订及持久化 | 草稿保存、重复修订冲突、配置变更使报告失效、数据库重新打开、多环境共享源码同步均由真实验收测试断言 |
| UI | 原生窗口逻辑约 1462×920；部署容器约 1238、838、778、518 px 实际显示检查。778/518 使用应用列表入口，无横向溢出；长报告正文滚动、固定底部操作区可用；Escape 后焦点返回原配置按钮 |

本机开发数据库 `~/.shellspan-dev/shellspan-v1.db` 保留了真实 UI 验收配置：应用 `f40eab38-7382-4567-b697-39b711d5fabd`，环境 `566e8b32-3756-4122-8213-53b9a6930b1a`（生产），工作流 `workflow-289787b6-bcda-4b31-acf8-028bc2882b96`，环境修订 2。仅保存了所选已有 profile 的引用和 `/apps/for-you` 等本机元数据；平台和端口尚未在生产验证。它是接入未完成草稿，不是上线记录；原有 j/Test 工作流未修改。

`deployment-center-product-phase-2-evidence.json` 是真实隔离验收的记录，包含临时 SQLite 的应用/工作流、原项目检测、真实检查报告和结果；其临时路径随测试清理，不能当成可用发布产物或生产运行。测试在 for-you 隔离副本生成文件并建立临时 Git 基线，原项目摘要前后相同。

## 验证结果

- `pnpm review:frontend`：258 文件通过、1 文件跳过；2377 测试通过、2 跳过；TypeScript/Vite 构建通过。现有分包和动态导入警告仍存在。
- 就近前端回归：5 文件、50 测试通过，包含接入流程的真实证据展示、双语键、固定滚动结构、键盘焦点及受管字段只读回归。
- `cargo test --manifest-path src-tauri/Cargo.toml deployment:: -- --skip real_application_onboarding_acceptance`：80 通过、5 ignored。
- `cargo test --manifest-path src-tauri/Cargo.toml db::tests:: --quiet`：27 通过。
- `real_application_onboarding_acceptance --ignored --nocapture`：最终 1 通过，真实 Git/SQLite/Docker Compose/SSH/SFTP；新增的容器权限不误报与高级编辑漂移保护均通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`pnpm check:rust:includes`（45 include 文件）、`git diff --check`：通过。

没有新增模拟 IPC 或模拟 SSH 执行器。既有回归测试中的模拟实现仅用于回归，不作为真实部署证据。原生凭据验收使用唯一 fixture ID 的真实 OS keychain 条目，结束后删除；`isolated_native_for_tests` 不打开用户共享 vault，不影响生产 CredentialManager。测试没有把凭据写入证据文件。

复验时在本工作树启动 `docker compose -f tests/deployment-e2e/compose.yml -p shellspan-deployment-e2e up -d --wait`，再设置 `SHELLSPAN_PHASE2_PROJECT=/Users/zhengbiwen/Developer/my/for-you`、`SHELLSPAN_PHASE2_INCLUDED_UNTRACKED='["public/og.png","src/styles/signal.css"]'`、可选报告路径，并使用 `tests/deployment-e2e` 的本机 fixture 环境运行 ignored test。必须保持 SSH 目标为 `127.0.0.1:22224`。测试结束后使用相同 compose project 的 `down --volumes` 清理。

本次隔离容器/网络已清理，专用原生验收实例和 1432 Vite 已关闭。用户原有 1420 Vite/发行版实例未停止。临时 `/tmp/ShellSpan-Phase2.app` 指向 debug binary，若以后重启必须重新编译匹配的 devUrl；不应当作发行应用使用。

## 改动归属

继承阶段 1 handoff 所列全部 UI 未提交改动，以及阶段 1 的 source_binding/compose_release、docker_archive、docker_compose_executor、local_artifact_executor、node_registry、run_coordinator、workflow_schema、commands/mod/lib、前端 types/IPC 和协议改动。不得回滚或将其误认为本阶段全部新增。

本阶段新增：`applications.rs`、`application_schema.sql`、`readiness.rs`、`deployment_files.rs`、`application_acceptance.rs`、前端 `applications.ts`、`application-center.tsx`、`application-onboarding.test.tsx` 及阶段 2 evidence/handoff。

本阶段叠加修改：db migration/tests，commands/mod/lib 注册，workflow_schema 可选 applicationBinding，source_binding 的分支/改动文件检测与定位错误，docker_compose_executor 的安全引号 helper 可见性，keychain 的仅测试原生构造器，types/IPC，高级编辑器外层入口及其测试，中英 locale、协议第 17 节。其他继承文件未主动重设计。

## 明确限制及后续阶段

- 阶段 2 完成的是接入和可定位的准备缺口，不代表 for-you 已经可发布。原项目尚无部署文件，数据目录、访问地址、basePath、生产架构和接管方式还需按真实环境确认。未执行生产部署、初始化或数据迁移。
- 首次接管、非空目录归属、容器 UID:GID 实际读写仍阻塞；阶段 4 必须通过独立计划和真实证据接通，不能仅将状态改为 passed。证书校验不得关闭。
- 当前 ingress 未知时保持 unchecked。阶段 3 需要区分“发布前入口配置/信任验证”与“服务发布后可用性”，解决首次未运行服务的检查时序，保留必要证书和代理阻塞。
- 高级编辑器对已关联工作流受管字段的直接改动目前保护为只读/拒绝保存；不静默反向覆盖。后续若增加“显式导入高级字段”需展示差异并同步应用修订。
- 生成器仅支持具备 pnpm 锁文件和 build/start 脚本的 Node 应用；支持范围在引导中显示。单服务 Compose、非敏感 configs、明确 bind mount 的限制继续沿用阶段 1。
- 本阶段实际渲染覆盖宽/窄容器和中文键盘焦点。1418/858/428 的完整目标矩阵、英文实际渲染及所有异常路径留阶段 5 完整验收，不能将当前检查当作该矩阵已完成。

## 串行交接

下一阶段：部署中心完善 · 阶段 3：发布体验。接入退出条件已达到；阶段 3 继续在同一实际工作树实现发布概览、准备详情、审批摘要、运行结果和服务观测投影。退出条件：不进画布完成发布；过期、配置冲突和端口冲突阻止执行。使用真实隔离环境，不以 mock 代替验收。

下一任务 ID：`01a0d69e-bcf6-7892-9ece-ffb77ae42652`（local）。已创建，本任务停止代码编辑。

阶段 3 完成并通过退出条件后再新建阶段 4；阶段 4 通过后再新建阶段 5。每阶段写 handoff，创建前 list_projects，使用保存项目 local 环境作载体，但所有命令和编辑必须显式使用 `/Users/zhengbiwen/.codex/worktrees/7f64/ShellSpan`。不得另建不继承改动的工作树，不并行编辑，不跳阶段，不 commit/tag/push。创建后 wait_threads 获取进展并输出 created-thread 指令，把下一任务 ID 写入交接。阶段 5 完成后不再创建后续任务。缺少必要条件时留在当前阶段说明，不能伪称通过。设计批准不构成对生产 `175.178.66.45` 的发布或写入授权。
