# 部署中心完善：阶段 1 交接

日期：2026-09-25。状态：阶段 1 实现及退出条件已通过，可串行进入阶段 2。

## 工作树与授权边界

- 真实工作树：`/Users/zhengbiwen/.codex/worktrees/7f64/ShellSpan`。
- 起点：`bc3de48f76e57bd65c5420937b4b40b599a2e13b`，隔离工作树，包含用户已有未提交内容。
- 保存项目 ShellSpan 的原目录为 `/Users/zhengbiwen/Developer/my/ShellSpan`；后续任务只将其 local 环境作为载体，所有代码命令必须显式使用上面的真实工作树。
- 未创建本工作树的 commit、tag，未 push，未修改生产服务器 `175.178.66.45`。真实 for-you 项目未被写入；构建文件只生成在临时验收副本中。
- 依据：[完整设计](deployment-center-product-completion-design.md)，本阶段仅覆盖第 12 节阶段 1。

## 已实现

1. `SourceBinding` 保存 ID、修订、规范化本地路径、Git 仓库身份、明确纳入的未跟踪文件和排除目录。仓库身份由历史根提交与对象格式计算，支持重新定位并保留历史来源；要求完整 Git 根目录，拒绝浅仓库。
2. 新增只读 `inspect_deployment_source_binding`，经类型化 IPC 返回绑定、HEAD 和未跟踪候选清单。不执行项目脚本。绑定暂时作为 `source.snapshot.config.binding` 随工作流事务和修订保存；阶段 2 再建立应用/环境关联，不要另建执行引擎。
3. 原生执行器不再读取进程 current_dir。未绑定工作流仍可读取，但新的源码准备会明确失败。运行冻结完整绑定和实际文件摘要。
4. 捕获实际文件字节及执行位，检查路径、软链接、文件类型、大小与捕获期间修改；只纳入选定未跟踪文件，忽略文件不能自动进入。每次构建另行物化，Compose 使用原始冻结副本，构建脚本不能改写随后打包的源码配置。
5. Compose 使用既有 serde_yaml 和官方 `docker compose config` 合并/验证，生成一个发布专用 compose.yaml。受管服务绑定本次归档镜像，删除 build，固定 pull_policy=never；激活须匹配 bundle 的项目、服务和禁止拉取策略。
6. 对 configs 文件依赖要求明确非敏感声明，复制到同一 CAS bundle 并改写相对引用。bind mount 必须与登记的 source/target/readOnly 一致，禁止根目录/Docker socket，禁止自动创建缺失宿主机目录。端口须明确绑定回环地址。
7. 验证归档 config 摘要及 OCI manifest/index 关联，支持经典和 containerd 镜像存储的准确身份。远端加载后必须匹配冻结 config 或 manifest/index 身份，不仅比较标签。
8. 原生执行器版本更新为 docker-compose/2，协议、Rust、TypeScript、IPC 注册同步。旧版本只保留证据核对与取消补偿兼容路径；旧待执行计划必须重新准备，不能借兼容路径获得新发布权限。

## 本阶段文件

- 新增：`src-tauri/src/deployment/source_binding.rs`、`src-tauri/src/deployment/compose_release.rs`。
- 修改：`src-tauri/src/deployment/{commands,docker_archive,docker_compose_executor,local_artifact_executor,mod,node_registry,run_coordinator,workflow_schema}.rs`、`src-tauri/src/lib.rs`。
- 修改：`src/lib/deployment/types.ts`、`src/lib/ipc/tauri.ts`、`protocol/deployment/workflow.md`。
- 新增：本交接文档及 [真实验收身份记录](deployment-center-product-phase-1-evidence.json)。
- 本阶段没有修改任何 UI 组件、样式或文案。

代码快照校验（SHA-256；不含交接文档本身）：

