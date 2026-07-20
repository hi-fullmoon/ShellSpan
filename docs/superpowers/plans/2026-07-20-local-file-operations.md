# 本地文件 复制/重命名/删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SFTP 双栏文件管理器的本地（local）面板支持右键菜单的复制（含粘贴）、重命名、删除（移到系统回收站）。

**Architecture:** Rust 端在 `local_fs.rs` 新增三个 blocking 函数（rename / paste 自动改名复制 / trash），经 `commands.rs` 的 async command 包装注册到 Tauri；前端 `useSftpPaneActions` 放开 `isLocal` 分支并新增 pane 级本地剪贴板状态；两个右键菜单组件移除 `!isLocal` 限制。

**Tech Stack:** Rust (tauri 2, trash 5), React + TypeScript, vitest + @testing-library/react.

## Global Constraints

- 规格文档：`docs/superpowers/specs/2026-07-20-local-file-operations-design.md`
- 删除必须移到系统回收站（`trash` crate），禁止永久删除
- 粘贴同名冲突自动改名：`<stem> <copySuffix>.<ext>`、`<stem> <copySuffix> 2.<ext>`；`copySuffix` 由前端按界面语言传入（zh-CN `副本`，en-US `copy`）
- `.termbridge` 为保留名，rename/paste 必须拒绝
- 前端测试命令：`npm test`；类型检查：`npx tsc --noEmit`；Rust 测试：`cargo test`（工作目录 `src-tauri`）
- 提交信息风格： conventional commits，如 `feat(sftp): ...`（参考 `git log --oneline`）

---

### Task 1: Rust `rename_local_path` 命令

**Files:**
- Modify: `src-tauri/src/local_fs.rs`（新增函数 + 单测）
- Modify: `src-tauri/src/commands.rs`（在 `copy_local_paths` 命令之后新增 command）
- Modify: `src-tauri/src/lib.rs:27`（re-export）与 `src-tauri/src/lib.rs` invoke_handler 列表（`commands::copy_local_paths,` 之后）

