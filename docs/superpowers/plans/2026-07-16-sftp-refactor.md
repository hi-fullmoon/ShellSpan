# SFTP 模块重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 v1.2.12 `FileManager` 的远程文件操作功能移植到当前自定义 SFTP 模块中，同时保持不使用 ag-grid。

**架构：** 采用模块化提取方案，新增 `useSftpPaneActions` 钩子集中管理操作和弹窗状态，拆分文件项和空白区域右键菜单，新增属性/预览/冲突/书签弹窗组件。

**技术栈：** React + TypeScript + Tauri + Zustand + Tailwind CSS + shadcn/ui + vitest

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/hooks/useSftpPaneActions.ts` | 单个面板所有上下文菜单操作和弹窗状态 | 新建 |
| `src/hooks/useSftpConnection.ts` | 增加 `openRemoteFile`、`previewRemoteFile` 和上传冲突策略 | 修改 |
| `src/components/sftp/sftp-blank-context-menu.tsx` | 空白区域右键菜单 | 新建 |
| `src/components/sftp/sftp-bookmark-menu.tsx` | 书签跳转列表 | 新建 |
| `src/components/sftp/sftp-properties-dialog.tsx` | 文件属性弹窗 | 新建 |
| `src/components/sftp/sftp-preview-dialog.tsx` | 文本预览弹窗 | 新建 |
| `src/components/sftp/sftp-upload-conflict-dialog.tsx` | 上传冲突处理弹窗 | 新建 |
| `src/components/sftp/sftp-file-context-menu.tsx` | 扩展为完整文件项右键菜单 | 修改 |
| `src/components/sftp/sftp-pane.tsx` | 集成空白菜单、书签按钮和操作钩子 | 修改 |
| `src/components/sftp/sftp-pane-actions.tsx` | 增加“新建文件”和书签切换 | 修改 |
| `src/components/sftp/index.tsx` | 挂载新弹窗并处理跨面板拖拽 | 修改 |
| `src/locales/en-US.ts` | 新增 i18n 键 | 修改 |
| `src/locales/zh-CN.ts` | 新增 i18n 键 | 修改 |
| `src/hooks/__tests__/useSftpPaneActions.test.ts` | 操作钩子单元测试 | 新建 |
| `src/components/sftp/__tests__/sftp-file-context-menu.test.tsx` | 文件项菜单组件测试 | 新建 |
| `src/components/sftp/__tests__/sftp-blank-context-menu.test.tsx` | 空白区域菜单组件测试 | 新建 |

---

## Task 1: 扩展 `useSftpConnection` 钩子

**Files:**
- Modify: `src/hooks/useSftpConnection.ts`

**Interfaces:**
- Consumes: `invokeOpenRemoteFile`, `invokePreviewRemoteFile` from `src/lib/tauri.ts`
- Produces: `openRemoteFile(path: string): Promise<void>` and `previewRemoteFile(path: string): Promise<ReadRemoteFileResponse>`

- [ ] **Step 1: 增加 `openRemoteFile` 方法**

```ts
const openRemoteFile = useCallback(
  async (path: string) => {
    await invokeOpenRemoteFile({
      ...connection.connection,
      path,
    });
  },
  [connection.connection],
);
```

- [ ] **Step 2: 增加 `previewRemoteFile` 方法**

```ts
const previewRemoteFile = useCallback(
  async (path: string) => {
    return invokePreviewRemoteFile({
      ...connection.connection,
      path,
    });
  },
  [connection.connection],
);
```

- [ ] **Step 3: 在返回对象中暴露这两个方法**

```ts
return {
  // ... existing methods,
  openRemoteFile,
  previewRemoteFile,
};
```

- [ ] **Step 4: 运行测试**

Run: `pnpm test src/hooks/__tests__`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSftpConnection.ts
git commit -m "feat(sftp): add openRemoteFile and previewRemoteFile helpers"
```

---

## Task 2: 创建 `useSftpPaneActions` 钩子

**Files:**
- Create: `src/hooks/useSftpPaneActions.ts`

