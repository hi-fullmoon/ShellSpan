# TermBridge 审核机制

本机制把 `ROADMAP.md` 的承诺转换为合并前可执行的证据。路线图是产品方向，`docs/roadmap-audit.json` 是唯一状态台账；没有测试证据的条目不得标记为 `verified`。`roadmapMapping` 必须按原顺序逐字覆盖 NOW、NEXT、LATER 的每个工作项，`phaseExitCriteria` 必须逐字覆盖每个阶段退出条件；增删或近似改写任一侧都会让门禁失败。

## 每次变更

1. 在 PR 模板中说明对应审计 ID、风险、失败路径和恢复/取消方式。
2. 修改功能时同步更新测试；改变路线图状态时同步更新审计台账。
3. 本地运行 `pnpm review:frontend`。修改 Rust 时再运行：

   ```bash
   cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
   cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
   pnpm test:e2e:ssh
   ```

4. PR 必须通过 `Quality Gate`，并由至少一名非作者审核者批准。

## 状态规则

- `planned`：边界和测试策略已记录，尚未开始。
- `in-progress`：已有实现证据，但退出条件尚未全部满足。
- `verified`：失败/恢复路径已实现，自动化测试存在且全量门禁通过，并填写 `verifiedAt` 与 `tests`。
- `blocked`：存在明确外部阻断，记录原因和解除条件。
- `deferred`：复盘后有意移出当前阶段，不得伪装成完成。
- `researching`：仅用于 EXPLORE；已有候选边界和发现证据，但正式准入条件尚未全部满足，不构成产品承诺。

NOW、NEXT、LATER 是已经承诺的范围，审计不接受 `planned`、`in-progress`、`blocked`、`deferred` 或 `researching`；若实现或证据尚未完成，必须先完成最小安全实现与测试，不能只修改状态。阶段退出条件可使用 `pending-external` 表示必须等待当前提交进入托管平台检查的事实，例如尚未运行的 macOS/Windows CI；这种状态明确表示阶段尚未通过，不能被工作流定义或历史运行替代。LATER 的“已通过”声明要求其全部退出条件保持 `verified`。

`securityClosure` 固定检查 Known Hosts 失败关闭、AI API Key 仅存钥匙串和终端恢复契约三个边界。除证据路径必须存在外，脚本还扫描生产代码：禁止把 Known Hosts 路径解析错误用 `.ok()` 降级；禁止 AI provider 元数据重新出现 `apiKey`；要求迁移方向为 SQLite → 钥匙串且不删除安全副本；要求数据库拒绝 AI 敏感字段，并要求终端恢复前后端都执行版本与上限校验。

EXPLORE 条目还必须用 `roadmapItem` 精确且不重复地覆盖 EXPLORE 区域的全部五个候选项；“暂不进入范围”等其他项目不能冒充候选。每项记录 `candidate`、`admit` 或 `defer` 决策、明确的必要性判断，并逐项复核用户群、用户价值、维护成本、跨平台实现、安全模型、升级策略和自动化测试方案。全局 `failurePath` 和 `recovery` 字段必须说明失败关闭与恢复边界。即使处于 `researching`，也必须列出支撑当前判断的既有测试路径，并在评估中明确它们是可复用基础还是正式准入缺口。只有七项均为 `met`、必要性为真且条目具有 `verified` 测试证据时，审计才允许记录 `admit`；这只允许进入独立的路线图评审，不会自动建立正式阶段或发行承诺。

含“插件 API”的 EXPLORE 条目还必须记录 `extensionGates`。`dataContract` 只能在七项准入证据全部满足、必要性为真且自动化测试已验证后标记为 `stable`；在此之前 `pluginApi` 必须保持 `blocked`。稳定数据契约只是评估插件 API 的前置条件，不授权插件运行时、第三方代码执行、市场或新的网络/账户能力。

含“一次只验证一个方向”的协议 EXPLORE 条目还必须记录 `protocolGates`：`selectedDirection` 与 `directionsUnderValidation` 必须精确表示同一个具体方向，比较中的其他协议不得同时进入验证；`implementationGate` 只有在七项准入均为 `met`、`necessary: true`、`status: verified` 且决定为 `admit` 后才能标记为 `eligible`。`eligible` 也只允许独立评审安全、最小的候选基础，不自动授权实现或发布。

团队共享、集中策略与审计服务的 EXPLORE 条目还必须记录 `teamDiscoveryGates`，逐项复核连接/凭据、Known Hosts、会话与工作区恢复、Runbook/多主机、操作记录、脱敏导出、本地数据库、权限/审批、跨平台和自动化测试十个个人工作区前置。只有十项均为 `met`，`personalWorkspaceModel` 才能标记为 `stable`，随后才允许把 `productDiscoveryGate` 标记为 `eligible`。`independentReviewGate` 还必须等待七项 EXPLORE 准入均为 `met`、`necessary: true`、`status: verified` 且决定为 `admit`；它不授权账户、组织/成员、同步后端、集中策略执行、远程审计收集、插件、第三方代码、市场或托管服务。

## 四周复盘

审计台账的 `reviewedAt` 最多允许落后 35 天，超期会让 CI 失败。复盘必须逐条检查状态、证据路径、风险和测试策略，并按退出条件决定是否推进阶段。

## GitHub 分支保护

仓库管理员需要在 `main` 上启用：禁止直接推送、至少 1 个批准、旧批准在新提交后失效、要求解决全部讨论，并把 `Frontend and Audit`、`Rust (windows)`、`Rust (macos)`、`Isolated SSH/SFTP E2E` 设为必需检查。仓库文件无法代替托管平台上的分支保护设置。
