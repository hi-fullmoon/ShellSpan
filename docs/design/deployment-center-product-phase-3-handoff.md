# 部署中心完善：阶段 3 交接

日期：2026-09-25。实际工作树：`/Users/zhengbiwen/.codex/worktrees/7f64/ShellSpan`。基线 HEAD：`bc3de48f76e57bd65c5420937b4b40b599a2e13b`。本任务：`01a0d69e-bcf6-7892-9ece-ffb77ae42652`。

**阶段 3 退出条件已达到。** 真实隔离后端与原生 UI 均完成发布；原生流程从应用概览准备、审核并执行，无需进入画布。配置与端口冲突在真实隔离环境拒绝；有效期守卫使用真实时钟验证。没有提交、创建 tag 或推送。

## 已实现

- 应用概览增加准备发布、发布记录、当前受管版本、准备详情和服务观测入口，复用现有 coordinator、运行步骤、审批与恢复入口，不要求打开画布。
- 准备进度包含 workflow/run 身份并支持取消；准备期间禁止切换应用与高级工作流。审批显示冻结源码变更、目标主机、产物、Compose 服务、验证范围、恢复策略及有效期，配置和源码说明来自候选计划。
- 新建 Compose 发布检查冻结产物中的项目与端口占用；执行拿到同 endpoint 锁后再次校验有效期、工作流修订、未知运行和实际目标。恢复核对使用相同锁。
- 只读 HTTP 探测失败可按策略重试；写操作结果未知仍进入核对流程。成功发布记录实际验证证据；手动观测仅允许已冻结的 preflight/HTTP 节点，不改变历史发布结果，不声称持续在线或公开入口可用。
- 未配置公开入口显示提示，仅允许服务器本机验证；已配置入口要求可连接且 TLS 可信，发布前的 HTTP 响应不被当作应用可用性证据。
- 发布弹框使用固定 Header/Footer 与收缩滚动正文；关闭返回实际触发按钮，审批关闭返回详情内操作。

## 已通过验证

- `real_application_release_acceptance --ignored --nocapture`：最终真实验收 1 通过，156.21 秒。真实 for-you 隔离副本、Git、SQLite、原生 OS keychain、Docker build、Linux SSH/SFTP、镜像加载、Compose 启动及 `/for-you/` HTTP 检查均实际执行；原项目摘要前后相同。
- 真实配置修订冲突拒绝旧候选审批；审批后以真实 `nc` 占用端口，执行前预检拒绝，目标目录仍无写入。解除占用后同一冻结候选实际发布成功。该测试结束后停止自己的 Compose 服务。
- 过期守卫用真实时钟等待验证，审批、开始执行、锁后复核共用该守卫；尚未在原生界面等待完整 30 分钟计划过期。
- 原生 UI 在 18:35–18:40 完成真实 readiness、准备、审批、发布与手动观测。冻结目标为 `shellspan@127.0.0.1:22224`；执行 38 秒，12 个步骤成功，概览显示当前受管版本与带时间的本机观测。随后明确停止该测试服务，再观测得到 `unknown`，原发布仍为 `succeeded`，两者独立持久化。
- `pnpm review:frontend`：259 文件通过、1 跳过；2382 测试通过、2 跳过；TypeScript/Vite 构建通过。现有分包/动态导入警告仍在。
- 新增 `application-release.test.tsx` 5 项全部通过，使用实际验收 JSON 渲染观测、冻结主机/HTTP 范围、完成运行不可重复执行、滚动结构与关闭焦点、双语键。未新增模拟 IPC/SSH。既有全量回归中的模拟不作为真实执行证据。
- `cargo test --manifest-path src-tauri/Cargo.toml deployment:: -- --skip real_application_onboarding_acceptance`：81 通过、6 ignored。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`pnpm check:rust:includes`、`git diff --check` 通过。

## 真实证据与验收环境

`deployment-center-product-phase-3-evidence.json` 是 isolated acceptance 的原始投影，包含 approval detail、成功运行详情、事件、回执、观测和冲突断言。其生产目标标记仅描述该 isolated test，不代表整个共享开发数据库的活动。

`deployment-center-product-phase-3-native-evidence.json` 从原生验收实际使用的 SQLite 只读导出，包含精确计划、审批、全部回执与事件，以及成功观测和主动停掉测试服务后的未知观测。它保留历史事实，不表示清理后服务仍在运行。