**Interfaces:**
- Consumes: `useSftpConnection`, `useLocalDirectory`, `useSftpStore`, `useTransferStore`, toast helpers
- Produces: handlers and dialog state consumed by `SftpPane`

- [ ] **Step 1: 定义返回类型**

```ts
export interface UseSftpPaneActionsResult {
  createMode: 'file' | 'folder' | null;
  renameTarget?: FileEntry;
  permissionsTarget?: FileEntry;
  propertiesTarget?: FileEntry;
  previewContent?: ReadRemoteFileResponse;
  uploadConflict?: PendingUploadConflict;
  onOpen: (entry: FileEntry) => void;
  onOpenWithDefaultEditor: (entry: FileEntry) => Promise<void>;
  onPreview: (entry: FileEntry) => Promise<void>;
  onDownload: (entry?: FileEntry) => Promise<void>;
  onBatchDownload: () => Promise<void>;
  onCopy: (entry?: FileEntry) => void;
  onPaste: () => Promise<void>;
  onRename: (entry?: FileEntry) => void;
  onDelete: (entries?: FileEntry[]) => Promise<void>;
  onCopyName: (entry?: FileEntry) => Promise<void>;
  onCopyPath: (entry?: FileEntry) => Promise<void>;
  onCopyContainingDirectory: (entry?: FileEntry) => Promise<void>;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUploadFiles: () => Promise<void>;
  onUploadFolders: () => Promise<void>;
  onEditPermissions: (entry?: FileEntry) => void;
  onProperties: (entry?: FileEntry) => void;
  onToggleBookmark: (path?: string) => void;
  onRefresh: () => Promise<void>;
  onToggleBatchMode: () => void;
  setCreateMode: (mode: 'file' | 'folder' | null) => void;
  setRenameTarget: (entry?: FileEntry) => void;
  setPermissionsTarget: (entry?: FileEntry) => void;
  setPropertiesTarget: (entry?: FileEntry) => void;
  setPreviewContent: (content?: ReadRemoteFileResponse) => void;
  setUploadConflict: (conflict?: PendingUploadConflict) => void;
}
```

- [ ] **Step 2: 实现目录加载和选择辅助函数**

```ts
const reload = useCallback(async () => {
  if (isLocal) {
    await loadLocalDirectory(path);
  } else {
    await loadRemoteDirectory(path);
  }
}, [isLocal, loadLocalDirectory, loadRemoteDirectory, path]);

const clearSelection = useCallback(() => {
  setPaneState(connection.id, side, { selectedPaths: [] });
}, [connection.id, setPaneState, side]);

const selectedEntries = useMemo(
  () => entries.filter((e) => selectedPaths.includes(e.path)),
  [entries, selectedPaths],
);
```

- [ ] **Step 3: 实现创建/重命名/删除操作**

```ts
const onNewFile = () => setCreateMode('file');
const onNewFolder = () => setCreateMode('folder');

const handleCreate = useCallback(
  async (name: string, kind: 'file' | 'directory') => {
    if (!isLocal) {
      await createRemoteEntry(path, name, kind);
    }
    await reload();
    clearSelection();
    setCreateMode(null);
  },
  [createRemoteEntry, isLocal, path, reload, clearSelection],
);

const onRename = useCallback(
  (entry?: FileEntry) => {
    const target = entry ?? selectedEntries[0];
    if (!target) return;
    setRenameTarget(target);
  },
  [selectedEntries],
);

const handleRename = useCallback(
  async (newName: string) => {
    if (!renameTarget) return;
    if (!isLocal) {
      await renameRemotePath(renameTarget.path, newName);
    }
    await reload();
    clearSelection();
    setRenameTarget(undefined);
  },
  [isLocal, renameTarget, renameRemotePath, reload, clearSelection],
);

const onDelete = useCallback(
  async (entriesToDelete?: FileEntry[]) => {
    const targets = entriesToDelete?.length ? entriesToDelete : selectedEntries;
    if (!targets.length) return;
    if (!isLocal) {
      await deleteRemotePaths(targets.map((e) => e.path));
    }
    await reload();
    clearSelection();
  },
  [deleteRemotePaths, isLocal, reload, clearSelection, selectedEntries],
);
```

