# 本地文件管理器：复制 / 重命名 / 删除 支持

日期：2026-07-20

## 背景

SFTP 双栏文件管理器中，本地（local）面板的右键菜单将「复制」「重命名」「删除」显式禁用：

- `src/components/sftp/sftp-file-context-menu.tsx` 中 `canRename` / `canCopy` / `canDelete` 均带 `!isLocal` 条件
- `src/hooks/useSftpPaneActions.ts` 中 `onRename` / `onDelete` / `onCopy` 对 `isLocal` 直接 early-return
- `src-tauri` 不存在任何本地文件变更类命令（仅有上传/下载用的 `copy_local_paths_blocking`）

## 需求决策

| 问题 | 决策 |
|------|------|
| 删除行为 | 移到系统回收站（可恢复） |
| 复制语义 | 本地剪贴板 + 粘贴，支持多选 |
| 粘贴同名冲突 | 自动重命名副本（`name 副本 2` 风格） |
| 副本后缀 | 跟随界面语言（i18n），由前端传入 Rust |
| 方案 | 自定义 Tauri 命令（方案 A），与现有架构一致 |

## 设计

### 1. Rust 后端

**`src-tauri/Cargo.toml`**：新增 `trash = "5"`。

**`src-tauri/src/local_fs.rs`** 新增：

- `rename_local_path_blocking(path: String, new_name: String) -> Result<(), String>`
  - `new_name` 校验：非空、不含路径分隔符、不为 `.termbridge`（保留名）、不与同目录现有条目冲突
  - 使用 `fs::rename` 在同目录内改名
- `trash_local_paths_blocking(paths: Vec<String>) -> Result<(), String>`
  - 逐个 `trash::delete`；某个失败时返回错误并指明失败路径（已成功的不回滚，前端 reload 后状态自然正确）
- `paste_local_paths_blocking(source_paths: Vec<String>, destination_directory: String, copy_suffix: String) -> Result<Vec<String>, String>`
  - 复用现有 `copy_local_entry_to_path` 递归复制逻辑（含符号链接处理与 `.termbridge` 跳过）
  - 目标已存在时自动改名：`<stem> <copy_suffix>.<ext>`、`<stem> <copy_suffix> 2.<ext>`（无扩展名/目录则追加在末尾）
  - 返回实际写入的目标路径列表，便于前端选中/提示
  - 源与目标为同一条目时跳过（沿用 `paths_refer_to_same_entry`）

**`src-tauri/src/commands.rs`**：新增三个 `#[tauri::command]`（`rename_local_path`、`trash_local_paths`、`paste_local_paths`），异步包装 blocking 函数（沿用文件内既有模式）。在 `lib.rs` 的 `generate_handler!` 中注册。

### 2. 前端服务层

`src/lib/tauri.ts` 新增包装：`invokeRenameLocalPath`、`invokeTrashLocalPaths`、`invokePasteLocalPaths`（参数含 `copySuffix`）。

### 3. `src/hooks/useSftpPaneActions.ts`

- **本地剪贴板**：pane 本地状态 `localClipboard: FileEntry[] | undefined`；`onCopy` 本地分支记录全部选中条目并 toast 提示
- `onRename` / `handleRename`：移除 `isLocal` early-return；本地分支调用 `invokeRenameLocalPath` → `reload()` → `clearSelection()`
- `onDelete`：本地分支调用 `invokeTrashLocalPaths`（复用现有删除确认对话框，文案不变）
- `onPaste`：本地分支读取 `localClipboard`，调用 `invokePasteLocalPaths(paths, 当前目录, t('sftp.copySuffix'))` → `reload()` → `clearSelection()`
- 错误处理沿用现有 `logger.warn` + `error(...)` toast 模式

### 4. 右键菜单

- `sftp-file-context-menu.tsx`：`canRename` / `canDelete` 移除 `!isLocal`（其余 `canDownload` 等远端专属项保持不变）；`canCopy` 对本地改为 `hasSelection`（本地复制支持多选，远端仍限单选）
- `sftp-blank-context-menu.tsx`：本地面板空白处菜单显示「粘贴」，本地剪贴板为空时禁用
- 本地重命名的 `PromptDialog` 已存在于 `sftp/index.tsx:651-659`，无需新增 UI

### 5. i18n

- `src/locales/zh-CN.ts`：`sftp.copySuffix: '副本'`
- `src/locales/en-US.ts`：`sftp.copySuffix: 'copy'`
- 「粘贴」菜单项复用现有 `sftp.contextMenu.paste`

### 6. 边界情况

- 重命名为已存在名称 → Rust 返回错误，前端 toast 提示
- 回收站在无桌面环境下不可用 → 错误透传，toast 显示失败原因
- 粘贴到源条目自身所在目录 → 自动改名生成副本，不与自身冲突
- 多选复制后部分源文件被外部删除 → 粘贴时报错并指明路径

## 测试计划

- **Rust**（`local_fs.rs`，tempfile 单测）：
  - rename：成功、目标已存在、保留名、非法名称
  - paste：无冲突、自动 `副本`/`副本 2` 命名、带扩展名文件、目录递归、自身到同目录
  - trash：路径不存在时返回错误（成功路径依赖桌面环境，仅本地验证）
- **前端**：
  - `useSftpPaneActions.test.ts`：本地 rename / copy（写剪贴板）/ paste（调用命令并 reload）/ delete（调用 trash 命令）
  - `sftp-file-context-menu.test.tsx`：更新原「本地 rename 禁用」断言为启用；新增 copy/delete 启用断言
  - `sftp-blank-context-menu.test.tsx`：本地面板粘贴项的显示/禁用逻辑
- 验证命令：`cargo test`（src-tauri）、前端既有测试脚本（vitest）与 lint/typecheck
