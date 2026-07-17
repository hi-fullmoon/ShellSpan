# SFTP System Drag-and-Drop Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native OS file-manager drag-and-drop support to the SFTP panes so users can drop files/folders onto either the local or remote pane, with the remote pane uploading and the local pane copying into the current directory, reusing the existing conflict dialog.

**Architecture:** Register a single Tauri `onDragDropEvent` window listener in `SftpContent`, determine the hovered pane by intersecting the event position with pane DOM refs, and route the dropped paths through a generalized `UploadQueue` that dispatches either to the existing remote upload path or a new local copy backend command. The hovered pane renders the existing dashed overlay driven by system-drop state instead of the internal @dnd-kit state.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Tauri v2.11, Rust, Vitest, Cargo.

## Global Constraints

- Use `@tauri-apps/api/window` `getCurrentWindow().onDragDropEvent` for all system drag-and-drop events; do not rely on HTML5 `dataTransfer` for file paths.
- Keep the existing @dnd-kit internal drag-and-drop between panes unchanged.
- Reuse the existing `SftpUploadConflictDialog` and conflict policy types (`UploadConflictPolicy`).
- Reuse the existing `TransferProgress` / `useTransferStore` operation tracking for the local copy path.
- All file paths must be normalized with `/` separators via existing utilities (`portable_local_path` on Rust side, `localPathName` helper on TS side).
- No new i18n keys required; reuse `sftp.dropHint` for the overlay.

---

### Task 1: Backend - Add Local Copy Model and Command

**Files:**
- Create: `src-tauri/src/local_fs.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `UploadConflictPolicy` from `models.rs`, `portable_local_path` from `path_utils.rs`.
- Produces: `CopyLocalPathsRequest` struct, `copy_local_paths` Tauri command, `copy_local_paths_blocking` implementation.

- [ ] **Step 1: Add `CopyLocalPathsRequest` to `src-tauri/src/models.rs`**

Insert after `UploadLocalPathsRequest` (around line 187):

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyLocalPathsRequest {
    pub(crate) source_paths: Vec<String>,
    pub(crate) destination_directory: String,
    #[serde(default)]
    pub(crate) conflict_policies: Vec<UploadConflictPolicy>,
    pub(crate) operation_id: String,
}
```

- [ ] **Step 2: Create `src-tauri/src/local_fs.rs` with the blocking implementation**