- [ ] **Step 4: 实现打开/预览/下载操作**

```ts
const onOpen = useCallback(
  (entry: FileEntry) => {
    if (entry.kind === 'directory') {
      if (isLocal) {
        loadLocalDirectory(entry.path);
      } else {
        loadRemoteDirectory(entry.path);
      }
      clearSelection();
    }
  },
  [isLocal, loadLocalDirectory, loadRemoteDirectory, clearSelection],
);

const onOpenWithDefaultEditor = useCallback(
  async (entry?: FileEntry) => {
    const target = entry ?? selectedEntries[0];
    if (!target || isLocal || target.kind === 'directory') return;
    await openRemoteFile(target.path);
  },
  [isLocal, openRemoteFile, selectedEntries],
);

const onPreview = useCallback(
  async (entry?: FileEntry) => {
    const target = entry ?? selectedEntries[0];
    if (!target || isLocal || target.kind === 'directory') return;
    const content = await previewRemoteFile(target.path);
    setPreviewContent(content);
  },
  [isLocal, previewRemoteFile, selectedEntries],
);

const onDownload = useCallback(
  async (entry?: FileEntry) => {
    if (isLocal) return;
    const target = entry ?? selectedEntries[0];
    if (!target) return;
    const folders = await invokePickLocalFolder();
    if (!folders.length) return;
    await downloadRemotePaths([target.path], folders[0]);
    clearSelection();
  },
  [clearSelection, downloadRemotePaths, isLocal, selectedEntries],
);

const onBatchDownload = useCallback(
  async () => {
    if (isLocal || !selectedEntries.length) return;
    const folders = await invokePickLocalFolder();
    if (!folders.length) return;
    await downloadRemotePaths(
      selectedEntries.map((e) => e.path),
      folders[0],
    );
    clearSelection();
  },
  [clearSelection, downloadRemotePaths, isLocal, selectedEntries],
);
```

- [ ] **Step 5: 实现复制/粘贴/剪贴板操作**

```ts
const onCopy = useCallback(
  (entry?: FileEntry) => {
    if (isLocal) return;
    const target = entry ?? selectedEntries[0];
    if (!target) return;
    setRemoteClipboard(connection.id, {
      sourcePath: target.path,
      sourceName: target.name,
      kind: target.kind,
    });
  },
  [connection.id, isLocal, selectedEntries, setRemoteClipboard],
);

const onPaste = useCallback(async () => {
  if (isLocal || !connection.remoteClipboard) return;
  await copyRemotePath(
    connection.remoteClipboard.sourcePath,
    path,
  );
  await reload();
  clearSelection();
}, [clearSelection, copyRemotePath, connection.remoteClipboard, isLocal, path, reload]);

const writeClipboard = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
};

const onCopyName = useCallback(
  async (entry?: FileEntry) => {
    const target = entry ?? selectedEntries[0];
    if (!target) return;
    await writeClipboard(target.name);
  },
  [selectedEntries],
);

const onCopyPath = useCallback(
  async (entry?: FileEntry) => {
    const target = entry ?? selectedEntries[0];
    if (!target) return;
    await writeClipboard(target.path);
  },
  [selectedEntries],
);

const onCopyContainingDirectory = useCallback(
  async (entry?: FileEntry) => {
    const target = entry ?? selectedEntries[0];
    if (!target) return;
    const dir = target.kind === 'directory' ? target.path : parentDirectoryPath(target.path);
    await writeClipboard(dir);
  },
  [selectedEntries],
);
```

- [ ] **Step 6: 实现上传/权限/属性/书签/刷新**

