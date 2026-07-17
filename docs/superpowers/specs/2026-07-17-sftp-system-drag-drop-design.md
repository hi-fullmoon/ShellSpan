# SFTP System File Manager Drag-and-Drop Upload Design

## Goal

Enable users to drag files and folders from the operating system's file manager (e.g., Finder on macOS, Explorer on Windows, file manager on Linux) and drop them onto the SFTP file manager panes to either upload to the remote side or copy into the local directory.

## Scope

- Accept drag-and-drop from the OS file manager onto both the local and remote SFTP panes.
- Support both files and folders recursively.
- Reuse the existing upload conflict dialog for both local and remote drops.
- Show localized drop zone feedback on the hovered pane.
- Use Tauri's native `onDragDropEvent` API to obtain real file system paths.

## Out of Scope

- Dragging from the SFTP app out to the OS file manager (export/download via drag-out).
- Drag-and-drop between multiple SFTP windows.
- Changing the existing internal @dnd-kit drag-and-drop between local and remote panes.

## Clarifications Made

| Question | Decision |
|----------|----------|
| Which panes accept drops? | Both local and remote panes. Drop on remote = upload to remote current directory. Drop on local = copy into local current directory. |
| Files and folders? | Both, recursively. |
| Conflict handling? | Reuse the existing overwrite/skip/cancel conflict dialog for both panes. |
| Visual feedback? | Local dashed-border overlay on the hovered pane only. |
| Implementation approach? | Tauri native window listener + coordinate-based pane detection. |

## Architecture

```
┌─────────────────────────────────────────┐
│              SftpContent                │
│  - owns left/right pane refs            │
│  - registers system drop listener       │
│  - routes drop to upload/copy queue     │
├──────────────┬──────────────────────────┤
│  SftpPane    │  SftpPane                │
│  (local)     │  (remote)                │
│  - ref       │  - ref                   │
│  - overlay   │  - overlay               │
└──────────────┴──────────────────────────┘
```

### Data Flow

1. `SftpContent` mounts `useSystemFileDrop({ leftPaneRef, rightPaneRef })`.
2. The hook registers `getCurrentWindow().onDragDropEvent`.
3. On `enter`/`over`, the hook sets `systemDragActive = true` and computes `hoveredSide` by intersecting the event position with the pane refs' bounding client rectangles.
4. On `leave`, the hook clears `systemDragActive` and `hoveredSide`.
5. On `drop`, the hook returns the dropped paths and the resolved `hoveredSide` to a callback registered by `SftpContent`.
6. `SftpContent` enqueues the transfer into the existing conflict queue (`UploadQueue`), generalized with a `side` field.
7. `processUploadQueue` dispatches to `remoteActions.uploadWithPolicies` or `localActions.copyWithPolicies` based on `side`.
8. After completion, the corresponding pane directory is refreshed.

## Frontend Changes

### New Hook: `src/hooks/useSystemFileDrop.ts`

```ts
import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { DragDropEvent } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';

interface UseSystemFileDropOptions {
  leftPaneRef: React.RefObject<HTMLElement | null>;
  rightPaneRef: React.RefObject<HTMLElement | null>;
  onDrop: (paths: string[], side: 'local' | 'remote') => void;
  canDrop?: (side: 'local' | 'remote') => boolean;
}

interface UseSystemFileDropResult {
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
      unlisten = await getCurrentWindow().onDragDropEvent((event) => {
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

### Modified: `src/components/sftp/index.tsx` (`SftpContent`)

- Add `leftPaneRef` and `rightPaneRef`.
- Call `useSystemFileDrop` and pass refs plus `canDrop` (only when the pane is ready, has a path, and is not loading/working).
- Add `handleSystemDrop(paths, side)` that populates `uploadQueueRef` with the side and destination path, then calls `processUploadQueue`.
- Generalize `UploadQueue` type:

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

- Update `processUploadQueue` to branch on `queue.side`:
  - `remote`: call `remoteActions.uploadWithPolicies(queue.accepted, queue.destination, queue.policies)`.
  - `local`: call `localActions.copyWithPolicies(queue.accepted, queue.destination, queue.policies)`.
- After the queue finishes, refresh the appropriate side and clear selection.

### Modified: `src/components/sftp/sftp-pane.tsx`

- Use `forwardRef` to expose the pane container ref.
- Accept new props: `systemDropActive: boolean; systemDropHovered: boolean`.
- Extend the existing overlay condition to include system drop:

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

### Modified: `src/hooks/useSftpPaneActions.ts`

- Add `copyWithPolicies` for the local side:

```ts
copyWithPolicies: (sourcePaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[]) => Promise<void>;
```

- The local pane already has `isLocal` guard for most remote-only actions, so `copyWithPolicies` is the only new local mutating operation needed.
- Implementation wraps `invokeCopyLocalPaths` with operation tracking, toast, and reload.

## Backend Changes

### New Command: `copy_local_paths`

File: `src-tauri/src/commands.rs`

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
        copy_local_paths_blocking(request)
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

### New Model: `CopyLocalPathsRequest`

File: `src-tauri/src/models.rs`

```rust
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct CopyLocalPathsRequest {
    pub source_paths: Vec<String>,
    pub destination_directory: String,
    pub conflict_policies: Vec<UploadConflictPolicy>,
    pub operation_id: String,
}
```

### Implementation: `copy_local_paths_blocking`

File: `src-tauri/src/commands.rs` or a new module `src-tauri/src/local_fs.rs`

- Resolve destination directory.
- Iterate over `source_paths`.
- For each source, determine target name.
- Apply conflict policy: `overwrite`, `skip`, or `fail`.
- Recursively copy directories using `std::fs::create_dir_all` and `std::fs::copy`.
- Return `Result<(), String>` on any error.

Conflict resolution logic mirrors `resolve_upload_target_name` used in `remote_fs.rs`.

### Registration

Add `copy_local_paths` to the `invoke_handler` in `src-tauri/src/lib.rs`:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    copy_local_paths,
])
```

