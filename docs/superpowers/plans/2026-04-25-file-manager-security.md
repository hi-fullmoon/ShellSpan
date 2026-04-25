# 文件管理器安全功能增强计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为文件管理器增加三项安全相关功能：远程权限编辑（chmod）、敏感路径进入警告、上传私钥文件后自动修复权限为 600。

**Architecture:** 后端通过 ssh2 crate 的 `sftp.setstat()` 修改权限；前端在属性面板中内联权限编辑，在目录加载后检测路径敏感性并展示警告条，上传完成后对私钥文件自动设置限制性权限。

**Tech Stack:** Tauri (Rust + ssh2), React + TypeScript, Tailwind CSS, Zustand, vitest

---

## 文件结构

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/models.rs` | 修改 | 新增 `UpdateRemotePermissionsRequest` |
| `src-tauri/src/remote_fs.rs` | 修改 | 新增 `update_remote_permissions_blocking`、私钥检测函数、上传时动态权限 |
| `src-tauri/src/commands.rs` | 修改 | 新增 `update_remote_permissions` command |
| `src-tauri/src/lib.rs` | 修改 | 注册新 command |
| `src/components/FileManager.tsx` | 修改 | 属性面板权限编辑、敏感路径警告、上传权限修复 toast |
| `src/locales/zh-CN.ts` | 修改 | 新增翻译键 |
| `src/locales/en-US.ts` | 修改 | 新增翻译键 |
| `src/components/__tests__/FileManager.test.tsx` | 修改 | 新增安全功能测试 |

---

## Task 1: 后端权限编辑命令

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/remote_fs.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 models.rs 添加请求类型**

在 `OpenRemoteFileRequest` 之后、`DownloadRemotePathsRequest` 之前插入：

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRemotePermissionsRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) path: String,
    pub(crate) permissions: u32,
}
```

- [ ] **Step 2: 在 remote_fs.rs 添加权限更新实现**

在 `rename_remote_path_blocking` 之后、`delete_remote_path_blocking` 之前插入：

```rust
pub(crate) fn update_remote_permissions_blocking(
    request: UpdateRemotePermissionsRequest,
) -> Result<(), String> {
    let connected = connect_sftp(&request.connection)?;
    let path = std::path::Path::new(&request.path);
    let mut stat = connected
        .sftp
        .stat(path)
        .map_err(|error| format!("failed to stat remote path: {error}"))?;
    stat.perm = Some(request.permissions);
    connected
        .sftp
        .setstat(path, stat)
        .map_err(|error| format!("failed to update remote permissions: {error}"))
}
```

- [ ] **Step 3: 在 commands.rs 添加命令包装**

在 `open_remote_file` command 之后、`spawn_ssh_thread` 之前插入：

```rust
#[tauri::command]
pub(crate) async fn update_remote_permissions(
    request: UpdateRemotePermissionsRequest,
) -> Result<(), String> {
    use crate::remote_fs::update_remote_permissions_blocking;
    info!(
        "Updating remote permissions path={} permissions={:04o} {}",
        request.path,
        request.permissions,
        summarize_remote_connection_request(&request.connection)
    );
    let result =
        tauri::async_runtime::spawn_blocking(move || update_remote_permissions_blocking(request))
            .await
            .map_err(|error| format!("failed to join permissions update task: {error}"))?;
    if result.is_ok() {
        info!("Updated remote permissions successfully");
    }
    result
}
```

- [ ] **Step 4: 在 commands.rs 的 use 语句中引入新类型**

将第 1-7 行的 use 语句扩展为：

```rust
use crate::models::{
    ClosedReasonKind, CopyRemotePathRequest, CreateRemoteEntryRequest, DeleteRemotePathRequest,
    DownloadRemotePathsRequest, ManagedSession, OpenRemoteFileRequest, RemoteDirectoryListing,
    RemoteDirectoryRequest, RenameRemotePathRequest, SessionCommand, SessionCreateRequest,
    SessionStatus, SessionSummary, UpdateRemotePermissionsRequest, UploadLocalPathsRequest,
};
```

- [ ] **Step 5: 在 lib.rs 注册命令并导出**

在 `pub(crate) use remote_fs::{` 块中添加 `update_remote_permissions_blocking,`：

```rust
pub(crate) use remote_fs::{
    copy_remote_path_blocking, create_remote_entry_blocking, delete_remote_path_blocking,
    download_remote_paths_blocking, list_remote_directory_blocking, open_remote_file_blocking,
    rename_remote_path_blocking, update_remote_permissions_blocking, upload_local_paths_blocking,
};
```

在 `invoke_handler` 的 `generate_handler!` 宏中添加 `commands::update_remote_permissions,`：

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    commands::open_remote_file,
    commands::update_remote_permissions,
]);
```

- [ ] **Step 6: 编译验证后端**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无错误

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/remote_fs.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(remote-fs): add update_remote_permissions backend command"
```