**Interfaces:**
- Consumes: 现有 `portable_local_path(&Path) -> String`（`src-tauri/src/path_utils.rs:3`）、`TERM_BRIDGE_DIRECTORY` 常量（`local_fs.rs:7`）
- Produces: Tauri 命令 `rename_local_path(path: String, new_name: String) -> Result<(), String>`；前端以 `invoke('rename_local_path', { path, newName })` 调用（Tauri 自动 camelCase）

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/local_fs.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn renames_a_file_within_the_same_directory() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("old.txt");
        fs::write(&src, "hello").unwrap();

        rename_local_path_blocking(src.to_str().unwrap().to_string(), "new.txt".to_string()).unwrap();

        assert!(!src.exists());
        assert_eq!(fs::read_to_string(temp.path().join("new.txt")).unwrap(), "hello");
    }

    #[test]
    fn rename_fails_when_target_name_exists() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("old.txt"), "a").unwrap();
        fs::write(temp.path().join("new.txt"), "b").unwrap();

        let result = rename_local_path_blocking(
            temp.path().join("old.txt").to_str().unwrap().to_string(),
            "new.txt".to_string(),
        );
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(temp.path().join("old.txt")).unwrap(), "a");
    }

    #[test]
    fn rename_rejects_reserved_termbridge_name() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("old.txt");
        fs::write(&src, "a").unwrap();

        let result = rename_local_path_blocking(src.to_str().unwrap().to_string(), ".termbridge".to_string());
        assert!(result.is_err());
        assert!(src.exists());
    }

    #[test]
    fn rename_rejects_empty_and_separator_names() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("old.txt");
        fs::write(&src, "a").unwrap();

        assert!(rename_local_path_blocking(src.to_str().unwrap().to_string(), "  ".to_string()).is_err());
        assert!(rename_local_path_blocking(src.to_str().unwrap().to_string(), "a/b".to_string()).is_err());
        assert!(rename_local_path_blocking(src.to_str().unwrap().to_string(), "a\\b".to_string()).is_err());
        assert!(src.exists());
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test rename_ -- --nocapture`（workdir: `src-tauri`）
Expected: 编译错误 `cannot find function rename_local_path_blocking`

- [ ] **Step 3: 实现函数**

在 `src-tauri/src/local_fs.rs` 的 `copy_local_paths_blocking` 之后插入：

```rust
pub(crate) fn rename_local_path_blocking(path: String, new_name: String) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("new name must not be empty".to_string());
    }
    if trimmed == TERM_BRIDGE_DIRECTORY {
        return Err("'.termbridge' is reserved for application data".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("new name must not contain path separators".to_string());
    }
    let source = Path::new(&portable_local_path(Path::new(&path))).to_path_buf();
    if !source.exists() {
        return Err(format!("path does not exist: {}", source.display()));
    }
    let parent = source
        .parent()
        .ok_or_else(|| format!("cannot rename a path without parent: {}", source.display()))?;
    let destination = parent.join(trimmed);
    if destination.exists() {
        return Err(format!("an entry named {trimmed} already exists"));
    }
    fs::rename(&source, &destination)
        .map_err(|error| format!("failed to rename {} to {trimmed}: {error}", source.display()))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test rename_`（workdir: `src-tauri`）
Expected: 4 个测试 PASS

- [ ] **Step 5: 注册 Tauri 命令**

`src-tauri/src/commands.rs` 在 `copy_local_paths` command（约 661-683 行）之后插入：

```rust
#[tauri::command]
pub(crate) async fn rename_local_path(path: String, new_name: String) -> Result<(), String> {
    info!("Renaming local path path={path} new_name={new_name}");
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::rename_local_path_blocking(path, new_name)
    })
    .await
    .map_err(|error| format!("failed to join rename local path task: {error}"))?;
    if let Err(error) = &result {
        warn!("Rename local path failed: {error}");
    }
    result
}
```

`src-tauri/src/lib.rs:27` 改为：

```rust
pub(crate) use local_fs::{copy_local_paths_blocking, rename_local_path_blocking};
```

`src-tauri/src/lib.rs` invoke_handler 中 `commands::copy_local_paths,` 之后插入 `commands::rename_local_path,`。

- [ ] **Step 6: 编译验证**

Run: `cargo build`（workdir: `src-tauri`）
Expected: 编译成功

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/local_fs.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(sftp): add rename_local_path command"
```

---

### Task 2: Rust `paste_local_paths` 命令（自动改名复制）

**Files:**
- Modify: `src-tauri/src/local_fs.rs`（新增函数 + 单测）
- Modify: `src-tauri/src/commands.rs`（Task 1 的 command 之后）
- Modify: `src-tauri/src/lib.rs:27` re-export 与 invoke_handler 列表

