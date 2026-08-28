# TermBridge 审核机制

本机制用于保证改动在合并前具备可复核的实现、测试和失败路径。产品方向记录在 `docs/product-roadmap.md`；路线图不替代当前提交的自动化验证。

## 每次变更

1. 在变更说明中写明用户影响、风险、失败路径和恢复或取消方式。
2. 修改功能时同步更新对应测试；移除功能时同时清理入口、状态、协议、原生命令、夹具和文档。
3. 本地运行 `pnpm review:frontend`。修改 Rust 时再运行：

   ```bash
   cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
   cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
   ```

4. 涉及 SSH/SFTP 行为时运行隔离环境测试 `pnpm test:e2e:ssh`。
5. PR 必须通过仓库要求的检查，并解决全部审核意见。

## 安全边界

- Known Hosts 解析或校验失败必须失败关闭。
- AI API Key 只保存在本机配置边界，迁移必须先写入新位置再删除旧副本。
- 终端和 SFTP 工作区恢复必须执行版本、数量与大小上限校验。
- AI 生成命令只提供粘贴入口；应用不得自动发送回车执行。
- 日志、诊断包和 AI 上下文遵守同一套秘密遮蔽规则。

## 四周复盘

每四周按用户价值、可靠性、安全风险、维护成本和测试证据复盘当前路线图。没有足够价值的功能应优先收缩或移除，而不是仅因已有实现继续扩张。

## GitHub 分支保护

仓库管理员应在主分支禁止直接推送，要求至少一名非作者审核，并把前端、Rust 与隔离 SSH/SFTP 检查设为必需检查。