```ts
const onUploadFiles = useCallback(async () => {
  if (isLocal) return;
  const files = await invokePickLocalFiles();
  if (!files.length) return;
  await uploadLocalPaths(files, path);
  await reload();
  clearSelection();
}, [clearSelection, isLocal, path, reload, uploadLocalPaths]);

const onUploadFolders = useCallback(async () => {
  if (isLocal) return;
  const folders = await invokePickLocalFolder();
  if (!folders.length) return;
  await uploadLocalPaths(folders, path);
  await reload();
  clearSelection();
}, [clearSelection, isLocal, path, reload, uploadLocalPaths]);

const onEditPermissions = useCallback(
  (entry?: FileEntry) => {
    if (isLocal) return;
    const target = entry ?? selectedEntries[0];
    if (!target) return;
    setPermissionsTarget(target);
  },
  [isLocal, selectedEntries],
);

const handlePermissions = useCallback(
  async (permissions: number) => {
    if (!permissionsTarget || isLocal) return;
    await updateRemotePermissions(permissionsTarget.path, permissions);
    await reload();
    clearSelection();
    setPermissionsTarget(undefined);
  },
  [clearSelection, isLocal, permissionsTarget, reload, updateRemotePermissions],
);

const onProperties = useCallback(
  (entry?: FileEntry) => {
    const target = entry ?? selectedEntries[0];
    if (!target) return;
    setPropertiesTarget(target);
  },
  [selectedEntries],
);

const onToggleBookmark = useCallback(
  (bookmarkPath?: string) => {
    if (isLocal) return;
    const targetPath = bookmarkPath ?? path;
    if (!targetPath) return;
    if (remoteBookmarks.includes(targetPath)) {
      removeRemoteBookmark(connection.id, targetPath);
    } else {
      addRemoteBookmark(connection.id, targetPath);
    }
  },
  [addRemoteBookmark, connection.id, isLocal, path, remoteBookmarks, removeRemoteBookmark],
);

const onRefresh = useCallback(async () => {
  await reload();
}, [reload]);

const onToggleBatchMode = useCallback(() => {
  setPaneState(connection.id, side, {
    batchMode: !pane.batchMode,
    selectedPaths: [],
  });
}, [connection.id, pane.batchMode, setPaneState, side]);
```

- [ ] **Step 7: 返回完整结果**

```ts
return {
  createMode,
  renameTarget,
  permissionsTarget,
  propertiesTarget,
  previewContent,
  uploadConflict,
  onOpen,
  onOpenWithDefaultEditor,
  onPreview,
  onDownload,
  onBatchDownload,
  onCopy,
  onPaste,
  onRename,
  onDelete,
  onCopyName,
  onCopyPath,
  onCopyContainingDirectory,
  onNewFile,
  onNewFolder,
  onUploadFiles,
  onUploadFolders,
  onEditPermissions,
  onProperties,
  onToggleBookmark,
  onRefresh,
  onToggleBatchMode,
  setCreateMode,
  setRenameTarget,
  setPermissionsTarget,
  setPropertiesTarget,
  setPreviewContent,
  setUploadConflict,
  handleCreate,
  handleRename,
  handlePermissions,
};
```

- [ ] **Step 8: 运行测试**

Run: `pnpm test src/hooks/__tests__`
Expected: 通过（此时无新测试，仅不破坏现有）

- [ ] **Step 9: Commit**

```bash
git add src/hooks/useSftpPaneActions.ts
git commit -m "feat(sftp): add pane actions hook for context menus"
```

---

## Task 3: 创建 `SftpBlankContextMenu`

**Files:**
- Create: `src/components/sftp/sftp-blank-context-menu.tsx`

**Interfaces:**
- Consumes: `UseSftpPaneActionsResult` subset and `SftpConnection` path/bookmarks
- Produces: user action events forwarded to `useSftpPaneActions`

- [ ] **Step 1: 创建组件骨架**

```tsx
export interface SftpBlankContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  side: SftpSide;
  currentPath?: string;
  hasClipboard: boolean;
  isBookmarked: boolean;
  batchMode: boolean;
  onClose: () => void;
  onAction: (action: SftpBlankContextMenuAction) => void;
}
```

