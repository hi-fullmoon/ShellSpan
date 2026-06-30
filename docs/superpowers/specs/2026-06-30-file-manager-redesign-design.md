# FileManager UI Redesign Design

## Goal

Modernize the remote FileManager side panel to match a DevTools / system-monitor aesthetic while keeping it as the terminal's left sidebar, replacing the legacy path-input toolbar with a breadcrumb, enabling native multi-select, grouping context menus with icons, and adding a per-session operation log panel.

## Scope

- Visual refresh of the FileManager panel (colors, spacing, typography, 4px radius).
- Replace top path input with a clickable breadcrumb path bar.
- Reorganize the top toolbar into primary (breadcrumb) and secondary (actions + search) bars.
- Replace explicit batch-mode toggle with native Ctrl/Cmd + Shift multi-select and a conditional batch toolbar.
- Redesign context menus into icon + grouped text style.
- Add a bottom-right operation log panel per session.
- Keep the FileManager in the same layout position and size.
- Keep ag-grid as the file table engine.
- Keep all existing backend `invoke` commands unchanged.

## Out of Scope

- Local file tree / dual-pane SFTP client layout.
- Tree view in the file panel.
- Changing the application-level split layout or sidebar visibility behavior.
- Adding new backend file operations.

## Visual System

### Tokens (CSS custom properties)

Reuse existing `--app-*` tokens and add FileManager-specific aliases in `src/styles/file-manager.css`:

```css
--fm-bg: var(--app-bg);
--fm-surface: var(--app-surface);
--fm-surface-elevated: var(--app-surface-muted);
--fm-border: var(--app-border);
--fm-text: var(--app-text);
--fm-text-soft: var(--app-text-soft);
--fm-text-muted: var(--app-text-muted);
--fm-primary: var(--app-primary-bg);
--fm-primary-dim: color-mix(in srgb, var(--app-primary-bg) 20%, transparent);
--fm-success: #34d399;
--fm-warning: #fbbf24;
--fm-danger: #fb7185;
--fm-directory: #60a5fa;
--fm-executable: #34d399;
--fm-symlink: #c084fc;
--fm-hidden: var(--app-text-muted);
```

### Typography

- Breadcrumb / path: 12px `font-mono`.
- Toolbar button labels: 11px uppercase tracking-wide.
- Table header: 11px font-semibold, color `text-soft`.
- Table body: 12px, file name column `font-medium`.
- Context menu: 12px.
- Status badges: 10px.

### Spacing & Sizing

- Panel inner padding: `8px` (`p-2`).
- Table row height: `32px` (was 28).
- Toolbar button height: `28px`.
- Breadcrumb bar height: `28px`.
- Border radius: `4px` system-wide.
- Selection indicator: 2px left border on selected rows.

### File Status Colors

- Directory: blue folder icon.
- Executable file: green file icon.
- Symlink: purple link icon.
- Hidden file (name starts with `.`): muted gray text and icon.
- Selected row: left 2px accent bar + tinted background.

## Layout Structure

The FileManager component renders inside the existing `SplitLayout.Slot` named `fileManager`. Its internal structure becomes:

```
<aside className="surface ...">
  <PathBreadcrumb />
  <Toolbar />
  {selectedPaths.length > 1 && <BatchToolbar />}
  {error && <ErrorAlert />}
  {readOnly && <ReadOnlyAlert />}
  <FileGrid />
  <OperationLog />
  {contextMenu portal}
  {dialogs: preview, properties, create/rename, delete confirm, upload conflict}
  {drag overlay}
</aside>
```

### PathBreadcrumb

- Always visible when connected.
- Renders current path split by `/`.
- Each segment is a clickable button that navigates to that path.
- Root `/` is always the first segment, rendered as a small home/root icon.
- Current (last) segment is not clickable but double-clicking it turns the breadcrumb into an editable path input.
- Right side: copy current path button.

### Toolbar

Two logical rows in one component:

1. **Primary row (PathBreadcrumb)** — see above.
2. **Secondary row**:
   - Left action group: Refresh, New File, New Folder, Upload File, Upload Folder, Download (enabled when selection exists).
   - Right utility group: Search/filter input, view mode toggle (List / Compact). Compact is a visual placeholder for this iteration; the toggle exists but both modes render the list view until implemented later.

All write actions are disabled when `readOnly`, `loading`, or `working`.

### BatchToolbar

Rendered only when `selectedPaths.length > 1`:

- Left: "已选择 N 项" / "N selected".
- Right action group: Download selected, Delete selected, Copy selected, Clear selection.
- Pressing `Esc` or clicking a blank area of the grid clears the selection and hides the toolbar.

### FileGrid

- Keeps `AgGridReact`.
- Row height 32, header height 28.
- Selection mode is always `multiRow` with checkboxes, but checkboxes are visually subtle until hovered or selected.
- Column set:
  - Name (flex 1, min 160)
  - Modified (142)
  - Type (72)
  - Size (80)
  - Permissions (120)
  - Owner (80)
  - Group (80)
- Empty state rendered inside the grid overlay.

### OperationLog

- Fixed panel at the bottom-right of the FileManager.
- Shows the most recent 3 log entries for the current session.
- Each entry: status dot (running/blue, completed/green, failed/red, cancelled/gray), message, relative timestamp.
- Click to expand into a scrollable list (max 50 entries per session).
- Auto-dismiss/clear button.

## Interaction Logic

### Selection

- Remove `batchMode` state.
- Single click: select one row, clear previous selection unless modifier held.
- `Ctrl/Cmd + click`: toggle row selection.
- `Shift + click`: range select from last anchor.
- Right-click on an unselected row: select only that row and open menu.
- Right-click on a selected row while other rows are selected: keep multi-selection and open batch menu.
- `Esc` or clicking grid blank area: clear selection.

