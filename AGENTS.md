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

### UI、布局与反馈

- 优先使用 `src/components/ui/` 中已有的 shadcn 组件、尺寸和变体，不为单个页面硬编码颜色、边框、圆角或控件高度。工作台中的紧凑卡片优先使用 `size="sm"`、`radius="compact"`；需要清晰边界时使用 `variant="outline"`。
- 工作台中同级 Card 的横向和纵向间距统一使用 `gap-3`（12px）；Card 内部字段、按钮或指标可按组件语义使用更小或更大的间距，但不得用内部间距替代卡片容器间距。
- 同一操作行中的 Input、Select 和 Button 必须视觉等高。不要假设不同组件的同名 `size` 天然一致；检查共享组件定义和实际渲染尺寸。若差异属于全局设计系统问题，修正共享 primitive 并增加组件测试。
- 工作台页面顶部统一使用 `WorkbenchPageHeader` 的默认内边距和高度结构，不做页面级 padding 覆盖。窄容器中的 Header 操作区应尽量保持单行；搜索框需使用 `min-w-0 flex-1` 允许收缩，并在宽容器断点恢复固定宽度，避免页面切换时因按钮换行产生高度跳动。
- Select 的 `value` 只用于状态与提交，用户界面必须显示可读 label，不能直接暴露数据库 ID、内部枚举或 `all`、`none` 等原始值。Base UI Select 应向根组件传入同源的 `{ value, label }` `items` 映射，触发器和选项列表共用该映射；所有 label 遵循 i18n。
- 长弹框必须形成完整的高度收缩链：`DialogContent` 使用明确或有上限的视口内高度，固定 Header/Footer 使用 `shrink-0`，中间容器使用 `min-h-0 flex-1`，仅正文 `ScrollArea` 滚动。只设置 `max-height` 不足以保证 flex/grid 子项收缩，也不得让操作栏滚出视口。
- 滚动条应属于全宽滚动层并保持可见；内容内边距放在滚动层内部。不要用会把滚动条推入 `overflow-hidden` 裁剪区的负边距。需要滚动条贴边时，应让滚动层延伸到未裁剪的父级边缘，同时在内容容器补回内边距，并验证窄屏行为。
- 主从双栏和工作台面板必须从页面容器到 grid、Card、ScrollArea 连续设置 `min-h-0`/`flex-1`。工作台可能被 AI 面板动态压窄，布局断点必须基于 `WorkbenchPage` 的 container query（`@min-*`），不能仅使用视口级 `sm`/`lg`；宽容器中侧栏卡片占满可用高度、两侧各自滚动，窄容器中切回自然纵向布局。
- Card 的主要操作优先放入标题右侧的 `CardAction`。仅当操作语义确实属于底部确认区时使用 `CardFooter`；无状态、无结果的空 `CardContent` 不应产生大块留白。次要且低频的信息（如历史记录）若持续挤占主流程空间，优先放入 Dialog/Drawer。
- 一次性成功或失败（保存、刷新、构建请求、上传请求、列表加载等）使用 Toast，并在展示后清理错误状态、防止 Strict Mode 或重复渲染造成重复通知。需要持续查看或会阻塞流程的状态（恢复门禁、审批状态、构建/预检/上传/执行结果）保留在对应上下文的 Alert；确认操作使用 Dialog。不要同时用 Toast 和 Alert 重复呈现同一错误。
- UI 修复必须增加就近回归测试，至少覆盖可读 label、控件尺寸、滚动/高度结构、CardAction 位置、Toast 去重或响应式结构中的相关项；布局类问题还应在代表性窗口尺寸下进行一次实际渲染检查。

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