---

## Task 2: 前端权限编辑 UI

**Files:**
- Modify: `src/components/FileManager.tsx`

- [ ] **Step 1: 添加权限编辑状态**

在 `FileManager.tsx` 的 `PropertiesState` 接口之后、`ToastState` 之前添加：

```typescript
interface PermissionEditState {
  entry: RemoteFileEntry;
  value: string;
}
```

在组件的 state hooks 区域（`const [properties, setProperties] = useState<PropertiesState>();` 之后）添加：

```typescript
const [permissionEdit, setPermissionEdit] = useState<PermissionEditState>();
```

- [ ] **Step 2: 添加权限编辑处理函数**

在 `openProperties` 函数之后、`handleDelete` 之前添加：

```typescript
const openPermissionEdit = (entry?: RemoteFileEntry) => {
  if (!ready) {
    return;
  }
  const target = entry ?? selectedEntry;
  if (!target || target.permissions === undefined) {
    return;
  }

  setSelectedPath(target.path);
  setContextMenu(undefined);
  setPermissionEdit({
    entry: target,
    value: formatPermissionOctal(target.permissions),
  });
  setProperties(undefined);
};

const submitPermissionEdit = async () => {
  if (!ready || !permissionEdit || !connection) {
    return;
  }

  const trimmed = permissionEdit.value.trim();
  const parsed = parseInt(trimmed, 8);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 0o7777) {
    setToast({
      message: t('fileManager.error.invalidPermissions'),
      tone: 'error',
    });
    return;
  }

  await runFileAction(
    () =>
      invoke('update_remote_permissions', {
        request: {
          ...connection,
          path: permissionEdit.entry.path,
          permissions: parsed,
        },
      }),
    t('fileManager.feedback.permissionsUpdated'),
  );
  setPermissionEdit(undefined);
};

const handlePermissionInputChange = (value: string) => {
  setPermissionEdit((current) => (current ? { ...current, value } : current));
};
```

- [ ] **Step 3: 在 context menu 添加"修改权限"入口**

在 entry context menu 的 `properties` 按钮之前添加：

```tsx
<MenuButton
  disabled={!ready || loading || working}
  label={t('fileManager.menu.editPermissions')}
  onClick={() => openPermissionEdit(contextMenu.entry)}
/>
```

- [ ] **Step 4: 在属性面板下方添加权限编辑内联表单**

找到属性面板的关闭代码（`</OverlayPanel>`），在其之前、权限详情行之后插入：

```tsx
{permissionEdit && permissionEdit.entry.path === properties.entry.path ? (
  <div className="flex flex-col gap-2 rounded-lg border border-cyan-900/50 bg-cyan-950/20 p-2">
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium tracking-[0.02em]">{t('fileManager.permissionEdit.label')}</span>
      <input
        autoFocus
        className="themed-input w-20 px-2 py-1 font-mono text-[12px] leading-5 outline-none"
        onChange={(event) => handlePermissionInputChange(event.target.value)}
        placeholder="0755"
        value={permissionEdit.value}
      />
      <span className="text-[11px] text-slate-400">
        {formatPermissionSymbolic(
          parseInt(permissionEdit.value.trim(), 8) || 0,
          permissionEdit.entry.kind,
        )}
      </span>
    </div>
    <div className="flex justify-end gap-1">
      <button className="icon-btn h-7 px-2 text-xs" onClick={() => setPermissionEdit(undefined)} type="button">
        {t('fileManager.dialog.cancel')}
      </button>
      <button
        className="primary-btn h-7 px-2 text-xs"
        disabled={working}
        onClick={() => void submitPermissionEdit()}
        type="button"
      >
        {t('fileManager.permissionEdit.save')}
      </button>
    </div>
  </div>
) : (
  <button
    className="themed-menu-item w-full rounded-md px-2 py-1 text-left text-[12px] font-medium"
    disabled={properties.entry.permissions === undefined || !ready || working}
    onClick={() => openPermissionEdit(properties.entry)}
    type="button"
  >
    {t('fileManager.menu.editPermissions')}
  </button>
)}
```

注意：需要确保这段代码放在 `</OverlayPanel>` 关闭标签之前，且在最外层 `</OverlayLayer>` 之前。

- [ ] **Step 5: 在切换属性面板时清理权限编辑状态**

在 `openProperties` 函数末尾添加 `setPermissionEdit(undefined);`：

```typescript
const openProperties = (entry?: RemoteFileEntry) => {
  // ... existing code ...
  setProperties({
    entry: target,
    directoryPath: target.kind === 'directory' ? target.path : parentDirectoryPath(target.path),
  });
  setPermissionEdit(undefined);
};
```