```rust
use crate::models::{CopyLocalPathsRequest, UploadConflictPolicy};
use crate::path_utils::portable_local_path;
use log::{info, warn};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn copy_local_paths_blocking(request: CopyLocalPathsRequest) -> Result<(), String> {
    if request.source_paths.is_empty() {
        return Err("no source paths were provided for copy".to_string());
    }

    let destination_directory = Path::new(&request.destination_directory);
    fs::create_dir_all(destination_directory)
        .map_err(|error| format!("failed to create destination directory: {error}"))?;

    let mut existing_names = local_entry_names(destination_directory)?;

    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.source_paths.len()
    {
        return Err("copy conflict policy count does not match source paths".to_string());
    }

    for (index, source_path) in request.source_paths.iter().enumerate() {
        let source_path = Path::new(source_path);
        let file_name = source_path
            .file_name()
            .ok_or_else(|| format!("invalid source path: {}", source_path.display()))?
            .to_string_lossy()
            .to_string();
        let conflict_policy = request
            .conflict_policies
            .get(index)
            .copied()
            .unwrap_or(UploadConflictPolicy::Fail);
        let destination_name = match resolve_copy_target_name(&existing_names, &file_name, conflict_policy)? {
            Some(name) => name,
            None => continue,
        };
        let destination_path = destination_directory.join(&destination_name);
        copy_local_entry_to_path(source_path, &destination_path)?;
        existing_names.insert(destination_name);
    }

    Ok(())
}

fn local_entry_names(directory: &Path) -> Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for entry in fs::read_dir(directory).map_err(|error| format!("failed to read directory: {error}"))? {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        names.insert(name);
    }
    Ok(names)
}

fn resolve_copy_target_name(
    existing_names: &HashSet<String>,
    base_name: &str,
    policy: UploadConflictPolicy,
) -> Result<Option<String>, String> {
    if !existing_names.contains(base_name) {
        return Ok(Some(base_name.to_string()));
    }

    match policy {
        UploadConflictPolicy::Overwrite | UploadConflictPolicy::Replace => {
            Ok(Some(base_name.to_string()))
        }
        UploadConflictPolicy::Skip => Ok(None),
        UploadConflictPolicy::Fail => Err(format!("local path already exists: {base_name}")),
    }
}

fn copy_local_entry_to_path(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("failed to stat source {}: {error}", source.display()))?;

    if metadata.is_dir() {
        fs::create_dir_all(destination)
            .map_err(|error| format!("failed to create directory {}: {error}", destination.display()))?;
        for entry in fs::read_dir(source).map_err(|error| format!("failed to read directory {}: {error}", source.display()))? {
            let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
            let entry_destination = destination.join(entry.file_name());
            copy_local_entry_to_path(&entry.path(), &entry_destination)?;
        }
        Ok(())
    } else if metadata.is_symlink() {
        let target = fs::read_link(source)
            .map_err(|error| format!("failed to read symlink {}: {error}", source.display()))?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, destination)
                .map_err(|error| format!("failed to create symlink {}: {error}", destination.display()))?;
        }
        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(&target, destination)
                    .map_err(|error| format!("failed to create symlink {}: {error}", destination.display()))?;
            } else {
                std::os::windows::fs::symlink_file(&target, destination)
                    .map_err(|error| format!("failed to create symlink {}: {error}", destination.display()))?;
            }
        }
        Ok(())
    } else {
        fs::copy(source, destination)
            .map_err(|error| format!("failed to copy {} to {}: {error}", source.display(), destination.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn make_request(sources: Vec<&str>, destination: &str, policies: Vec<UploadConflictPolicy>) -> CopyLocalPathsRequest {
        CopyLocalPathsRequest {
            source_paths: sources.into_iter().map(|s| s.to_string()).collect(),
            destination_directory: destination.to_string(),
            conflict_policies: policies,
            operation_id: "test-op".to_string(),
        }
    }

    #[test]
    fn copies_a_single_file_into_destination() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::write(&src, "hello").unwrap();

        let request = make_request(vec![src.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![]);
        copy_local_paths_blocking(request).unwrap();

        let copied = dest_dir.join("file.txt");
        assert!(copied.exists());
        assert_eq!(fs::read_to_string(copied).unwrap(), "hello");
    }

    #[test]
    fn copies_a_nested_directory_recursively() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        let nested = src_dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("inner.txt"), "inner").unwrap();
        let dest_dir = temp.path().join("dest");

        let request = make_request(vec![src_dir.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![]);
        copy_local_paths_blocking(request).unwrap();

        assert!(dest_dir.join("src").exists());
        assert!(dest_dir.join("src/nested/inner.txt").exists());
    }

    #[test]
    fn overwrite_replaces_existing_file() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(vec![src.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![UploadConflictPolicy::Overwrite]);
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(fs::read_to_string(dest_dir.join("file.txt")).unwrap(), "new");
    }

    #[test]
    fn skip_leaves_existing_file_unchanged() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(vec![src.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![UploadConflictPolicy::Skip]);
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(fs::read_to_string(dest_dir.join("file.txt")).unwrap(), "old");
    }

    #[test]
    fn fail_errors_on_existing_file() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(vec![src.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![UploadConflictPolicy::Fail]);
        let result = copy_local_paths_blocking(request);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("file.txt"));
    }
}
```

- [ ] **Step 3: Register the new module and re-export the blocking function in `src-tauri/src/lib.rs`**

Add `mod local_fs;` near the top (after `mod keychain;`):

```rust
mod local_fs;
```

Add to the `pub(crate) use` block (around line 28):

```rust
pub(crate) use local_fs::copy_local_paths_blocking;
```

- [ ] **Step 4: Add the `copy_local_paths` command in `src-tauri/src/commands.rs`**

Add to the imports at the top (around line 6):

```rust
CopyLocalPathsRequest,
```

Insert the command after `upload_local_paths` (around line 352):

```rust
#[tauri::command]
pub(crate) async fn copy_local_paths(
    request: CopyLocalPathsRequest,
) -> Result<(), String> {
    info!(
        "Copying local paths operation_id={} count={} destination_directory={}",
        request.operation_id,
        request.source_paths.len(),
        request.destination_directory,
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::copy_local_paths_blocking(request)
    })
    .await
    .map_err(|error| format!("failed to join copy local paths task: {error}"))?;
    if let Err(error) = &result {
        warn!("Copy local paths failed operation_id={}: {error}", request.operation_id);
    } else {
        info!("Copy local paths completed operation_id={}", request.operation_id);
    }
    result
}
```