**Interfaces:**
- Consumes: 现有 `copy_local_entry_to_path`、`local_entry_names`、`paths_refer_to_same_entry`（均已在 `local_fs.rs`）
- Produces: Tauri 命令 `paste_local_paths(source_paths: Vec<String>, destination_directory: String, copy_suffix: String) -> Result<Vec<String>, String>`；JS 参数 `{ sourcePaths, destinationDirectory, copySuffix }`；返回实际写入的目标路径列表

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/local_fs.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn paste_copies_file_without_conflict() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        let src = src_dir.join("report.txt");
        fs::write(&src, "data").unwrap();
        let dest = temp.path().join("dest");
        fs::create_dir(&dest).unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            dest.to_str().unwrap().to_string(),
            "copy".to_string(),
        ).unwrap();

        assert_eq!(written.len(), 1);
        assert_eq!(fs::read_to_string(dest.join("report.txt")).unwrap(), "data");
    }

    #[test]
    fn paste_auto_renames_on_conflict() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("report.txt");
        fs::write(&src, "new").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "copy".to_string(),
        ).unwrap();

        assert_eq!(written, vec![temp.path().join("report copy.txt").to_string_lossy().to_string()]);
        assert_eq!(fs::read_to_string(temp.path().join("report copy.txt")).unwrap(), "new");
    }

    #[test]
    fn paste_increments_suffix_for_repeated_conflicts() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("report.txt"), "0").unwrap();
        fs::write(temp.path().join("report copy.txt"), "1").unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        let src = src_dir.join("report.txt");
        fs::write(&src, "new").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "copy".to_string(),
        ).unwrap();

        assert!(written[0].ends_with("report copy 2.txt"));
    }

    #[test]
    fn paste_auto_renames_directories_and_extensionless_files() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        fs::create_dir(src_dir.join("docs")).unwrap();
        fs::write(src_dir.join("docs/a.txt"), "a").unwrap();
        fs::write(src_dir.join("Makefile"), "m").unwrap();
        let dest = temp.path().join("dest");
        fs::create_dir(&dest).unwrap();
        fs::create_dir(dest.join("docs")).unwrap();
        fs::write(dest.join("Makefile"), "old").unwrap();

        let written = paste_local_paths_blocking(
            vec![
                src_dir.join("docs").to_str().unwrap().to_string(),
                src_dir.join("Makefile").to_str().unwrap().to_string(),
            ],
            dest.to_str().unwrap().to_string(),
            "copy".to_string(),
        ).unwrap();

        assert!(dest.join("docs copy/a.txt").exists());
        assert_eq!(fs::read_to_string(dest.join("Makefile copy")).unwrap(), "m");
        assert_eq!(written.len(), 2);
    }

    #[test]
    fn paste_uses_localized_suffix() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("报告.txt");
        fs::write(&src, "data").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "副本".to_string(),
        ).unwrap();

        assert!(written[0].ends_with("报告 副本.txt"));
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test paste_`（workdir: `src-tauri`）
Expected: 编译错误 `cannot find function paste_local_paths_blocking`

- [ ] **Step 3: 实现函数**

在 `src-tauri/src/local_fs.rs` 的 `rename_local_path_blocking` 之后插入：

```rust
pub(crate) fn paste_local_paths_blocking(
    source_paths: Vec<String>,
    destination_directory: String,
    copy_suffix: String,
) -> Result<Vec<String>, String> {
    if source_paths.is_empty() {
        return Err("no source paths were provided for paste".to_string());
    }

    let destination_directory = portable_local_path(Path::new(&destination_directory));
    let destination_directory = Path::new(&destination_directory);
    if !destination_directory.is_dir() {
        return Err(format!(
            "destination is not a directory: {}",
            destination_directory.display()
        ));
    }

    let mut existing_names = local_entry_names(destination_directory)?;
    let mut written = Vec::new();

    for source in &source_paths {
        let source_path = Path::new(&portable_local_path(Path::new(source))).to_path_buf();
        let file_name = source_path
            .file_name()
            .ok_or_else(|| format!("invalid source path: {}", source_path.display()))?
            .to_string_lossy()
            .to_string();
        if file_name == TERM_BRIDGE_DIRECTORY {
            return Err("'.termbridge' is reserved for application data".to_string());
        }
        let destination_name = resolve_paste_target_name(&existing_names, &file_name, &copy_suffix);
        let destination_path = destination_directory.join(&destination_name);
        if paths_refer_to_same_entry(&source_path, &destination_path) {
            continue;
        }
        copy_local_entry_to_path(&source_path, &destination_path)?;
        existing_names.insert(destination_name);
        written.push(destination_path.to_string_lossy().to_string());
    }

    Ok(written)
}