```text
git diff --binary -- src-tauri src/lib protocol
1e3b70d6b30261265f3b453321d0ba12a130780735b4e70b7967931223e257d2
source_binding.rs
fa219f19d4ab2b3ac31fb1a530d11548eba49f4f134721504a4244c94d3b3497
compose_release.rs
841d4097762b607964f6f643a1c0d3ef4213f2aaa2bfd67ee0147f179cb74027
```

## 进入阶段时已有改动

以下均属于继承内容，不要当成本阶段新增内容，也不要回滚：

```text
M src/components/workbench/__tests__/deployment-workflow-center.test.tsx
M src/components/workbench/__tests__/remote-health-section.test.tsx
M src/components/workbench/deployment-workflow-center.tsx
M src/components/workbench/deployment-workflow-runtime.tsx
M src/components/workbench/deployment/deployment-workflow-tabs.tsx
M src/components/workbench/deployment/node-inspector.tsx
M src/components/workbench/deployment/workflow-editor-toolbar.tsx
M src/components/workbench/deployment/workflow-list-pane.tsx
M src/components/workbench/deployment/workflow-step-list.tsx
M src/components/workbench/remote-health-section.tsx
M src/stores/deploymentWorkflowStore.ts
?? docs/design/deployment-center-product-completion-design.md
?? src/components/workbench/deployment/__tests__/deployment-icon-tooltips.test.tsx
?? src/components/workbench/deployment/__tests__/native-title.test.tsx
?? src/components/workbench/deployment/__tests__/workflow-editor-toolbar-tooltip.test.tsx
```

## 实际测试与退出条件

| 退出条件/检查 | 实际证据 | 结果 |
| --- | --- | --- |
| 两个真实项目独立构建 | for-you 的 Next.js 生产构建；ShellSpan 的 TypeScript/Vite 前端构建；分别使用真实锁文件在 Docker Linux/arm64 中执行 | 通过 |
| 工作区修改不改变冻结产物 | `real_project_frozen_image_acceptance` 在捕获后把临时工作区 Dockerfile 和 Compose 改成无效内容，仍使用冻结副本完成构建和配置生成 | 两项目均通过 |
| 加载镜像与配置一致 | 实际 docker load + docker image inspect；归档 config/manifest 与加载身份匹配；生成 Compose 的 image 与归档引用完全一致且无 build | 两项目均通过 |
| 隔离 Linux/SSH/SFTP | `pnpm test:deployment:e2e` 创建本机 DinD/SSH 环境；真实 SFTP、镜像加载、Compose、HTTP、静态切换测试 2 项通过；结束后容器和网络已清理 | 通过 |
| 部署领域 Rust 回归 | `cargo test --manifest-path src-tauri/Cargo.toml deployment:: -- --skip real_project_frozen_image_acceptance --skip isolated_deployment --include-ignored` | 82 通过，0 失败 |
| 前端相关测试 | `pnpm test src/lib/deployment src/lib/ipc/__tests__/deployment-tauri.test.ts` | 3 文件、9 测试通过 |
| 前端构建 | `pnpm build` | 通过；现有分包/动态导入警告仍存在 |
| 格式和 include 检查 | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`pnpm check:rust:includes`、`git diff --check` | 通过 |

既有 coordinator 回归套件包含模拟执行器测试，只作为已有行为回归，不作为真实发布证据；上表两项目镜像构建、Compose CLI 及隔离 SSH 测试是真实执行。本阶段没有新增 mock。

工具：Docker Engine/CLI 29.8.0，Compose 5.5.1，Buildx 0.37.0，rustc 1.95.0，pnpm 11.1.1。具体源码、归档、镜像摘要见 evidence.json。

可复验命令（所有命令 workdir 都是本工作树）：