- [ ] **Step 5: Register the command in `src-tauri/src/lib.rs` invoke handler**

Add `commands::copy_local_paths,` to the `invoke_handler` list (after `commands::upload_local_paths`):

```rust
commands::copy_local_paths,
```

- [ ] **Step 6: Add `tempfile` dev dependency for tests in `src-tauri/Cargo.toml`**

```toml
[dev-dependencies]
tempfile = "3.14.0"
```

- [ ] **Step 7: Run Rust tests for the new module**

Run: `cargo test --manifest-path src-tauri/Cargo.toml copy_local_paths_blocking`
Expected: all 5 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/local_fs.rs src-tauri/src/models.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
```

---

### Task 2: Frontend - Add Type and Tauri Binding

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/tauri.ts`

**Interfaces:**
- Consumes: `UploadConflictPolicy` from `src/types/index.ts`.
- Produces: `CopyLocalPathsRequest` interface, `invokeCopyLocalPaths` function.

- [ ] **Step 1: Add `CopyLocalPathsRequest` to `src/types/index.ts`**

Insert after `UploadLocalPathsRequest` (around line 254):

```ts
export interface CopyLocalPathsRequest {
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: UploadConflictPolicy[];
  operationId: string;
}
```

- [ ] **Step 2: Add `invokeCopyLocalPaths` to `src/lib/tauri.ts`**

Add to the imports from `@/types` (around line 28):

```ts
CopyLocalPathsRequest,
```

Insert after `invokeUploadLocalPaths` (around line 93):

```ts
export async function invokeCopyLocalPaths(
  request: CopyLocalPathsRequest,
): Promise<void> {
  return invoke('copy_local_paths', { request });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts src/lib/tauri.ts
```

---

### Task 3: Frontend - Create `useSystemFileDrop` Hook

**Files:**
- Create: `src/hooks/useSystemFileDrop.ts`
- Create: `src/hooks/__tests__/useSystemFileDrop.test.ts`

**Interfaces:**
- Consumes: `getCurrentWindow` from `@tauri-apps/api/window`.
- Produces: `{ dragActive: boolean; hoveredSide: 'local' | 'remote' | null }` and an `onDrop` callback.

- [ ] **Step 1: Create the hook file**

```ts
import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { DragDropEvent } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';

export interface UseSystemFileDropOptions {
  leftPaneRef: React.RefObject<HTMLElement | null>;
  rightPaneRef: React.RefObject<HTMLElement | null>;
  onDrop: (paths: string[], side: 'local' | 'remote') => void;
  canDrop?: (side: 'local' | 'remote') => boolean;
}

export interface UseSystemFileDropResult {
  dragActive: boolean;
  hoveredSide: 'local' | 'remote' | null;
}

export function useSystemFileDrop(options: UseSystemFileDropOptions): UseSystemFileDropResult {
  const [dragActive, setDragActive] = useState(false);
  const [hoveredSide, setHoveredSide] = useState<'local' | 'remote' | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const window = getCurrentWindow();
      unlisten = await window.onDragDropEvent((event) => {
        if (cancelled) return;
        const { payload } = event;
        switch (payload.type) {
          case 'enter':
          case 'over': {
            setDragActive(true);
            const side = resolveSideFromPosition(
              payload.position,
              optionsRef.current.leftPaneRef.current,
              optionsRef.current.rightPaneRef.current,
            );
            setHoveredSide(side);
            break;
          }
          case 'leave': {
            setDragActive(false);
            setHoveredSide(null);
            break;
          }
          case 'drop': {
            setDragActive(false);
            setHoveredSide(null);
            const side = resolveSideFromPosition(
              payload.position,
              optionsRef.current.leftPaneRef.current,
              optionsRef.current.rightPaneRef.current,
            );
            if (side && (!optionsRef.current.canDrop || optionsRef.current.canDrop(side))) {
              optionsRef.current.onDrop(payload.paths, side);
            }
            break;
          }
        }
      });
    };

    void attach();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { dragActive, hoveredSide };
}

function resolveSideFromPosition(
  position: { x: number; y: number },
  leftPane: HTMLElement | null,
  rightPane: HTMLElement | null,
): 'local' | 'remote' | null {
  const leftRect = leftPane?.getBoundingClientRect();
  const rightRect = rightPane?.getBoundingClientRect();
  if (leftRect && containsPoint(leftRect, position)) return 'local';
  if (rightRect && containsPoint(rightRect, position)) return 'remote';
  return null;
}

function containsPoint(rect: DOMRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}
```