fn resolve_paste_target_name(
    existing_names: &HashSet<String>,
    base_name: &str,
    copy_suffix: &str,
) -> String {
    if !existing_names.contains(base_name) {
        return base_name.to_string();
    }
    let (stem, extension) = split_file_name(base_name);
    for index in 1u32.. {
        let suffix = if index == 1 {
            format!(" {copy_suffix}")
        } else {
            format!(" {copy_suffix} {index}")
        };
        let candidate = match extension {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };
        if !existing_names.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn split_file_name(name: &str) -> (&str, Option<&str>) {
    match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], Some(&name[index + 1..])),
        _ => (name, None),
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test paste_`（workdir: `src-tauri`）
Expected: 5 个测试 PASS

- [ ] **Step 5: 注册 Tauri 命令**

`src-tauri/src/commands.rs` 在 `rename_local_path` command 之后插入：

```rust
#[tauri::command]
pub(crate) async fn paste_local_paths(
    source_paths: Vec<String>,
    destination_directory: String,
    copy_suffix: String,
) -> Result<Vec<String>, String> {
    info!(
        "Pasting local paths count={} destination_directory={destination_directory}",
        source_paths.len()
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::paste_local_paths_blocking(source_paths, destination_directory, copy_suffix)
    })
    .await
    .map_err(|error| format!("failed to join paste local paths task: {error}"))?;
    if let Err(error) = &result {
        warn!("Paste local paths failed: {error}");
    }
    result
}
```

`src-tauri/src/lib.rs:27` 改为：

```rust
pub(crate) use local_fs::{copy_local_paths_blocking, paste_local_paths_blocking, rename_local_path_blocking};
```

invoke_handler 中 `commands::rename_local_path,` 之后插入 `commands::paste_local_paths,`。

- [ ] **Step 6: 编译验证**

Run: `cargo build`（workdir: `src-tauri`）
Expected: 编译成功

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/local_fs.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(sftp): add paste_local_paths command with auto-rename"
```

---

### Task 3: Rust `trash_local_paths` 命令

**Files:**
- Modify: `src-tauri/Cargo.toml`（dependencies 末尾，`portable-pty` 行之后）
- Modify: `src-tauri/src/local_fs.rs`（新增函数 + 单测）
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs:27` re-export 与 invoke_handler 列表

**Interfaces:**
- Consumes: `trash` crate v5（`trash::delete`）
- Produces: Tauri 命令 `trash_local_paths(paths: Vec<String>) -> Result<(), String>`；JS 参数 `{ paths }`

- [ ] **Step 1: 添加依赖**

`src-tauri/Cargo.toml` 的 `portable-pty = "0.9"` 行之后插入：

```toml
trash = "5"
```

Run: `cargo build`（workdir: `src-tauri`）确认依赖可解析。

- [ ] **Step 2: 写失败测试**

在 `src-tauri/src/local_fs.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn trash_rejects_empty_path_list() {
        let result = trash_local_paths_blocking(vec![]);
        assert!(result.is_err());
    }

    #[test]
    fn trash_fails_for_missing_path() {
        let temp = TempDir::new().unwrap();
        let missing = temp.path().join("does-not-exist.txt");
        let result = trash_local_paths_blocking(vec![missing.to_str().unwrap().to_string()]);
        assert!(result.is_err());
    }
```

（回收站成功路径依赖桌面环境，仅在错误路径做自动化断言。）

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test trash_`（workdir: `src-tauri`）
Expected: 编译错误 `cannot find function trash_local_paths_blocking`

- [ ] **Step 4: 实现函数**

在 `src-tauri/src/local_fs.rs` 的 `paste_local_paths_blocking` 之后插入：

```rust
pub(crate) fn trash_local_paths_blocking(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no paths were provided for trash".to_string());
    }
    for path in &paths {
        let portable = portable_local_path(Path::new(path));
        trash::delete(&portable)
            .map_err(|error| format!("failed to move {portable} to trash: {error}"))?;
    }
    Ok(())
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test trash_`（workdir: `src-tauri`）
Expected: 2 个测试 PASS