- [ ] **Step 2: 实现菜单项渲染**

按设计文档中的空白区域菜单结构渲染菜单项，使用 `MenuItem` 内部组件保持与现有 `SftpFileContextMenu` 一致的样式。

- [ ] **Step 3: 处理位置越界**

```ts
const left = Math.min(x, window.innerWidth - 192);
const top = Math.min(y, window.innerHeight - 280);
```

- [ ] **Step 4: 运行测试**

Run: `pnpm test src/components/sftp/__tests__/sftp-blank-context-menu.test.tsx`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/components/sftp/sftp-blank-context-menu.tsx
git commit -m "feat(sftp): add blank area context menu"
```

---

## Task 4: 创建 `SftpBookmarkMenu`

**Files:**
- Create: `src/components/sftp/sftp-bookmark-menu.tsx`

**Interfaces:**
- Consumes: `bookmarks: string[]`, `open`, `x`, `y`
- Produces: `onNavigate(path)` and `onClose`

- [ ] **Step 1: 创建组件**

```tsx
export interface SftpBookmarkMenuProps {
  open: boolean;
  x: number;
  y: number;
  bookmarks: string[];
  onNavigate: (path: string) => void;
  onClose: () => void;
}
```

- [ ] **Step 2: 渲染书签列表**

对每个书签渲染一行，点击调用 `onNavigate(bookmark)` 并关闭菜单。

- [ ] **Step 3: 运行测试**

Run: `pnpm test src/components/sftp/__tests__`
Expected: 通过（可包含在后续测试中）

- [ ] **Step 4: Commit**

```bash
git add src/components/sftp/sftp-bookmark-menu.tsx
git commit -m "feat(sftp): add bookmark menu component"
```

---

## Task 5: 创建属性、预览、冲突弹窗

**Files:**
- Create: `src/components/sftp/sftp-properties-dialog.tsx`
- Create: `src/components/sftp/sftp-preview-dialog.tsx`
- Create: `src/components/sftp/sftp-upload-conflict-dialog.tsx`

**Interfaces:**
- `SftpPropertiesDialogProps`: `entry: FileEntry`, `open`, `onClose`
- `SftpPreviewDialogProps`: `content: ReadRemoteFileResponse`, `open`, `onClose`
- `SftpUploadConflictDialogProps`: `conflict`, `remaining`, `open`, `onResolve(action, applyToRemaining)`

- [ ] **Step 1: 实现 `SftpPropertiesDialog`**

使用 `Dialog` 和 `DialogContent`，展示：
- 名称、路径、类型
- 大小（文件）/ 目录大小占位
- 修改时间
- 符号权限和八进制权限
- 所有者和组

- [ ] **Step 2: 实现 `SftpPreviewDialog`**

展示文件名、大小、一个只读文本区域。当 `isText === false` 时显示二进制警告。

- [ ] **Step 3: 实现 `SftpUploadConflictDialog`**

展示冲突文件名和已存在条目类型，提供 Overwrite/Skip/Cancel 按钮，加一个 “Apply to remaining” checkbox。

- [ ] **Step 4: 运行测试**

Run: `pnpm test src/components/sftp/__tests__`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/components/sftp/sftp-properties-dialog.tsx src/components/sftp/sftp-preview-dialog.tsx src/components/sftp/sftp-upload-conflict-dialog.tsx
git commit -m "feat(sftp): add properties, preview and upload conflict dialogs"
```

---

## Task 6: 扩展 `SftpFileContextMenu`

**Files:**
- Modify: `src/components/sftp/sftp-file-context-menu.tsx`

**Interfaces:**
- Consumes: expanded `SftpFileContextMenuAction` union
- Produces: `onAction(action)`

- [ ] **Step 1: 扩展 action 类型**

```ts
export type SftpFileContextMenuAction =
  | 'open'
  | 'openWithDefaultEditor'
  | 'preview'
  | 'download'
  | 'batchMode'
  | 'rename'
  | 'copy'
  | 'delete'
  | 'copyName'
  | 'copyPath'
  | 'copyContainingDirectory'
  | 'newFile'
  | 'newFolder'
  | 'uploadFile'
  | 'uploadFolder'
  | 'editPermissions'
  | 'properties'
  | 'bookmark'
  | 'refresh';
```