- 后端运行：`run-99db8d67-0d52-455f-bb19-fd4e04153830`，发布 `release-a39f176579ceaa32`。
- 原生 UI 运行：`run-10f860d9-7e97-4b2e-ad2a-5581ad006c2b`，发布 `release-aca5ac128b042166`。受管镜像 `example/web:release-53afdd8db567cb4d`，归档约 233.2 MiB，端口仅绑定 127.0.0.1:3000。
- SSH fixture：`127.0.0.1:22224`，Compose project `shellspan-deployment-e2e`。fixture 增加 iproute2，以实际 `ss` 验证端口。本阶段结束已停止并移除 fixture 容器/网络；服务与数据目录不能作为阶段 4 已存在的环境使用。
- 原生应用：忽略目录 `.phase3-acceptance/ShellSpan-Phase3.app`，dev URL `http://localhost:1433`；专用实例和 1433 Vite 已关闭。用户原有 1420 与发行版实例未停止。
- 保留的真实源码副本：`/private/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/.tmpcoMLCs`。其中 Dockerfile/compose.yaml/.dockerignore 通过既有生成器产生并明确纳入。原始 `/Users/zhengbiwen/Developer/my/for-you` 没有改写。
- 原生 UI 新建应用 `82dff4d7-1ba1-4eef-b40f-ed2e619e597c`（for-you · Phase3 UI）、环境 `c6af0601-35fd-41d4-b933-903a497bde99`（隔离验收）、工作流 `workflow-8f807b4d-05a0-48a7-a70c-aff803cd8b0b`。目标仅为 fixture；根目录 `/srv/shellspan-deployment/phase3-ui-20260925` 已作为测试基础设施创建，项目同名、端口 3000、平台 linux/arm64。未挂载数据，未宣称完成阶段 4 数据验收。
- 原生 UI 窗口约 1462×920，工作台容器约 1238、838、518 px 实际检查：概览可读、准备禁用与未知观测显示正确；窄容器使用应用列表入口、字段纵向排列、正文滚动，无横向溢出。空态详情固定操作区正常，Escape 关闭后焦点回到“发布记录与详情”。完整发布过程中检查准备进度、冻结摘要、可展开配置、审批正文滚动与固定操作区、运行步骤和证据抽屉；原生按钮执行成功。验收结束恢复 AI 面板宽度 400 并收起。完整 1418/858/778/428 双语矩阵仍由阶段 5 执行。
- macOS 钥匙串正常恢复后通过原生凭据路径完成验收。曾返回 `In dark wake, no UI possible`；未修改 ACL、未绕过系统认证。以后独立重编译实例遇到系统提示时仍需正常授权，不能改成普通配置存储。
- 共享开发数据库中另有生产草稿在 11:49 的远端只读准备检查报告，不能声称整个原生验收期间“从未连接生产”。尚未确认该记录由哪个实例触发。没有生产发布、初始化、停止服务或文件上传的验收步骤；后续禁止再次针对生产草稿操作。

## 阶段 4 边界与串行交接

- 数据目录的容器 UID:GID 真实访问、首次接管、连续升级、失败恢复、人工回退、重启核对和保留策略仍需阶段 4 实现与真实验收。当前 readiness 对已有服务/非空目录/挂载权限仍保守阻塞，不可直接改为 passed。
- 此次原生测试没有挂载弹幕数据。页面 HTTP 200 不证明数据完整；阶段 4 必须使用真实接口写入、读取、重启、升级和回退验证同一条数据。不得向生产注入测试数据。
- 外部入口可用性尚未验证；UI 明确显示本机检查范围。节点默认 displayName 仍沿用现有模板英文名称，完整双语、响应式和异常态矩阵由阶段 5 验收。
- 测试 Compose 在 commit 后从 `.shellspan/staging/<release>` 移至 `releases/<release>`；Docker 的创建时 config_files label 仍可能保留旧路径。阶段 4 的恢复、重启核对应使用冻结发布目录和证据，不能仅凭该 label 推断文件仍在。
- 下一任务使用保存项目的 local 环境作为载体，所有命令和编辑必须显式使用 `/Users/zhengbiwen/.codex/worktrees/7f64/ShellSpan`，保留全部未提交改动。创建后记录 ID、`wait_threads` 获取进展并输出 created-thread 指令。阶段 4 通过后创建阶段 5，阶段 5 不再创建后续任务。生产发布或写入仍需独立明确授权。

下一任务 ID：`01a0d82a-a051-71a2-9d26-0b2cd8d0291e`（部署中心完善 · 阶段 4：首次接管与恢复）。

保留阶段 1、2 handoff 所列全部改动。本阶段新增 release_acceptance.rs、application-release.tsx、application-release.test.tsx 及本阶段证据/检查点；叠加修改 readiness/source binding、native executor、coordinator、command/query、schema/types、IPC/store、approval/runtime/应用中心、双语 locale 和协议。没有 commit、tag 或 push，不修改默认仓库、原始 for-you 或生产服务。