- [ ] **Step 6: 注册 Tauri 命令**

`src-tauri/src/commands.rs` 在 `paste_local_paths` command 之后插入：

```rust
#[tauri::command]
pub(crate) async fn trash_local_paths(paths: Vec<String>) -> Result<(), String> {
    info!("Trashing local paths count={}", paths.len());
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::trash_local_paths_blocking(paths)
    })
    .await
    .map_err(|error| format!("failed to join trash local paths task: {error}"))?;
    if let Err(error) = &result {
        warn!("Trash local paths failed: {error}");
    }
    result
}
```

`src-tauri/src/lib.rs:27` 改为：

```rust
pub(crate) use local_fs::{copy_local_paths_blocking, paste_local_paths_blocking, rename_local_path_blocking, trash_local_paths_blocking};
```

invoke_handler 中 `commands::paste_local_paths,` 之后插入 `commands::trash_local_paths,`。

- [ ] **Step 7: 编译 + 全量 Rust 测试**

Run: `cargo test`（workdir: `src-tauri`）
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/local_fs.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(sftp): add trash_local_paths command"
```

---

### Task 4: 前端 tauri 包装 + i18n copySuffix

**Files:**
- Modify: `src/lib/tauri.ts`（`invokeCopyLocalPaths` 之后插入三个包装函数）
- Modify: `src/locales/zh-CN.ts`（`'sftp.contextMenu.paste': '粘贴',` 行之后）
- Modify: `src/locales/en-US.ts`（`'sftp.contextMenu.paste': 'Paste',` 行之后）

**Interfaces:**
- Consumes: Task 1-3 的三个 Tauri 命令
- Produces:
  - `invokeRenameLocalPath(path: string, newName: string): Promise<void>`
  - `invokeTrashLocalPaths(paths: string[]): Promise<void>`
  - `invokePasteLocalPaths(sourcePaths: string[], destinationDirectory: string, copySuffix: string): Promise<string[]>`
  - i18n key `sftp.copySuffix`（zh-CN `副本`，en-US `copy`）

- [ ] **Step 1: 添加包装函数**

`src/lib/tauri.ts` 在 `invokeCopyLocalPaths`（139-143 行）之后插入：

```ts
export async function invokeRenameLocalPath(path: string, newName: string): Promise<void> {
  return invokeLogged('rename_local_path', { path, newName });
}

export async function invokeTrashLocalPaths(paths: string[]): Promise<void> {
  return invokeLogged('trash_local_paths', { paths });
}

export async function invokePasteLocalPaths(
  sourcePaths: string[],
  destinationDirectory: string,
  copySuffix: string,
): Promise<string[]> {
  return invokeLogged('paste_local_paths', { sourcePaths, destinationDirectory, copySuffix });
}
```

- [ ] **Step 2: 添加 i18n key**

`src/locales/zh-CN.ts` 在 `'sftp.contextMenu.paste': '粘贴',` 行之后插入：

```ts
  'sftp.copySuffix': '副本',
```

`src/locales/en-US.ts` 在 `'sftp.contextMenu.paste': 'Paste',` 行之后插入：

```ts
  'sftp.copySuffix': 'copy',
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误（若 locale 类型由 key 联合类型推导，两个文件都加 key 后应一致）

- [ ] **Step 4: Commit**

```bash
git add src/lib/tauri.ts src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(sftp): add local file operation invoke wrappers"
```

---

### Task 5: `useSftpPaneActions` 本地分支 + 本地剪贴板

**Files:**
- Modify: `src/hooks/useSftpPaneActions.ts`
- Test: `src/hooks/__tests__/useSftpPaneActions.test.ts`

**Interfaces:**
- Consumes: Task 4 的三个 `invoke*` 包装；i18n key `sftp.copySuffix`
- Produces: `UseSftpPaneActionsResult` 新增字段 `hasLocalClipboard: boolean`（Task 6 的 `sftp-pane.tsx` 依赖）；`onRename` / `handleRename` / `onDelete` / `onCopy` / `onPaste` 在 `isLocal` 时可用