- [ ] **Step 6: Commit**

```bash
git add src/components/FileManager.tsx
git commit -m "feat(file-manager): add inline permission editing in properties panel"
```

---

## Task 3: 敏感路径警告

**Files:**
- Modify: `src/components/FileManager.tsx`

- [ ] **Step 1: 添加敏感路径检测函数**

在 `parentDirectoryPath` 函数之后、`kindLabel` 之前添加：

```typescript
const SENSITIVE_PATH_PATTERNS = [
  '/etc',
  '/root',
  '/boot',
  '/var/log',
  '/proc',
  '/sys',
];

function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\+/g, '/');
  if (SENSITIVE_PATH_PATTERNS.some((sp) => normalized === sp || normalized.startsWith(`${sp}/`))) {
    return true;
  }
  if (/(?:^|\/)\.ssh(?:\/|$)/.test(normalized)) {
    return true;
  }
  return false;
}
```

- [ ] **Step 2: 添加敏感路径警告状态**

在组件 state hooks 区域添加：

```typescript
const [sensitivePathWarning, setSensitivePathWarning] = useState(false);
```

- [ ] **Step 3: 在目录加载成功后检测敏感路径**

在 `loadDirectory` 函数的 `updateSessionState` 成功调用之后、`fileManagerLogger.debug('目录加载完成', ...)` 之前添加：

```typescript
setSensitivePathWarning(isSensitivePath(nextListing.path));
```

在 `loadDirectory` 的 catch 块末尾（`setFileError(...)` 之后）添加：

```typescript
setSensitivePathWarning(false);
```

- [ ] **Step 4: 在 ready/sessionId 变化时重置警告**

在 `useEffect(() => { setClipboard(undefined); ...` 的清理逻辑中，在 `setDragActive(false);` 之后添加：

```typescript
setSensitivePathWarning(false);
```

- [ ] **Step 5: 在 error 区域下方渲染警告条**

找到 `error` 和 `readOnly` 提示的渲染区域（约在 line 1766-1771）：

```tsx
{error ? <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-2 py-2 text-xs text-rose-300">{error}</div> : null}
{readOnly && listing ? (
  <div className="rounded-lg border border-amber-900/80 bg-amber-950/30 px-2 py-2 text-xs text-amber-200">
    {t('fileManager.readOnly')}
  </div>
) : null}
```

在其后添加：

```tsx
{sensitivePathWarning && !error ? (
  <div className="rounded-lg border border-amber-900/80 bg-amber-950/30 px-2 py-2 text-xs text-amber-200">
    {t('fileManager.sensitivePathWarning')}
  </div>
) : null}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/FileManager.tsx
git commit -m "feat(file-manager): add sensitive path warning banner"
```

---

## Task 4: 上传私钥文件自动修复权限

**Files:**
- Modify: `src-tauri/src/remote_fs.rs`
- Modify: `src/components/FileManager.tsx`

- [ ] **Step 1: 在 remote_fs.rs 添加私钥文件检测函数**

在 `upload_local_entry_to_path` 函数之前添加：

```rust
fn is_private_key_file(path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let lower = name.to_lowercase();
    lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".ppk")
        || name == "id_rsa"
        || name == "id_ed25519"
        || name == "id_ecdsa"
        || name == "id_dsa"
}
```

- [ ] **Step 2: 修改上传文件时的默认权限**

在 `upload_local_entry_to_path` 函数中，找到创建远程文件的 `open_mode` 调用（当前是 `0o644`）：

```rust
let mut remote_file = sftp
    .open_mode(
        remote_path,
        OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        0o644,
        OpenType::File,
    )
    .map_err(|error| format!("failed to create remote upload target: {error}"))?;
```

替换为：

```rust
let upload_mode = if is_private_key_file(remote_path) {
    0o600
} else {
    0o644
};
let mut remote_file = sftp
    .open_mode(
        remote_path,
        OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        upload_mode,
        OpenType::File,
    )
    .map_err(|error| format!("failed to create remote upload target: {error}"))?;
```

- [ ] **Step 3: 编译验证后端**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 4: 前端上传完成后提示权限修复**

在 `handleUploadPaths` 函数的 `setToast` 成功回调中，增加私钥权限修复的提示。找到这段代码：

```typescript
setToast({
  message:
    resolvedUpload.acceptedPaths.length === 1
      ? t('fileManager.feedback.uploadSingle', {
          name: localPathName(resolvedUpload.acceptedPaths[0]),
          suffix: skippedSuffix,
        })
      : t('fileManager.feedback.uploadMulti', {
          count: resolvedUpload.acceptedPaths.length,
          suffix: skippedSuffix,
        }),
  tone: 'success',
});
```