```sh
SHELLSPAN_PHASE1_PROJECT=/Users/zhengbiwen/Developer/my/for-you \
SHELLSPAN_PHASE1_PROJECT_KIND=for-you \
SHELLSPAN_PHASE1_INCLUDED_UNTRACKED='["public/og.png","src/styles/signal.css"]' \
SHELLSPAN_PHASE1_REPORT=/tmp/shellspan-phase1-for-you.json \
cargo test --manifest-path src-tauri/Cargo.toml real_project_frozen_image_acceptance -- --ignored --nocapture

SHELLSPAN_PHASE1_PROJECT=/Users/zhengbiwen/.codex/worktrees/7f64/ShellSpan \
SHELLSPAN_PHASE1_PROJECT_KIND=shellspan \
SHELLSPAN_PHASE1_REPORT=/tmp/shellspan-phase1-shellspan.json \
cargo test --manifest-path src-tauri/Cargo.toml real_project_frozen_image_acceptance -- --ignored --nocapture
```

验收通过临时副本添加 Dockerfile/Compose 并建立临时 Git 基线，不修改原项目或当前工作树的 Git 历史。ShellSpan 镜像验证的是前端生产构建，不是 Linux Tauri 桌面发行包。临时 CAS 随测试清理；evidence.json 中的 artifactReference 是验收身份，不能当成桌面持久化运行记录或可用历史发布。最新两个验收镜像保留在本机 Docker，未推送仓库。

## 明确限制与后续工作

- 当前只支持一个受管服务/应用镜像。其他服务、secret、env_file、隐式变量、includes/extends、外部 configs、未支持能力都会阻塞，而非默默忽略。普通 environment 必须显式赋非敏感值；secret 物化尚未实现，不可写入普通 bundle。
- 本阶段支持明确声明的 configs 文件；env_file 目前按未支持依赖阻塞。阶段 2 的检测/表单必须显示此原因并提供改为显式非敏感环境配置的修复指引，不要假装所有 Compose 项目均可接入。
- 软链接、子模块、浅仓库、凭据类文件与常见缓存目录不支持进入快照。可以明确排除无关文件/目录；不能静默排除必要构建文件后宣称成功。验收排除了工具元数据、data 和 .env.example；for-you 明确纳入了两个未跟踪资源。
- 捕获目录只属于一次准备生命周期。应用在准备期间中断后需要重新准备；已完成的不可变 bundle 由现有 CAS 保存，执行/核对不再依赖可变源目录。
- source binding 的应用级持久化、修订竞争、重新定位入口、项目检测报告、四步接入及中英文错误提示属于阶段 2 后续实现；旧工作流必须显式关联。
- 未进行 UI 渲染检查（本阶段无 UI 修改）。未验收生产主机、代理、证书、持久数据迁移、真实 for-you 升级/恢复/回退与完整桌面交互。这些不是本阶段通过所代表的能力，仍须在阶段 2–5 逐项完成。
- 设计批准和本机验收不是生产发布授权。不得修改 `175.178.66.45`，除非后来取得明确授权。

## 串行交接

下一任务：部署中心完善 · 阶段 2：应用与环境接入。

下一任务 ID：`01a0d668-4da2-7d63-b157-1c952de7df71`（local）。已按保存项目 local 环境创建，并要求所有代码操作继续使用本真实工作树；阶段 1 停止代码编辑。

阶段 2 完成并通过设计第 12 节退出条件后，才新建阶段 3；阶段 3 完成后新建阶段 4；阶段 4 完成后新建阶段 5。各阶段分别写 phase-N-handoff.md，记录继承/新增改动和实际证据。每次创建前 list_projects，使用保存项目 local 环境作为载体，但所有代码命令继续指向本真实工作树；不得另建不继承改动的 worktree，不并行编辑，不跳阶段，不 commit/tag/push。创建后 wait_threads 获取进展并输出 created-thread 指令，将任务 ID 写入交接记录。

阶段 3：发布概览/准备详情/审批/运行及服务观测。阶段 4：首次接管/数据保护/恢复/回退与保留。阶段 5：双语/键盘/实际响应式渲染/真实端到端验收及最终报告。阶段 5 完成后不再创建后续任务。任何阶段缺少必要验证条件时，留在该阶段明确说明，不能伪称通过。
