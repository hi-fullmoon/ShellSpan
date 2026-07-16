# SFTP 模块重构设计文档

## 日期

2026-07-16

## 背景

当前 TermBridge 的 SFTP 模块采用自定义的虚拟列表（`SftpFileList`）替换了 v1.2.12 中的 ag-grid 文件列表。新界面更简洁，但右键菜单功能大幅缩水：目前仅支持“打开/重命名/删除/权限”四项操作。v1.2.12 的 `FileManager.tsx` 提供了完整的远程文件操作菜单（新建、上传、下载、复制、粘贴、属性、预览、用默认编辑器打开、书签等），本次重构需要把这些能力迁移到新的 SFTP 模块中，同时保留当前自定义列表的终端风格。

## 目标

1. 将 v1.2.12 `FileManager` 的远程文件操作功能移植到当前 SFTP 模块。
2. 保留现有自定义文件列表（不使用 ag-grid）。
3. 为远程面板提供完整的右键菜单；本地面板提供合理的子集。
4. 保持代码模块化，避免单个组件过度膨胀。

## 设计方案

采用**模块化提取方案（方案 B）**：

- 新增 `useSftpPaneActions` 钩子，集中管理单个面板的所有上下文菜单操作和弹窗状态。
- 将右键菜单拆分为 `SftpFileContextMenu`（文件项）和 `SftpBlankContextMenu`（空白区域）。
- 新增属性、预览、上传冲突、书签等弹窗组件。
- 复用已有的 `PromptDialog` 和 `PermissionsDialog`。
- 后端命令已全部就绪（`create_remote_entry`、`copy_remote_path`、`open_remote_file`、`preview_remote_file`、`upload_local_paths`、`download_remote_paths` 等），无需修改 Rust 代码。

### 范围

- **远程面板**：获得完整的 v1.2.12 文件操作菜单。
- **本地面板**：获得打开、复制路径/名称、属性、批量选择等基础操作。
- **书签**：仅按连接保存在内存中，不持久化。

### 文件计划

**新建文件**

- `src/hooks/useSftpPaneActions.ts`：面板级操作钩子，包含所有菜单动作和弹窗状态。
- `src/components/sftp/sftp-blank-context-menu.tsx`：空白区域右键菜单。
- `src/components/sftp/sftp-bookmark-menu.tsx`：书签跳转列表。
- `src/components/sftp/sftp-properties-dialog.tsx`：文件属性弹窗。
- `src/components/sftp/sftp-preview-dialog.tsx`：文本预览弹窗。
- `src/components/sftp/sftp-upload-conflict-dialog.tsx`：上传冲突处理弹窗。

**修改文件**

- `src/components/sftp/sftp-file-context-menu.tsx`：扩展为完整的文件项右键菜单。
- `src/components/sftp/sftp-pane.tsx`：集成空白菜单、书签按钮和操作钩子。
- `src/components/sftp/sftp-pane-actions.tsx`：增加“新建文件”和书签切换。
- `src/components/sftp/index.tsx`：挂载新弹窗并处理跨面板拖拽。
- `src/hooks/useSftpConnection.ts`：增加 `openRemoteFile`、`previewRemoteFile` 和上传冲突策略支持。
- `src/locales/en-US.ts` 和 `src/locales/zh-CN.ts`：补充新的 i18n 键。

## 右键菜单结构

### 文件项右键菜单（远程面板）

按功能分组，用分隔线隔开：

1. **新建**：新建文件、新建文件夹、上传文件、上传文件夹
2. **打开**：打开、用默认编辑器打开、预览（仅文件）
3. **传输**：下载、进入批量选择
4. **编辑**：重命名、复制到剪贴板、删除
5. **剪贴板**：复制名称、复制路径、复制所在目录路径
6. **查看**：刷新、编辑权限、属性

### 空白区域右键菜单（远程面板）

1. **新建**：新建文件、新建文件夹、上传文件、上传文件夹
2. **剪贴板**：粘贴（存在远程剪贴板时可用）
3. **目录**：复制当前目录路径
4. **查看**：进入/退出批量选择、刷新、添加/移除书签

### 本地面板右键菜单

仅包含：打开、复制路径、复制名称、属性、批量选择。

## 数据流

1. `SftpPane` 调用 `useSftpPaneActions(connection, side)` 获取动作处理器和弹窗状态。
2. 文件项的右键事件由 `SftpFileListRow` 触发；空白区域右键事件由 `SftpFileList` 容器捕获。
3. 操作成功后调用 `useSftpConnection` 或 `useLocalDirectory` 重新加载目录，并通过 `useTransferStore` 跟踪传输进度。
4. 弹窗统一在 `src/components/sftp/index.tsx` 中挂载，由 `useSftpPaneActions` 返回的状态控制。

## 测试策略

- 为 `useSftpPaneActions` 编写单元测试，覆盖动作触发和状态切换。
- 为 `SftpFileContextMenu` 和 `SftpBlankContextMenu` 编写组件测试，验证菜单项可见性和禁用状态。
- 更新 `sftp-pane.test.tsx`，覆盖空白区域右键和书签菜单。
- 运行 `pnpm test` 和 `pnpm tauri dev` 进行端到端验证。