不需要修改前端 toast 逻辑，因为后端静默修复权限即可。用户能通过属性面板验证权限已改变。如需提示，可在上传逻辑中检测文件名并附加提示信息，但这会增加复杂度。保持静默修复更符合直觉。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/remote_fs.rs
git commit -m "feat(remote-fs): auto-restrict permissions to 600 for uploaded private key files"
```

---

## Task 5: i18n 翻译

**Files:**
- Modify: `src/locales/zh-CN.ts`
- Modify: `src/locales/en-US.ts`

- [ ] **Step 1: 添加简体中文翻译**

在 `src/locales/zh-CN.ts` 的 `fileManager` 区域添加以下键（建议放在 `fileManager.readOnly` 之后）：

```typescript
'fileManager.sensitivePathWarning': '当前路径为系统敏感目录，操作前请谨慎确认。',
'fileManager.menu.editPermissions': '修改权限',
'fileManager.permissionEdit.label': '八进制权限',
'fileManager.permissionEdit.save': '保存权限',
'fileManager.error.invalidPermissions': '权限格式无效，请输入 0-7777 之间的八进制数字。',
'fileManager.feedback.permissionsUpdated': '权限已更新',
```

- [ ] **Step 2: 添加英文翻译**

在 `src/locales/en-US.ts` 的对应位置添加：

```typescript
'fileManager.sensitivePathWarning': 'This is a system-sensitive directory. Please proceed with caution.',
'fileManager.menu.editPermissions': 'Edit Permissions',
'fileManager.permissionEdit.label': 'Octal Permissions',
'fileManager.permissionEdit.save': 'Save Permissions',
'fileManager.error.invalidPermissions': 'Invalid permission format. Please enter an octal number between 0 and 7777.',
'fileManager.feedback.permissionsUpdated': 'Permissions updated',
```

- [ ] **Step 3: Commit**

```bash
git add src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "i18n: add translations for permission editing and sensitive path warning"
```

---

## Task 6: 前端测试

**Files:**
- Modify: `src/components/__tests__/FileManager.test.tsx`

- [ ] **Step 1: 添加权限编辑测试**

在测试文件末尾（最后一个 `it(...)` 之后）添加：

```typescript
it("shows permission edit controls in the properties panel", () => {
  render(<FileManager session={connectedSession} />);

  fireEvent.contextMenu(screen.getByText("keep.txt"));
  fireEvent.click(screen.getByRole("button", { name: "属性" }));

  expect(screen.getByRole("button", { name: "修改权限" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "修改权限" }));
  expect(screen.getByPlaceholderText("0755")).toBeInTheDocument();
});
```

- [ ] **Step 2: 添加敏感路径警告测试**

在 `useFileManagerStore.setState` 的 mock 数据中，将路径改为 `/etc/nginx`：

不，不应该修改现有 mock 数据，而是新增一个测试用例：

```typescript
it("shows a warning banner when navigating to a sensitive path", () => {
  useFileManagerStore.setState({
    sessions: {
      "session-1": {
        pathInput: "/etc",
        listing: {
          path: "/etc",
          parentPath: "/",
          entries: [
            {
              path: "/etc/nginx",
              name: "nginx",
              kind: "directory",
            },
          ],
        },
      },
    },
  });

  render(<FileManager session={connectedSession} />);
  expect(screen.getByText(/系统敏感目录/)).toBeInTheDocument();
});
```

- [ ] **Step 3: 运行测试**

Run: `npm test -- src/components/__tests__/FileManager.test.tsx`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add src/components/__tests__/FileManager.test.tsx
git commit -m "test(file-manager): add tests for permission editing and sensitive path warning"
```

---

## Task 7: 端到端验证

**Files:** N/A（运行时代码已在前面任务中修改完毕）

- [ ] **Step 1: 运行完整前端类型检查**

Run: `npm run typecheck`（或 `npx tsc --noEmit`，取决于项目配置）
Expected: 无类型错误

- [ ] **Step 2: 运行前端测试套件**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 3: 编译后端**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore: verify file manager security features compile and pass tests"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - 权限编辑（chmod）→ Task 1（后端）+ Task 2（前端）
   - 敏感路径警告 → Task 3
   - 上传私钥文件权限自动修复 → Task 4
   - i18n → Task 5
   - 测试 → Task 6
   - 验证 → Task 7
   - ✅ 无遗漏

2. **Placeholder scan:**
   - 无 "TBD" / "TODO" / "implement later"
   - 每个代码步骤都有具体实现
   - ✅ 通过

3. **Type consistency:**
   - `UpdateRemotePermissionsRequest` 在 models.rs、commands.rs、FileManager.tsx 的 invoke 调用中字段名一致（`permissions: u32`）
   - `fileManager.permissionEdit.*` 翻译键在组件和翻译文件中一致
   - `fileManager.sensitivePathWarning` 翻译键一致
   - ✅ 通过