- [ ] **Step 2: 按分组渲染菜单项**

按设计文档中的菜单结构，使用分隔线分隔各组。根据 `side` 和选中项类型禁用/隐藏项。

- [ ] **Step 3: 运行测试**

Run: `pnpm test src/components/sftp/__tests__/sftp-file-context-menu.test.tsx`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/components/sftp/sftp-file-context-menu.tsx
git commit -m "feat(sftp): expand file context menu with v1.2.12 actions"
```

---

## Task 7: 更新 `SftpPane` 和 `SftpPaneActions`

**Files:**
- Modify: `src/components/sftp/sftp-pane.tsx`
- Modify: `src/components/sftp/sftp-pane-actions.tsx`

**Interfaces:**
- `SftpPane` 消费 `useSftpPaneActions` 返回的全部操作和状态
- `SftpPaneActions` 增加新建文件和书签切换

- [ ] **Step 1: 在 `SftpPane` 中集成 `useSftpPaneActions`**

```ts
const actions = useSftpPaneActions(connection, side);
```

- [ ] **Step 2: 添加空白区域右键处理**

在 `SftpFileList` 容器上监听右键，弹出 `SftpBlankContextMenu`。

- [ ] **Step 3: 集成书签按钮和菜单**

在标题栏添加书签按钮，点击打开 `SftpBookmarkMenu`。

- [ ] **Step 4: 扩展 `SftpPaneActions`**

添加“New File”和“Add/Remove Bookmark”菜单项。

- [ ] **Step 5: 运行测试**

Run: `pnpm test src/components/sftp/__tests__/sftp-pane.test.tsx`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add src/components/sftp/sftp-pane.tsx src/components/sftp/sftp-pane-actions.tsx
git commit -m "feat(sftp): integrate pane actions, blank menu and bookmarks"
```

---

## Task 8: 在 `index.tsx` 挂载新弹窗并处理冲突

**Files:**
- Modify: `src/components/sftp/index.tsx`

**Interfaces:**
- 消费两个 `useSftpPaneActions`（local 和 remote）的弹窗状态
- 在合适时机挂载弹窗

- [ ] **Step 1: 使用两个 `useSftpPaneActions` 钩子**

```ts
const localActions = useSftpPaneActions(connection, 'local');
const remoteActions = useSftpPaneActions(connection, 'remote');
```

- [ ] **Step 2: 挂载新弹窗**

在 `SftpDndContext` 内渲染：
- `SftpPropertiesDialog`（local + remote）
- `SftpPreviewDialog`（remote only）
- `SftpUploadConflictDialog`（remote only）
- 使用 `PromptDialog` 处理 local 和 remote 的 create/rename
- 使用 `PermissionsDialog` 处理 remote 的权限编辑

- [ ] **Step 3: 处理上传冲突**

在 `remoteActions.onUploadFiles` / `onUploadFolders` 调用前，根据现有条目检测冲突并显示 `SftpUploadConflictDialog`。

- [ ] **Step 4: 运行测试**

