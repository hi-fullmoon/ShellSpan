# Deployment Workflow 运维、门禁与回滚

> 状态：阶段 6 正式启用基线  
> 适用版本：Deployment Workflow  
> 数据策略：旧部署记录保持不变，物理表改名为 `deployment_legacy_*`，生产代码不读取或删除

## 启用与关闭

`SHELLSPAN_DEPLOYMENT_WORKFLOW` 是 restart-scoped 门禁，仅接受明确的 true/false 值。缺失时默认开启；显式关闭或值无效时 fail closed。修改后必须重启应用。

| 门禁状态 | 允许 | 禁止 |
| --- | --- | --- |
| 开启 | 工作流 创建、修改、归档、准备、人工审批、执行；只读、取消、恢复、审计 | 任意单节点 effect IPC、自动审批、旧版 执行 |
| 关闭或无效 | 工作流 只读查看、取消、只读 reconcile、审计导出 | 创建、修改、归档、准备、审批、启动新执行 |

门禁关闭不会停止已经启动的进程，也不能证明远端状态；未完成 run 仍由启动恢复扫描，并在证据不足时保持 `state_unknown`。

## 启动恢复操作

1. 应用启动后只扫描 工作流 未完成 run。
2. 先验证 plan、workflow revision、target profile/host identity、Artifact CAS、node/executor version 和已完成 effect receipt。
3. 对执行中边界仅调用对应 executor 的 read-only `reconcile`，不传输、不切换、不重启、不删除。
4. 未开始可回到精确 `approved` 计划；已完成必须有完整 receipt；已补偿必须有补偿证据；证据缺失或漂移保持 `state_unknown`。
5. `state_unknown` 只能由用户发起再次只读检查；不得盲目重试 effect。

## 审计与敏感数据

- 工作流 审计导出上限为 2 MiB/1,000 个事件，使用原子临时文件发布；用户取消保存不会创建文件。
- 审计只导出稳定身份、状态、receipt 和输出 digest，不导出 raw output、远端文本、主机 endpoint、用户名、本地路径或 Secret。
- 工作流只能保存 `connectionProfileId` 与 allowlisted environment/config reference。密码、私钥、token 和 API key 继续保存在系统钥匙串。
- 事件标题必须是 `deployment.*` i18n key；远端 stdout/stderr 不能成为通知标题或审计字段。

## 正式启用门槛

以下条件必须同时成立：

- 全量前端、构建、Rust、格式、include/style/catalog 检查通过；
- `pnpm test:deployment:e2e` 的真实隔离 Docker Compose 与静态站点测试，以及恢复、审计、人工回滚、锁、磁盘和 CAS 门禁通过；
- 宽、中、窄、AI 挤压和窄屏长 Dialog 实际渲染证据通过；
- 生产 command 注册与前端调用面不存在 旧版、effectful 单节点 IPC 或自动审批；
- 不存在明文凭据、路径逃逸或未批准副作用。

## 运行时回滚门槛

出现任一情况应关闭门禁并重启，阻止新准备/审批/执行，同时保留取消、恢复和审计：

- 同一 target 出现交错副作用或锁失效；
- 重复幂等键产生第二次副作用；
- Artifact/receipt/plan/target/node-version 漂移未 fail closed；
- 崩溃恢复宣称成功或已补偿但缺少完整证据；
- 审计、事件或日志出现 Secret、未隔离远端文本或越过大小上限；
- 工作流 command 错误地读取旧表或调用旧执行路径。

关闭门禁不是数据回滚。不得自动删除 工作流 或旧表，也不得把新 工作流 run 降级交给旧执行器。代码版本回滚只允许回到仍理解 工作流 未完成 run、能继续取消/恢复/审计的已验证版本；否则保持当前版本、关闭 admissions 并人工处理。

## 已知限制

- 首版仅支持单 target 的 Docker Compose 与 Linux 原子相对 symlink 静态站点部署；
- systemd、OCI/S3/HTTP Artifact Provider、多主机批次、签名/SBOM trust policy、Kubernetes、Nomad 和插件执行器均未实现；
- Artifact CAS 保留策略已保护 lease/current/previous/audit 引用，但不会自动删除已发布远端 Release；
- 签名状态为 `notConfigured`，当前完整性依赖 SHA-256、固定 native executor、人工审批和 receipt/reconciliation；
- gate 为进程启动时读取，不支持运行中热切换。