- [ ] **Step 1: 写失败测试**

`src/hooks/__tests__/useSftpPaneActions.test.ts` 的 `vi.mock('@/lib/tauri', ...)` 块改为：

```ts
vi.mock('@/lib/tauri', () => ({
  invokeCancelRemoteCopy: vi.fn().mockResolvedValue(undefined),
  invokeCopyLocalPaths: vi.fn().mockResolvedValue(undefined),
  invokeCopyRemoteToRemote: vi.fn().mockResolvedValue(undefined),
  invokePickLocalFiles: vi.fn().mockResolvedValue([]),
  invokePickLocalFolder: vi.fn().mockResolvedValue([]),
  invokeRenameLocalPath: vi.fn().mockResolvedValue(undefined),
  invokeTrashLocalPaths: vi.fn().mockResolvedValue(undefined),
  invokePasteLocalPaths: vi.fn().mockResolvedValue([]),
}));
```

文件头部 import 改为：

```ts
import {
  invokeCopyRemoteToRemote,
  invokePasteLocalPaths,
  invokeRenameLocalPath,
  invokeTrashLocalPaths,
} from '@/lib/tauri';
```

`describe('useSftpPaneActions', ...)` 内追加：

```ts
  it('copies local entries into the local clipboard', () => {
    const connection = addConnection();
    const localEntry = { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 };

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    expect(result.current.hasLocalClipboard).toBe(false);

    act(() => result.current.onCopy(localEntry));

    expect(result.current.hasLocalClipboard).toBe(true);
  });

  it('pastes local clipboard entries into the current directory', async () => {
    const connection = addConnection();
    connection.localPane.selectedPaths = ['/local/a.txt'];
    connection.localEntries = [
      { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 },
    ];

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    act(() => result.current.onCopy());
    await act(() => result.current.onPaste());

    expect(vi.mocked(invokePasteLocalPaths)).toHaveBeenCalledWith(
      ['/local/a.txt'],
      '/local',
      expect.any(String),
    );
  });

  it('renames a local entry via the local rename command', async () => {
    const connection = addConnection();
    connection.localPane.selectedPaths = ['/local/a.txt'];
    connection.localEntries = [
      { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 },
    ];

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    act(() => result.current.onRename());
    await act(() => result.current.handleRename('b.txt'));

    expect(vi.mocked(invokeRenameLocalPath)).toHaveBeenCalledWith('/local/a.txt', 'b.txt');
    expect(result.current.renameTarget).toBeUndefined();
  });

  it('trashes local entries via the trash command', async () => {
    const connection = addConnection();
    connection.localPane.selectedPaths = ['/local/a.txt', '/local/b.txt'];
    connection.localEntries = [
      { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 },
      { path: '/local/b.txt', name: 'b.txt', kind: 'file' as const, size: 10 },
    ];

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    await act(() => result.current.onDelete());

    expect(vi.mocked(invokeTrashLocalPaths)).toHaveBeenCalledWith(['/local/a.txt', '/local/b.txt']);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- useSftpPaneActions`
Expected: 失败（`hasLocalClipboard` 不存在 / invoke 未被调用）

- [ ] **Step 3: 实现**

`src/hooks/useSftpPaneActions.ts`：

1. import 块（第 2-8 行）改为：

```ts
import {
  invokeCopyLocalPaths,
  invokeCancelRemoteCopy,
  invokeCopyRemoteToRemote,
  invokePickLocalFiles,
  invokePickLocalFolder,
  invokeRenameLocalPath,
  invokeTrashLocalPaths,
  invokePasteLocalPaths,
} from '@/lib/tauri';
```

2. `UseSftpPaneActionsResult` 接口（38-78 行）在 `uploadConflict?: PendingUploadConflict;` 之后插入：