### Context Menus

Both menus use the existing `useContextMenu` hook but render a new visual component.

**Entry context menu** (file or directory):

```
┌─ [icon] filename ──────────┐
├─ 打开                      │
│  默认编辑器打开             │
│  预览                      │
├─ 传输 ─────────────────────┤
│  下载                      │
├─ 管理 ─────────────────────┤
│  复制   重命名   删除      │
├─ 信息 ─────────────────────┤
│  属性   编辑权限           │
└────────────────────────────┘
```

**Blank context menu** (right-click on empty grid area):

```
┌─ 当前目录 /var/www ────────┐
├─ 新建文件                  │
│  新建文件夹                │
│  上传文件                  │
│  上传文件夹                │
├─ 粘贴                      │
├─ 刷新                      │
└────────────────────────────┘
```

### Drag and Drop Upload

- Drag entering the FileManager area shows a localized dashed-border drop zone overlay.
- Drag entering the whole window shows a full-panel dark overlay with upload icon and current target path.
- Drop triggers existing upload flow.

### Operation Log Updates

Every long-running operation adds a log entry:

- `startOperation` -> log entry with status `running`.
- Progress events -> update progress text in log entry.
- `setOperationStatus` -> update status to `completed` / `failed` / `cancelled`.
- Toast messages can be shortened because details move to the log.

## Data Model Changes

Extend `FileManagerSessionState` in `src/stores/fileManagerStore.ts`:

```ts
interface OperationLogEntry {
  id: string;
  type: 'upload' | 'download' | 'delete' | 'rename' | 'create' | 'permission' | 'copy';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  message: string;
  timestamp: number;
  operationId?: string;
}

interface FileManagerSessionState {
  error?: string;
  listing?: RemoteDirectoryListing;
  pathInput: string;
  selectedPath?: string;
  selectedPaths?: string[];
  viewMode?: 'list' | 'compact';
  operationLogs?: OperationLogEntry[];
}
```

- `viewMode` defaults to `'list'`.
- `operationLogs` is kept per session and capped at 50 entries.

## Component Decomposition

Create directory `src/components/FileManager/` and move logic out of the existing monolithic `FileManager.tsx`:

| File | Responsibility |
|------|----------------|
| `src/components/FileManager/index.tsx` | Container: session state, effects, dialog state, context menu wiring, layout composition. |
| `src/components/FileManager/FileGrid.tsx` | `AgGridReact` configuration, row/cell renderers, selection handlers, empty/loading overlays. |
| `src/components/FileManager/PathBreadcrumb.tsx` | Breadcrumb rendering, segment navigation, editable path input toggle. |
| `src/components/FileManager/Toolbar.tsx` | Primary + secondary toolbar, batch toolbar rendering. |
| `src/components/FileManager/ContextMenu.tsx` | Entry and blank context menu content. |
| `src/components/FileManager/PropertiesPanel.tsx` | Properties overlay + inline permission editing. |
| `src/components/FileManager/PreviewPanel.tsx` | File preview overlay. |
| `src/components/FileManager/EmptyStates.tsx` | No session, connecting, empty directory, error, read-only states. |
| `src/components/FileManager/OperationLog.tsx` | Bottom-right operation log panel. |
| `src/components/FileManager/hooks/useFileOperations.ts` | Encapsulates upload, download, delete, rename, create, copy, permission update flows. |
| `src/components/FileManager/hooks/useDragDrop.ts` | Window-level and local drag-drop handling. |
| `src/components/FileManager/lib/formatters.ts` | Size, permissions, date formatting helpers moved from the monolith. |

Keep `src/components/FileManager.tsx` as a thin re-export of `src/components/FileManager/index.tsx` so existing imports in `App.tsx` and tests do not break during the refactor.

## State & Behavior

### Session lifecycle

- When session becomes connected and no listing exists, auto-load the default directory.
- When session disconnects, keep the listing visible but switch to read-only.
- When switching active sessions, the FileManager store preserves per-session state including logs.

### Errors

- Directory load errors show in the new `ErrorAlert` component with a retry button.
- Operation errors are shown both as a log entry and a short toast.

### Read-only

- Show an orange `ReadOnlyAlert` when `session.status !== 'connected'` but a listing exists.
- Disable all mutating toolbar/menu actions.

## Testing Requirements

- Existing `FileManager.test.tsx` must pass after the refactor.
- Add or update tests for:
  - Breadcrumb segment navigation.
  - Multi-select via Ctrl/Cmd and Shift.
  - Batch toolbar appears when more than one row is selected.
  - Context menu groups render with icon/button classes.
  - Operation log panel renders log entries.
  - Read-only state disables write actions.
- Keep mocking `ag-grid-react` and `@tauri-apps/api/*` as in existing tests.

## Accessibility

- Toolbar buttons keep `aria-label`.
- Breadcrumb segments are `<button>` with clear labels.
- Context menu uses `role="menu"` and menu items use `role="menuitem"`.
- Focus trap is not required for context menus but escape-to-close must work.

## i18n

All new strings must be added to:

- `src/locales/zh-CN.ts`
- `src/locales/en-US.ts`

Existing keys can be reused where wording is unchanged.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| ag-grid multi-select behavior differs from old batch mode | Verify with tests; use `getSelectedRows` and manual anchor tracking if needed. |
| Splitting 2800 lines into new files can break existing imports | Keep a re-export file at `src/components/FileManager.tsx` during refactor. |
| Operation log state growth | Cap logs at 50 entries per session. |
| Right-click menu positioning with new component | Reuse existing `useContextMenu` positioning logic. |

## Approval

This design was reviewed and approved by the product owner before implementation planning.