- [ ] **Step 2: Create the test file**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSystemFileDrop } from './useSystemFileDrop';

const handlers: Array<(event: { payload: { type: string; position: { x: number; y: number }; paths: string[] } }) => void> = [];
const mockUnlisten = vi.fn();
const mockOnDrop = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn().mockReturnValue({
    onDragDropEvent: vi.fn().mockImplementation((handler) => {
      handlers.push(handler);
      return Promise.resolve(mockUnlisten);
    }),
  }),
}));

function createElement(rect: Partial<DOMRect>): HTMLElement {
  const element = document.createElement('div');
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
  return element;
}

describe('useSystemFileDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.length = 0;
  });

  it('returns no hover when no drag event has fired', () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    const { result } = renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as React.RefObject<HTMLElement>,
        rightPaneRef: rightRef as React.RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    expect(result.current.dragActive).toBe(false);
    expect(result.current.hoveredSide).toBeNull();
  });

  it('detects hover over left pane', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    const { result } = renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as React.RefObject<HTMLElement>,
        rightPaneRef: rightRef as React.RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    handlers[0]!({ payload: { type: 'over', position: { x: 100, y: 100 }, paths: [] } });
    await waitFor(() => expect(result.current.hoveredSide).toBe('local'));
    expect(result.current.dragActive).toBe(true);
  });

  it('detects hover over right pane', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    const { result } = renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as React.RefObject<HTMLElement>,
        rightPaneRef: rightRef as React.RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    handlers[0]!({ payload: { type: 'over', position: { x: 500, y: 100 }, paths: [] } });
    await waitFor(() => expect(result.current.hoveredSide).toBe('remote'));
  });

  it('calls onDrop when dropped on a pane', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as React.RefObject<HTMLElement>,
        rightPaneRef: rightRef as React.RefObject<HTMLElement>,
        onDrop: mockOnDrop,
      }),
    );
    handlers[0]!({ payload: { type: 'drop', position: { x: 500, y: 100 }, paths: ['/a/file.txt'] } });
    await waitFor(() => expect(mockOnDrop).toHaveBeenCalledWith(['/a/file.txt'], 'remote'));
  });

  it('does not call onDrop when canDrop returns false', async () => {
    const leftRef = { current: createElement({ left: 0, right: 400, top: 0, bottom: 600 }) };
    const rightRef = { current: createElement({ left: 400, right: 800, top: 0, bottom: 600 }) };
    renderHook(() =>
      useSystemFileDrop({
        leftPaneRef: leftRef as React.RefObject<HTMLElement>,
        rightPaneRef: rightRef as React.RefObject<HTMLElement>,
        onDrop: mockOnDrop,
        canDrop: () => false,
      }),
    );
    handlers[0]!({ payload: { type: 'drop', position: { x: 500, y: 100 }, paths: ['/a/file.txt'] } });
    await waitFor(() => expect(mockOnDrop).not.toHaveBeenCalled());
  });
});
```

- [ ] **Step 3: Run the hook tests**

Run: `pnpm test src/hooks/__tests__/useSystemFileDrop.test.ts`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSystemFileDrop.ts src/hooks/__tests__/useSystemFileDrop.test.ts
```

---

### Task 4: Frontend - Generalize `UploadQueue` and Wire System Drop in `SftpContent`

**Files:**
- Modify: `src/components/sftp/index.tsx`

**Interfaces:**
- Consumes: `useSystemFileDrop` from `src/hooks/useSystemFileDrop.ts`, `copyWithPolicies` from `useSftpPaneActions` (Task 5), existing `uploadWithPolicies`.
- Produces: `handleSystemDrop(paths, side)` callback, generalized `UploadQueue`.

- [ ] **Step 1: Update imports in `src/components/sftp/index.tsx`**

Add to existing imports:

```tsx
import { useSystemFileDrop } from '@/hooks/useSystemFileDrop';
```

- [ ] **Step 2: Generalize `UploadQueue` interface**

Change the existing interface (around line 153):

```ts
interface UploadQueue {
  paths: string[];
  destination: string;
  side: 'local' | 'remote';
  index: number;
  accepted: string[];
  policies: UploadConflictPolicy[];
  remembered: UploadConflictAction | undefined;
}
```

- [ ] **Step 3: Add pane refs to `SftpContent`**

After the `uploadQueueRef` and `uploadConflict` state (around line 181), add:

```tsx
const leftPaneRef = useRef<HTMLDivElement>(null);
const rightPaneRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 4: Add `canDrop` and `handleSystemDrop` callbacks**

Inside `SftpContent`, before the `return` statement, add:

```tsx
const canSystemDrop = useCallback((side: 'local' | 'remote') => {
  const isLocal = side === 'local';
  const loading = isLocal ? connection.localLoading : connection.remoteLoading;
  const panePath = isLocal ? connection.localPath : connection.remotePath;
  return !loading && Boolean(panePath);
}, [connection.localLoading, connection.localPath, connection.remoteLoading, connection.remotePath]);

const handleSystemDrop = useCallback(
  async (paths: string[], side: 'local' | 'remote') => {
    const destination = side === 'local' ? connection.localPath : connection.remotePath;
    if (!destination) return;
    uploadQueueRef.current = {
      paths,
      destination,
      side,
      index: 0,
      accepted: [],
      policies: [],
      remembered: undefined,
    };
    await processUploadQueue();
    if (side === 'local') {
      await loadLocalDirectory(connection.localPath);
      setPaneState(connection.id, 'local', { selectedPaths: [] });
    } else {
      await loadRemoteDirectory(connection.remotePath);
      setPaneState(connection.id, 'remote', { selectedPaths: [] });
    }
  },
  [connection.id, connection.localPath, connection.remotePath, loadLocalDirectory, loadRemoteDirectory, setPaneState],
);

const { dragActive: systemDragActive, hoveredSide: systemHoveredSide } = useSystemFileDrop({
  leftPaneRef,
  rightPaneRef,
  onDrop: handleSystemDrop,
  canDrop: canSystemDrop,
});
```

- [ ] **Step 5: Update `processUploadQueue` to branch on side**

Replace the existing dispatch block (around line 235) with:

```ts
if (queue.accepted.length > 0) {
  if (queue.side === 'local') {
    await localActions.copyWithPolicies(
      queue.accepted,
      queue.destination,
      queue.policies,
    );
  } else {
    await remoteActions.uploadWithPolicies(
      queue.accepted,
      queue.destination,
      queue.policies,
    );
  }
}
```

Also update the `existingByName` lookup at the start of `processUploadQueue` to use the correct side's entries (around line 193):

```ts
const entries = queue.side === 'local' ? connection.localEntries : connection.remoteEntries;
const existingByName = new Map(
  entries.map((entry) => [entry.name, entry]),
);
```

Also update the `useCallback` dependency array for `processUploadQueue` to include both side actions and entry arrays:

```ts
}, [connection.localEntries, connection.remoteEntries, localActions, remoteActions]);
```

- [ ] **Step 6: Pass refs and system drop props to `SftpPane` instances**

In the `return` JSX, update the left pane:

```tsx
<SftpPane
  ref={leftPaneRef}
  connection={connection}
  side="local"
  actions={localActions}
  selectedPaths={selectedLocalPaths}
  onSelectedPathsChange={(paths) =>
    setPaneState(connection.id, 'local', { selectedPaths: Array.from(paths) })
  }
  systemDropActive={systemDragActive}
  systemDropHovered={systemHoveredSide === 'local'}
/>
```

Update the right pane:

```tsx
<SftpPane
  ref={rightPaneRef}
  connection={connection}
  side="remote"
  actions={remoteActions}
  selectedPaths={selectedRemotePaths}
  onSelectedPathsChange={(paths) =>
    setPaneState(connection.id, 'remote', { selectedPaths: Array.from(paths) })
  }
  onVerifyHostKey={...}
  systemDropActive={systemDragActive}
  systemDropHovered={systemHoveredSide === 'remote'}
/>
```

- [ ] **Step 7: Run the existing SFTP tests to ensure no regression**

Run: `pnpm test src/components/sftp/__tests__/sftp-pane.test.tsx`
Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add src/components/sftp/index.tsx
```

---

### Task 5: Frontend - Add `copyWithPolicies` to `useSftpPaneActions`

**Files:**
- Modify: `src/hooks/useSftpPaneActions.ts`
- Modify: `src/hooks/__tests__/useSftpPaneActions.test.ts`

**Interfaces:**
- Consumes: `invokeCopyLocalPaths` from `src/lib/tauri.ts`, `useTransferStore`, `useToast`, `useSftpStore`.
- Produces: `copyWithPolicies` method added to `UseSftpPaneActionsResult`.

- [ ] **Step 1: Update imports in `src/hooks/useSftpPaneActions.ts`**