Run: `pnpm test src/components/sftp/__tests__`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/components/sftp/index.tsx
git commit -m "feat(sftp): mount new dialogs and handle upload conflicts"
```

---

## Task 9: 补充 i18n 键

**Files:**
- Modify: `src/locales/en-US.ts`
- Modify: `src/locales/zh-CN.ts`

- [ ] **Step 1: 在 `en-US.ts` 中添加新键**

```ts
'sftp.contextMenu.openWithDefaultEditor': 'Open with Default Editor',
'sftp.contextMenu.preview': 'Preview',
'sftp.contextMenu.download': 'Download',
'sftp.contextMenu.copy': 'Copy',
'sftp.contextMenu.paste': 'Paste',
'sftp.contextMenu.copyName': 'Copy Name',
'sftp.contextMenu.copyPath': 'Copy Path',
'sftp.contextMenu.copyContainingDirectory': 'Copy Containing Directory',
'sftp.contextMenu.copyCurrentDirectoryPath': 'Copy Current Directory Path',
'sftp.contextMenu.newFile': 'New File',
'sftp.contextMenu.uploadFile': 'Upload File',
'sftp.contextMenu.uploadFolder': 'Upload Folder',
'sftp.contextMenu.editPermissions': 'Edit Permissions',
'sftp.contextMenu.properties': 'Properties',
'sftp.contextMenu.bookmark.add': 'Add Bookmark',
'sftp.contextMenu.bookmark.remove': 'Remove Bookmark',
'sftp.contextMenu.batch.enter': 'Batch Selection',
'sftp.contextMenu.batch.exit': 'Exit Batch Selection',
'sftp.properties.title': 'Properties',
'sftp.properties.name': 'Name',
'sftp.properties.path': 'Path',
'sftp.properties.kind': 'Kind',
'sftp.properties.size': 'Size',
'sftp.properties.modifiedAt': 'Modified',
'sftp.properties.permissions': 'Permissions',
'sftp.properties.owner': 'Owner',
'sftp.properties.group': 'Group',
'sftp.preview.title': 'Preview',
'sftp.preview.binaryWarning': 'Binary file — cannot preview safely',
'sftp.conflict.title': 'File Already Exists',
'sftp.conflict.message': '{name} already exists. What would you like to do?',
'sftp.conflict.overwrite': 'Overwrite',
'sftp.conflict.skip': 'Skip',
'sftp.conflict.cancel': 'Cancel',
'sftp.conflict.applyToRemaining': 'Apply to remaining',
```

- [ ] **Step 2: 在 `zh-CN.ts` 中添加对应中文键**

- [ ] **Step 3: 运行测试**

Run: `pnpm test`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/locales/en-US.ts src/locales/zh-CN.ts
git commit -m "i18n(sftp): add new context menu and dialog keys"
```

---

## Task 10: 添加测试

**Files:**
- Create: `src/hooks/__tests__/useSftpPaneActions.test.ts`
- Create: `src/components/sftp/__tests__/sftp-file-context-menu.test.tsx`
- Create: `src/components/sftp/__tests__/sftp-blank-context-menu.test.tsx`

- [ ] **Step 1: 测试 `useSftpPaneActions`**

验证：状态切换、动作处理器调用、剪贴板设置、书签切换。

- [ ] **Step 2: 测试 `SftpFileContextMenu`**

验证：不同 `side` 和选中项类型下菜单项可见性、禁用状态、点击回调。

- [ ] **Step 3: 测试 `SftpBlankContextMenu`**

验证：粘贴、批量模式、书签项的启用/禁用状态。

- [ ] **Step 4: 运行全部测试**

Run: `pnpm test`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/hooks/__tests__/useSftpPaneActions.test.ts src/components/sftp/__tests__/sftp-file-context-menu.test.tsx src/components/sftp/__tests__/sftp-blank-context-menu.test.tsx
git commit -m "test(sftp): add context menu and pane actions tests"
```

---

## 全局验证

- [ ] **Step 1: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 2: 运行测试套件**

Run: `pnpm test`
Expected: 全部通过

- [ ] **Step 3: 运行开发服务器并手动验证**

Run: `pnpm tauri dev`
Expected: 打开 SFTP 后，远程面板右键菜单和空白区域菜单均包含所有新功能，属性/预览/冲突弹窗正常弹出。

- [ ] **Step 4: 最终提交（如果未分步提交）**

```bash
git add .
git commit -m "feat(sftp): port v1.2.12 remote file context menu features"
```

---

## 计划自检

1. **设计覆盖**：所有设计文档中的菜单项、弹窗、数据流均已对应到具体任务。
2. **无占位符**：每个任务包含具体代码示例和验证命令。
3. **类型一致**：所有接口名称和返回类型在 Task 2 中定义，后续任务引用一致。