### Frontend Binding

File: `src/lib/tauri.ts`

```ts
export async function invokeCopyLocalPaths(
  request: CopyLocalPathsRequest,
): Promise<void> {
  return invoke('copy_local_paths', { request });
}

export interface CopyLocalPathsRequest {
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: UploadConflictPolicy[];
  operationId: string;
}
```

## Conflict Handling

The existing `UploadQueue` in `SftpContent` is generalized to handle both sides:

```ts
const uploadQueueRef = useRef<UploadQueue | null>(null);

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

`processUploadQueue` resolves conflicts by looking up existing entries by name in the target directory:
- For remote: use `connection.remoteEntries`.
- For local: use `connection.localEntries`.

After resolution, the queue dispatches to the appropriate side action and refreshes the directory.

The `SftpUploadConflictDialog` UI is unchanged; it receives `PendingUploadConflict` and returns `UploadConflictAction` with `applyToRemaining`.

## Visual Feedback

- Internal drag overlay (from @dnd-kit) remains unchanged.
- System drag overlay uses the same visual style but is driven by `systemDropActive && systemDropHovered === side`.
- The overlay is rendered inside the hovered pane only.
- The overlay blocks pointer events so it does not interfere with row interactions during drag.

## Error Handling

- If a drop occurs outside any pane, it is ignored.
- If a pane is not ready (loading, no path, not connected), the drop is ignored and a toast is shown.
- Backend copy errors are shown via the existing toast system.
- Upload errors continue to be shown through the existing upload error path.

## i18n

No new keys are strictly required if the existing `sftp.dropHint` is kept generic. Optionally add:

- `sftp.dropHintLocal` - "Drop to copy to local directory"
- `sftp.dropHintRemote` - "Drop to upload to remote"

## Testing

### Frontend

- Unit test `useSystemFileDrop` with mocked `getCurrentWindow` and pane DOM rects.
- Verify `hoveredSide` resolves correctly when the position is inside left/right pane.
- Verify `onDrop` is called only when `canDrop` returns true.
- Test `SftpPane` renders the system drop overlay when `systemDropHovered` is true.
- Test `SftpContent` routes drops to `uploadWithPolicies` for remote and `copyWithPolicies` for local.

### Backend

- Add Rust tests for `copy_local_paths_blocking` using a temporary directory:
  - Copy a single file.
  - Copy a nested directory.
  - Conflict policy overwrite, skip, and fail.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Tauri `onDragDropEvent` may not fire in dev mode or may behave differently across OS | Test on macOS, Windows, and Linux during implementation. Use feature detection. |
| Pane ref coordinate detection can lag on fast mouse movement | Only the final `drop` event matters for the actual transfer; `hoveredSide` is best-effort visual feedback. |
| Local copy conflicts with the same conflict policy semantics as remote | Extract and reuse the `resolve_upload_target_name` logic from `remote_fs.rs`. |
| Internal @dnd-kit drag and system drag overlay could conflict | Keep state separate; system overlay takes precedence if both are active. |

## Approval

Design approved by the product owner for implementation planning.
