# ShellSpan Agent Guide

本文件适用于整个仓库，子目录中的 `AGENTS.md` 可覆盖对应范围。

修改前检查 `git status --short`，不要覆盖、还原或格式化与任务无关的改动。工具版本以 `package.json`、`pnpm-lock.yaml` 和 `src-tauri/Cargo.toml` 为准。

## 目录职责

- `src/components/`：React UI；共享基础组件位于 `src/components/ui/`。
- `src/hooks/`、`src/stores/`：React hooks 与 Zustand 状态。
- `src/lib/`：领域逻辑和 IPC 适配；新增模块前阅读 `src/lib/README.md`。
- `src-tauri/src/`：Tauri 后端、SSH/SFTP、Agent 与 LLM runtime。
- `protocol/`：Agent 和 LLM 协议说明；协议行为变化时同步更新。

不要手工修改 `node_modules/`、`dist/`、`src-tauri/target/` 或 `src-tauri/gen/`。`src-tauri/vendor/portable-pty/` 是项目维护的补丁依赖，只有任务明确涉及该依赖时才修改。

## 常用命令

```bash
pnpm test
pnpm build
pnpm review:frontend
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm check:rust:includes
pnpm check:ai-styles
pnpm check:llm:catalog
```

先运行相关测试，再按影响范围扩大验证。

## 实现约定

### TypeScript 与 React

- 保持 TypeScript strict，不引入 `any`；使用 `@/` 别名和明确的领域类型。
- 领域逻辑放入对应目录，不创建根级 barrel；优先复用现有 UI 组件和设计 token。
- 用户可见文案必须通过 i18n；同时更新 `src/locales/zh-CN.ts` 与 `src/locales/en-US.ts`，并保持键集合一致。
- 测试放在离被测代码最近的 `__tests__/` 中，断言可观察行为。

### Tauri 与 Rust

- 前端调用后端时优先经过 `src/lib/ipc/tauri.ts` 的类型化适配层，不在组件中散布新的裸 `invoke`/事件处理。
- 新增或修改 Tauri command 时，同步检查 Rust command、`src-tauri/src/lib.rs` 注册、TypeScript 类型/适配器以及相关测试。
- SSH、SFTP、文件系统和网络阻塞操作不得阻塞 Tauri 主线程；沿用现有任务、取消令牌和事件模式。

### 安全与敏感数据

- 密码、私钥、API key 和 token 必须走系统钥匙串或 credential reference，不能写入日志、快照、源码或普通配置。
- 所有来自 UI、远端主机、文件路径和模型工具调用的输入都视为不可信；在 Tauri 边界完成校验和规范化。
- 涉及命令执行、文件删除、覆盖、上传/下载、审批或 Agent 权限的改动，要保留取消、确认、审计与脱敏语义。
- 删除本地文件应沿用项目的回收站实现；不要改成不可恢复的直接删除。

## 完成标准

- 新行为有测试；缺陷修复优先增加回归测试。
- 相关测试通过；跨前后端改动同时验证 TypeScript 构建和 Rust 测试。
- UI 改动检查双语文案、键盘与焦点、空态、加载态和错误态。
- 除非用户明确要求，否则不要创建 commit、tag 或推送。

提交信息使用英文 Conventional Commits。`pnpm version` 会修改版本、创建 commit 并打 tag，只能在用户明确要求发布时运行。