Add to the existing `invoke` imports from `@/lib/tauri` (around line 2):

```ts
invokeCopyLocalPaths,
```

- [ ] **Step 2: Add `copyWithPolicies` to the return type interface**

Update `UseSftpPaneActionsResult` (around line 36):

```ts
copyWithPolicies: (sourcePaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[]) => Promise<void>;
```

- [ ] **Step 3: Implement `copyWithPolicies`**

Insert after `uploadWithPolicies` (around line 454):

```ts
const copyWithPolicies = useCallback(
  async (sourcePaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[]) => {
    if (!isLocal) return;
    try {
      const operationId = `${connection.id}-copy-${Date.now()}`;
      addOperation({
        operationId,
        kind: 'upload',
        currentPath: sourcePaths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: sourcePaths.length,
        completedSteps: 0,
      });
      await invokeCopyLocalPaths({
        sourcePaths,
        destinationDirectory,
        conflictPolicies: policies,
        operationId,
      });
      await reload();
      clearSelection();
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
    }
  },
  [addOperation, connection.id, clearSelection, isLocal, reload, error],
);
```

- [ ] **Step 4: Expose `copyWithPolicies` in the returned object**

Add `copyWithPolicies,` to the return object (after `uploadWithPolicies`, around line 533).

- [ ] **Step 5: Update the test mock**

In `src/hooks/__tests__/useSftpPaneActions.test.ts`, add `copyWithPolicies: vi.fn().mockResolvedValue(undefined),` to the `createMockActions` return object (around line 62).

- [ ] **Step 6: Run the hook tests**

