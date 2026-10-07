# 已读取的真实报告摘录

2026-10-07。以下内容来自本会话工具实际读取的原生报告及退出状态；原 `/tmp` 文件在宿主清理后不可用。这是工具记录摘录，不是重新运行、伪造 IPC 响应或替代原始事件日志。代码与可重复入口保留在仓库。

| 原始报告 | 实际读取结果及范围 |
| --- | --- |
| `/tmp/shellspan-phase3-root-stable-XOvRdF/settings-review.json` | `exitCode=0, rootEntry=true, sessionsCreated=0, modelRequests=0, sourcePtyWrites=0`；最终 `agent_sandbox_defaults={"version":1,"defaults":{}}`。真实 PTY、生产控制器、SQLite、目录与偏好 IPC，双语目录选择、草稿恢复、根错误清理、忘记配置保留当前只读及真实成功 Toast；应用与来源已结束。没有实际后续模型／工具发送。 |
| `/tmp/shellspan-phase3-settings-wry-NQgJFL/settings-review.json` | `exitCode=0, sourcePtyWrites=0`；真实 Wry＋生产远端验证 IPC。实际 workspace/readOnly 验证从 unavailable 转 partial，显示 SFTP 规范化根；策略变化及 30 秒清除旧事实，真实 gap 双语映射。没有模型、资源授权或后续 Agent 执行验收。 |
| `/tmp/shellspan-phase5-cache-model-6nNARJ/model-check.json` | `passed=true, mode=cache-writes, modelId=MiniMax-M3, requests=5, nativeResults=2, sourcePtyWrites=0`；`initialApproval=true, reusedWithoutApproval=true, approvalRequiredAfterRevocation=true`。这是完整真实缓存请求／审批／执行／复用／生产撤销链，不外推其他模型、Windows 或缓存候选配置本身的权限。 |
| `/tmp/shellspan-phase3-root-wry-eRp0IT/settings-review.json` | `exitCode=0, rootEntry=true, sessionsCreated=0, sourcePtyWrites=0`；真实双语首次发送缺根 → 原 Dialog → 规范化目录 → 恢复未发送草稿并采用记忆 readOnly。属于最终根错误小修复之前的 GUI 记录。 |
| `/tmp/shellspan-phase3-root-wry-gU4X36/settings-review.json` | `sessionsCreated=1, sourcePtyWrites=0`，该轮条件被交互改为 Host，实际本地模型连接失败／重试，验收入口退出失败；不是零请求目录证据，不改写该事件日志或将其当作产品受限门禁失败。 |

最终前端工具汇总实际读取为 `296 files passed / 1 skipped, 2581 passed / 2 skipped`。本次 `pnpm test`、`pnpm build`、完整 `cargo test` 及 include 检查的 exec session 最终退出码均为 0；Rust 原始最终计数日志被清理前未读取汇总数字，因此不推算数字。较早已读取共享基线为 `1228 passed / 75 ignored / 0 filtered`，另 5 项集成。`cargo fmt --check` 退出 1，其现有差异另保留在当前证据日志；不整体格式化其他会话的共享代码。
