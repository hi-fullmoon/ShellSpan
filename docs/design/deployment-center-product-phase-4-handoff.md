# 部署中心完善：阶段 4 交接

日期：2026-09-25。实际工作树：`/Users/zhengbiwen/.codex/worktrees/7f64/ShellSpan`。本任务：`01a0d82a-a051-71a2-9d26-0b2cd8d0291e`。未创建 commit、tag 或推送。

**阶段 4 退出条件已达到。** 数据、权限、升级、历史回退、失败恢复、重启回执核对和保留保护均有真实隔离验收结果。

## 当前范围

用户最新要求优先：保留既有工作流列表、编辑器、部署记录和版本页签的布局、样式、控件与操作位置。默认入口已经恢复为既有工作流页面；源码、数据和只读检查从工作流设置的局部弹框进入，使用单页表单。不能恢复独立应用概览、应用中心默认页或四步向导，不开发独立接管平台。底层 Application/Environment/SourceBinding 和已有记录继续保留。

所有命令必须显式指定此工作树为 workdir，编辑使用此工作树绝对路径。保存项目 `/Users/zhengbiwen/Developer/my/ShellSpan` 仅为任务载体，禁止在那里编辑。真实原始项目 `/Users/zhengbiwen/Developer/my/for-you` 只读。生产 `175.178.66.45` 禁止连接、检查或写入；共享数据库中的生产草稿不能操作。

## 已实现

- 注册挂载要求明确数字 UID:GID。部署目录内仅允许 `shared` 下的数据路径，也可显式登记外部路径。只读 readiness 不再把 SSH 用户权限当成容器权限，显示发布审批后的强制探针要求。
- 审批后的 Compose 激活先用冻结镜像、同一 UID:GID 和挂载运行隔离临时容器，验证读/遍历及需要时的实际写入；只删除自身随机探针目录。失败不能启动服务。生成 Dockerfile 同步应用文件所有权并使用指定运行用户。
- 已受管服务的预检校验本地成功发布、提交目录中的 Compose 摘要、当前 marker 和实际容器身份。未知服务继续阻塞；不会依据过期的 `config_files` label 恢复。
- 手动回退重用已验证历史 bundle，跳过当前源码、构建和打包。当前 Dockerfile 损坏不影响历史 bundle 回退；目标预检、新计划、人工审批、执行门禁均保留。
- 健康检查失败后仅恢复冻结的上一版本，验证提交目录全部组件摘要并重新执行上一版本的 HTTP 验证。自动恢复要求挂载及容器身份相同，失败的原运行仍为失败。应用数据迁移兼容性不在此功能的保证范围。
- 丢失远端写操作回执时维持 `stateUnknown`，不能推断未执行并重放。
- 保留策略按成功计划保留指定数量的不同版本；重复回退不挤掉其他版本。当前/上一版、未决运行、租约与时间保护继续有效。没有新增远端版本或共享数据自动删除。
- 配置弹框使用共享 Dialog、独立正文滚动和无分隔线固定 Footer；修复设置弹框切换配置时抢回焦点的问题，增加真实证据驱动的回归测试。其他工作流布局保持原样。

## 验证

- 后端 deployment 相关测试：81 通过；忽略项由真实验收单独执行。
- 前端工作流与配置测试：42 通过。TypeScript/Vite 构建通过，仅既有分包提示。
- `cargo fmt -- --check`、`pnpm check:rust:includes`、`git diff --check` 通过。
- `isolated_container_user_permission_denial`：真实 SSH/Docker 镜像验证通过，10.93 秒。555 目录拒绝写探针且未创建服务；770 权限与 UID:GID 匹配后真实服务启动，探针目录无残留。
- 原生渲染使用既有 `.phase3-acceptance/ShellSpan-Phase3.app` 容器加载本阶段 1433 前端，只检查隔离工作流，不用于声称最新后端原生执行通过。实际检查默认工作流、设置入口、配置可读 label、正文滚动、固定 Footer、切换焦点；窗口约 1462×949 和 1200×781。完整双语/窄容器/异常态矩阵由阶段 5 完成。
- `real_application_recovery_acceptance`：1 通过，773.76 秒。真实 API 写入弹幕、重启、升级、升级后再写入、损坏当前 Dockerfile 后回退、故意 HTTP 失败后恢复均通过。两条非预设弹幕的 ID、完整对象及数据文件 SHA-256 均校验；原运行保留 failed，恢复回执为 `compose.restore`。
- 重新打开同一 SQLite 的原生 backend 能核对既有写入回执；临时移走真实远端回执后返回 StateUnknown，再恢复回执。实际 CAS 清理后受保留版本仍可验证，共享数据摘要不变。
- 最终证据为 `deployment-center-product-phase-4-lifecycle-evidence.json`。初次/升级/回退/失败运行依次是 `run-a983ae8a-6a41-4fbd-a308-e1680ba1fe57`、`run-136dd035-fd98-49f9-8153-af9a24ed7770`、`run-caa6a4ef-cfde-46a3-9372-b2dfbb2e4864`、`run-e78cf57e-bbe4-4e8b-8140-046531c9cc40`。

## 验收环境及边界

隔离 SSH fixture 是 `127.0.0.1:22224`，Compose project 为 `shellspan-deployment-e2e`。镜像存储改用该项目独立 Docker volume，避免多版本真实应用镜像耗尽内存盘。不得清理其他 Docker 项目。

验收服务已执行 Compose down；fixture 容器已 stop，独立 volume 与容器内测试证据暂留供阶段 5 按需核查。根目录 `/srv/shellspan-deployment/phase3-7e3457a1`，外部数据目录 `/srv/shellspan-deployment/phase3-7e3457a1-data`。本阶段开启的原生专用实例和 1433 Vite 已关闭。验收临时 SQLite/源码按测试生命周期释放，最终 JSON 是保留证据；不能把旧阶段 3 原生工作流误认成本次运行。

真实验收在原项目的独立临时副本运行 Git、构建、SQLite、系统钥匙串、SSH/SFTP、Docker/Compose 和应用 HTTP API。原项目摘要前后验证一致。首次数据验收采用显式登记的外部相邻目录；初始非空发布根目录仍保守阻塞，不能把任意已有服务自动标记受管。

保留全部阶段 1–3 未提交改动。本阶段主要叠加 coordinator、Docker executor、应用配置/生成器/readiness、retention、release acceptance、既有工作流设置入口、双语文案和协议。不可用 Git 撤销用户或其他阶段改动。

## 阶段 5

在相同工作树完成最终验收及必要局部修复；串行处理，不开子代理，不创建下一阶段任务。优先完成双语、窄容器、键盘/焦点、空态/加载/错误、运行失败/恢复/回退/状态未知显示。使用已有真实证据与已通过结果，只补缺失覆盖，不重复全量构建或同一完整生命周期测试。当前旧应用概览导出未被默认页面使用，不得把它重新接入主流程。

下一任务 ID：`01a0d857-da61-76f0-9c21-ea6019e98284`（部署中心完善 · 阶段 5：最终验收），使用保存 ShellSpan 项目的 local 环境作为载体，继续同一实际工作树。