```ts
  hasLocalClipboard: boolean;
```

3. state 声明区（`const [uploadConflict, ...]` 之后，约 149 行）插入：

```ts
  const [localClipboard, setLocalClipboard] = useState<FileEntry[]>([]);
```

4. `onCopy`（273-289 行）整体替换为：

```ts
  const onCopy = useCallback(
    (entry?: FileEntry) => {
      if (isLocal) {
        const targets = entry ? [entry] : selectedEntries;
        if (!targets.length) return;
        setLocalClipboard(targets);
        success(`Copied ${targets.length} item(s)`);
        return;
      }
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      setRemoteClipboard(connection.id, {
        sourcePath: target.path,
        sourceName: target.name,
        kind: target.kind,
        sourceSide: side,
        sourceConnection: remoteConnection,
        sourceConnectionKey: remoteConnectionKey,
      });
      success(`Copied ${target.name}`);
    },
    [connection.id, isLocal, remoteConnection, remoteConnectionKey, selectedEntries, setRemoteClipboard, side, success],
  );
```

5. `onPaste`（291-358 行）：将首行 `if (isLocal || !connection.remoteClipboard) return;` 替换为以下代码，函数其余部分（原 `try` 块起的远端逻辑）逐字保留：

```ts
    if (isLocal) {
      if (!localClipboard.length) return;
      try {
        await invokePasteLocalPaths(
          localClipboard.map((entry) => entry.path),
          path,
          t('sftp.copySuffix'),
        );
        await reload();
        clearSelection();
      } catch (err) {
        logger.warn('Local paste failed', err);
        error(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (!connection.remoteClipboard) return;
```

依赖数组加入 `localClipboard`、`t`。

6. `onRename`（444-452 行）：删除 `if (isLocal) return;` 行，依赖数组移除 `isLocal`（保留其余）。

7. `handleRename`（454-474 行）整体替换为：

```ts
  const handleRename = useCallback(
    async (newName: string) => {
      if (!renameTarget) return;
      try {
        if (isLocal) {
          await invokeRenameLocalPath(renameTarget.path, newName);
        } else {
          if (pathsAreBusy([renameTarget.path])) {
            reportBusyPaths();
            setRenameTarget(undefined);
            return;
          }
          await renameRemotePath(renameTarget.path, newName);
        }
        await reload();
        clearSelection();
      } catch (err) {
        logger.warn(`Failed to rename: ${renameTarget.path}`, err);
        error(err instanceof Error ? err.message : String(err));
      } finally {
        setRenameTarget(undefined);
      }
    },
    [clearSelection, isLocal, pathsAreBusy, renameRemotePath, renameTarget, reload, reportBusyPaths, error],
  );
```

8. `onDelete`（476-495 行）：将开头三行

```ts
      if (isLocal) return;
      const targets = entriesToDelete?.length ? entriesToDelete : selectedEntries;
      if (!targets.length) return;
```

替换为以下代码，其余部分（`if (pathsAreBusy(...))` 起的远端逻辑）逐字保留：

```ts
      const targets = entriesToDelete?.length ? entriesToDelete : selectedEntries;
      if (!targets.length) return;
      if (isLocal) {
        try {
          await invokeTrashLocalPaths(targets.map((entry) => entry.path));
          await reload();
          clearSelection();
        } catch (err) {
          logger.warn('Failed to trash local paths', err);
          error(err instanceof Error ? err.message : String(err));
        }
        return;
      }
```

依赖数组保持 `[clearSelection, deleteRemotePaths, isLocal, pathsAreBusy, reload, reportBusyPaths, selectedEntries, error]`。

9. return 对象（686-727 行）在 `uploadConflict,` 之后插入：

```ts
    hasLocalClipboard: localClipboard.length > 0,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- useSftpPaneActions`