Run: `pnpm test src/hooks/__tests__/useSftpPaneActions.test.ts`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useSftpPaneActions.ts src/hooks/__tests__/useSftpPaneActions.test.ts
```

---

### Task 6: Frontend - Modify `SftpPane` for Ref Forwarding and System Drop Overlay

**Files:**
- Modify: `src/components/sftp/sftp-pane.tsx`
- Modify: `src/components/sftp/__tests__/sftp-pane.test.tsx`

**Interfaces:**
- Consumes: `systemDropActive` and `systemDropHovered` props from `SftpContent`.
- Produces: forwarded `ref` on the pane container, system drop overlay rendering.

- [ ] **Step 1: Update `SftpPaneProps` interface**

Add to `SftpPaneProps` (around line 28):

```ts
systemDropActive?: boolean;
systemDropHovered?: boolean;
```

- [ ] **Step 2: Convert `SftpPane` to `forwardRef`**

Change the component definition from:

```tsx
export const SftpPane: React.FC<SftpPaneProps> = ({
```

to:

```tsx
export const SftpPane = React.forwardRef<HTMLDivElement, SftpPaneProps>(function SftpPane(
  {
```

and close the component with `);` instead of `);`. The outer `return` statement and the component body stay the same.

- [ ] **Step 3: Destructure the new props and compute the overlay condition**

Add `systemDropActive = false` and `systemDropHovered = false` to the destructuring at the top of the component (around line 42):

```tsx
const {
  connection,
  side,
  actions,
  selectedPaths,
  onSelectedPathsChange,
  onVerifyHostKey,
  systemDropActive = false,
  systemDropHovered = false,
} = props;
```

- [ ] **Step 4: Update the overlay condition**

Replace the existing overlay block (around line 362):

```tsx
{(canAcceptActiveDrag && isOver) || (systemDropActive && systemDropHovered) && (
  <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-app-primary/70 bg-app-surface/70 p-6">
    <div className="flex flex-col items-center gap-2 px-5 py-4 text-center text-app-text">
      <MoveDownIcon aria-hidden="true" className="size-8 text-app-primary" />
      <span className="text-sm font-semibold">{t('sftp.dropHint')}</span>
    </div>
  </div>
)}
```

- [ ] **Step 5: Update the `SftpPane` tests**

Add a test in `src/components/sftp/__tests__/sftp-pane.test.tsx` after the existing tests:

```tsx
it('renders system drop overlay when hovered', () => {
  const connection = createConnection();
  render(
    <SftpPane
      connection={connection}
      side="remote"
      actions={createMockActions()}
      selectedPaths={new Set()}
      onSelectedPathsChange={vi.fn()}
      systemDropActive={true}
      systemDropHovered={true}
    />,
  );
  expect(screen.getByText('sftp.dropHint')).toBeInTheDocument();
});
```

- [ ] **Step 6: Run the pane tests**

Run: `pnpm test src/components/sftp/__tests__/sftp-pane.test.tsx`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add src/components/sftp/sftp-pane.tsx src/components/sftp/__tests__/sftp-pane.test.tsx
```

---

### Task 7: Frontend - Add `SftpContent` System Drop Tests

**Files:**
- Create: `src/components/sftp/__tests__/sftp-content-system-drop.test.tsx`

**Interfaces:**
- Consumes: mocked `useSystemFileDrop`, `useSftpPaneActions`, `useSftpConnection`, `useLocalDirectory`, `useSftpStore`.
- Produces: tests verifying remote drop calls upload and local drop calls copy.

- [ ] **Step 1: Create the test file**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { useSftpStore } from '@/stores/sftpStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

vi.mock('@/hooks/useSystemFileDrop', () => ({
  useSystemFileDrop: vi.fn(),
}));

vi.mock('@/hooks/useSftpConnectionOpener', () => ({
  useSftpConnectionOpener: () => ({
    open: vi.fn(),
    verifyHostKey: vi.fn(),
    hostKeyDialog: { open: false },
    closeHostKeyDialog: vi.fn(),
  }),
}));

vi.mock('@/components/ui/split-pane', () => ({
  SplitPane: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div>
      <div data-testid="left-pane">{left}</div>
      <div data-testid="right-pane">{right}</div>
    </div>
  ),
}));

vi.mock('@/components/sftp/sftp-tab-bar', () => ({
  SftpTabBar: () => <div data-testid="sftp-tab-bar" />,
}));

vi.mock('@/components/sftp/sftp-dnd-context', () => ({
  SftpDndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useSftpConnection', () => ({
  useSftpConnection: () => ({
    loadRemoteDirectory: vi.fn().mockResolvedValue(undefined),
    downloadRemotePaths: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useLocalDirectory', () => ({
  useLocalDirectory: () => ({
    loadLocalDirectory: vi.fn().mockResolvedValue(undefined),
    openLocalPath: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useSftpPaneActions', () => ({
  useSftpPaneActions: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeListLocalDirectory: vi.fn().mockResolvedValue({ path: '/local', entries: [] }),
  invokeListRemoteDirectory: vi.fn().mockResolvedValue({ path: '/remote', entries: [] }),
}));

const initialState = useSftpStore.getState();

function createConnection() {
  useSftpStore.getState().addConnection(
    { sessionId: 'c1', title: 'Test', host: 'h', port: 22, username: 'u' },
    { host: 'h', port: 22, username: 'u', authMethod: 'password' },
  );
  const connection = useSftpStore.getState().connections[0]!;
  useSftpStore.getState().setPath(connection.id, 'local', '/local');
  useSftpStore.getState().setPath(connection.id, 'remote', '/remote');
  return connection;
}

function createActions(overrides: Partial<ReturnType<typeof import('@/hooks/useSftpPaneActions').useSftpPaneActions>> = {}) {
  const base = {
    createMode: null,
    renameTarget: undefined,
    permissionsTarget: undefined,
    propertiesTarget: undefined,
    previewContent: undefined,
    uploadConflict: undefined,
    onOpen: vi.fn(),
    onOpenWithDefaultEditor: vi.fn().mockResolvedValue(undefined),
    onPreview: vi.fn().mockResolvedValue(undefined),
    onDownload: vi.fn().mockResolvedValue(undefined),
    onBatchDownload: vi.fn().mockResolvedValue(undefined),
    uploadWithPolicies: vi.fn().mockResolvedValue(undefined),
    copyWithPolicies: vi.fn().mockResolvedValue(undefined),
    onCopy: vi.fn(),
    onPaste: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onCopyName: vi.fn().mockResolvedValue(undefined),
    onCopyPath: vi.fn().mockResolvedValue(undefined),
    onCopyContainingDirectory: vi.fn().mockResolvedValue(undefined),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onUploadFiles: vi.fn().mockResolvedValue(undefined),
    onUploadFolders: vi.fn().mockResolvedValue(undefined),
    onEditPermissions: vi.fn(),
    onProperties: vi.fn(),
    onToggleBookmark: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onToggleBatchMode: vi.fn(),
    onCopyCurrentDirectoryPath: vi.fn().mockResolvedValue(undefined),
    setCreateMode: vi.fn(),
    setRenameTarget: vi.fn(),
    setPermissionsTarget: vi.fn(),
    setPropertiesTarget: vi.fn(),
    setPreviewContent: vi.fn(),
    setUploadConflict: vi.fn(),
    handleCreate: vi.fn().mockResolvedValue(undefined),
    handleRename: vi.fn().mockResolvedValue(undefined),
    handlePermissions: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

describe('SftpContent system drop', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
  });

  it('uploads when dropped paths are routed to remote side', async () => {
    const { useSystemFileDrop } = await import('@/hooks/useSystemFileDrop');
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    const copyWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;
    (useSystemFileDrop as unknown as typeof vi.fn).mockImplementation(({ onDrop }) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });

    const { useSftpPaneActions } = await import('@/hooks/useSftpPaneActions');
    (useSftpPaneActions as unknown as typeof vi.fn).mockReturnValue(createActions({ uploadWithPolicies, copyWithPolicies }));

    const { SftpContent } = await import('../index');
    createConnection();
    render(<SftpContent connection={useSftpStore.getState().connections[0]!} />);

    capturedOnDrop!(['/local/file.txt'], 'remote');
    await waitFor(() => expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/file.txt'], '/remote', []));
    expect(copyWithPolicies).not.toHaveBeenCalled();
  });

  it('copies locally when dropped paths are routed to local side', async () => {
    const { useSystemFileDrop } = await import('@/hooks/useSystemFileDrop');
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    const copyWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;
    (useSystemFileDrop as unknown as typeof vi.fn).mockImplementation(({ onDrop }) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });

    const { useSftpPaneActions } = await import('@/hooks/useSftpPaneActions');
    (useSftpPaneActions as unknown as typeof vi.fn).mockReturnValue(createActions({ uploadWithPolicies, copyWithPolicies }));

    const { SftpContent } = await import('../index');
    createConnection();
    render(<SftpContent connection={useSftpStore.getState().connections[0]!} />);

    capturedOnDrop!(['/remote/file.txt'], 'local');
    await waitFor(() => expect(copyWithPolicies).toHaveBeenCalledWith(['/remote/file.txt'], '/local', []));
    expect(uploadWithPolicies).not.toHaveBeenCalled();
  });
});
```

Note: `SftpContent` is not exported from `index.tsx` currently. The test plan relies on exporting it for testing. If exporting is undesirable, test the integration through the public `Sftp` component instead. If `SftpContent` is made public, add `export` before its definition in `src/components/sftp/index.tsx`.

- [ ] **Step 2: Export `SftpContent` if needed**

In `src/components/sftp/index.tsx`, change:

```tsx
const SftpContent: React.FC<SftpContentProps>
```

to:

```tsx
export const SftpContent: React.FC<SftpContentProps>
```

- [ ] **Step 3: Run the new integration tests**

Run: `pnpm test src/components/sftp/__tests__/sftp-content-system-drop.test.tsx`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/components/sftp/index.tsx src/components/sftp/__tests__/sftp-content-system-drop.test.tsx
```

---

### Task 8: Typecheck and Full Test Run

**Files:**
- (no file changes)

- [ ] **Step 1: Run TypeScript check**

Run: `pnpm exec tsc --noEmit`
Expected: no new errors from the changed files. Pre-existing errors may remain.

- [ ] **Step 2: Run frontend test suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 3: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all tests pass.

- [ ] **Step 4: Build the frontend**

Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 5: Final commit**

```bash
git add -A
```

---

## Self-Review

**Spec coverage:**
- Both local and remote panes accept system drops: Tasks 3, 4, 6.
- Files and folders recursively: Task 1 backend implementation.
- Reuse conflict dialog: Tasks 1, 4, 5.
- Local overlay feedback: Task 6.
- Tauri native event API: Task 3.
- Error handling: Task 1 backend errors, Task 5 toast, Task 4 `canDrop` guard.
- Testing: Tasks 1, 3, 6, 7, 8.

**Placeholder scan:** No TBD, TODO, or vague steps. All code blocks contain concrete implementations. Test code is provided.

**Type consistency:**
- `UploadConflictPolicy` matches frontend (`'overwrite' | 'replace' | 'skip' | 'fail'`) and backend (`#[serde(rename_all = "lowercase")]` Overwrite/Replace/Skip/Fail).
- `CopyLocalPathsRequest` fields match between `src/types/index.ts`, `src/lib/tauri.ts`, and `src-tauri/src/models.rs`.
- `useSystemFileDrop` returns `hoveredSide: 'local' | 'remote' | null` consistently.
- `UploadQueue` has `side: 'local' | 'remote'` in all references.

No gaps found.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-17-sftp-system-drag-drop.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