Expected: 全部 PASS

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useSftpPaneActions.ts src/hooks/__tests__/useSftpPaneActions.test.ts
git commit -m "feat(sftp): enable local rename, copy, paste, and trash in pane actions"
```

---

### Task 6: 右键菜单放开本地限制

**Files:**
- Modify: `src/components/sftp/sftp-file-context-menu.tsx:147-149`
- Modify: `src/components/sftp/sftp-blank-context-menu.tsx:154-162`
- Modify: `src/components/sftp/sftp-pane.tsx:530`
- Test: `src/components/sftp/__tests__/sftp-file-context-menu.test.tsx`
- Test: `src/components/sftp/__tests__/sftp-blank-context-menu.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `actions.hasLocalClipboard`
- Produces: 本地面板右键菜单中 重命名/复制/删除 可用；空白处菜单显示「粘贴」

- [ ] **Step 1: 写失败测试**

`sftp-file-context-menu.test.tsx` 在 `'hides remote-only items for local side'` 测试之后追加：

```tsx
  it('enables rename, copy, and delete for the local side', () => {
    renderMenu({ side: 'local', selectedEntries: [createRemoteFileEntry('local.txt')] });
    expect(screen.getByText('common.rename').closest('button')).not.toBeDisabled();
    expect(screen.getByText('sftp.contextMenu.copy').closest('button')).not.toBeDisabled();
    expect(screen.getByText('common.delete').closest('button')).not.toBeDisabled();
  });
```

`sftp-blank-context-menu.test.tsx` 中 `'hides remote-only items for local side'` 测试（77-82 行）改为：

```tsx
  it('hides remote-only items for local side', () => {
    renderMenu({ side: 'local' });
    expect(screen.queryByText('sftp.contextMenu.newFile')).not.toBeInTheDocument();
    expect(screen.queryByText('sftp.contextMenu.bookmark.add')).not.toBeInTheDocument();
  });

  it('shows paste for the local side when the local clipboard has data', () => {
    renderMenu({ side: 'local', hasClipboard: true });
    expect(screen.getByText('sftp.contextMenu.paste').closest('button')).not.toBeDisabled();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- context-menu`
Expected: 新增断言失败

- [ ] **Step 3: 实现**

`sftp-file-context-menu.tsx` 147-149 行改为：

```tsx
  const canRename = singleSelection !== undefined && !selectionBusy;
  const canCopy = isLocal ? hasSelection : singleSelection !== undefined;
  const canDelete = hasSelection && !selectionBusy;
```

`sftp-blank-context-menu.tsx` 154-162 行的 `{!isLocal && (<MenuItem paste...>)}` 改为无条件渲染：

```tsx
        <MenuItem
          onClick={() => handleAction('paste')}
          disabled={!hasClipboard}
          icon={<ClipboardPasteIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.paste')}
        </MenuItem>
```

`sftp-pane.tsx` 530 行改为：

```tsx
        hasClipboard={isLocal ? actions.hasLocalClipboard : !!connection.remoteClipboard}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- context-menu`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/sftp/sftp-file-context-menu.tsx src/components/sftp/sftp-blank-context-menu.tsx src/components/sftp/sftp-pane.tsx src/components/sftp/__tests__/sftp-file-context-menu.test.tsx src/components/sftp/__tests__/sftp-blank-context-menu.test.tsx
git commit -m "feat(sftp): enable rename, copy, delete, and paste in local context menus"
```

---

### Task 7: 全量验证

**Files:** 无（仅验证）

- [ ] **Step 1: 前端全量测试**

Run: `npm test`
Expected: 全部测试文件 PASS

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Rust 全量测试**

Run: `cargo test`（workdir: `src-tauri`）
Expected: 全部 PASS

- [ ] **Step 4: 手动验证（可选，需 `npm run tauri:dev`）**

本地面板：右键文件 → 重命名/复制/删除可用；复制后空白处右键 → 粘贴生成「xx 副本」；删除后文件进入系统回收站。
