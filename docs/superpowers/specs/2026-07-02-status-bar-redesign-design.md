# Status Bar Redesign Design

## Overview

Replace the existing `OperationStatusBar` with a unified, compact bottom `StatusBar`. All status indicators — file operations, session connections, active connection info, and update state — are rendered as small square blocks arranged horizontally.

## Goals

- Minimal visual footprint: status bar height `30px`.
- Each task/status is a `24px × 24px` square block.
- Running tasks flow horizontally; overflow collapses behind a `...` button.
- Clicking `...` opens a modal dialog showing all tasks as larger blocks.
- Hovering any block shows a floating detail card.
- Empty state: hide the bar entirely.

## Non-Goals

- Backward compatibility with the old list-based `OperationStatusBar` UI.
- Inline text labels inside the small blocks.
- Persistent system status when no information is present.

## Visual Design

### Status Bar Layout

```
┌─────────────────────────────────────────────────────────────┐
│ [▲▁] [▼▁] [🗑▁] [⋯] │ [●3] [H] [⬆45%]              │
└─────────────────────────────────────────────────────────────┘
```

- Height: `30px`.
- Background: `surface`, top border `border-t`.
- Left section: task blocks + overflow button.
- Divider: vertical line.
- Right section: system status blocks.

### Block Spec

- Size: `24px × 24px`.
- Corner radius: `4px`.
- Padding inside: `2px`.
- Icon area: `14px`, centered top.
- Progress bar: `2px` thick, full width at bottom.
- Gap between blocks: `4px`.

### Status Colors

| Status | Text/Icon | Progress |
|---|---|---|
| running / cancelling | sky-400 | sky-400 |
| completed | emerald-400 | emerald-400 |
| failed | rose-400 | rose-400 |
| cancelled / idle | slate-400 | slate-400 |

### Hover Detail Card

- Delay: `200ms`.
- Position: above the block, centered.
- Max width: `240px`.
- Content:
  - Task: icon + title, status text, progress %, total text, error message if failed.
  - System: descriptive text (e.g. "3 sessions connected").

### Overflow Modal Dialog

- Title: "所有任务" / "All Tasks".
- Grid of `40px × 40px` larger blocks.
- Each large block: bigger icon, thicker progress bar, truncated title below.
- Footer: "取消全部" button if any task is cancellable.

## Component Structure

```
src/components/StatusBar/
├── StatusBar.tsx          # container, visibility, layout
├── StatusBlock.tsx        # reusable square block
├── StatusBlockTooltip.tsx # hover detail card
├── TaskBlocks.tsx         # task list + overflow logic
├── TaskDialog.tsx         # overflow modal
└── SystemBlocks.tsx       # session / connection / update blocks
```

## Data Flow

- `StatusBar` reads from:
  - `useOperationStore` → `operations`
  - `useSessions` / App state → `sessions`, `activeSession`
  - `useUpdateFlow` → `updateState`, `updateDownloadProgress`
- `TaskBlocks` measures available width via `ResizeObserver` and computes visible count.
- Overflow count shown on the `...` button.
- `TaskDialog` receives all operations and renders the grid.

## Interactions

- Block hover → detail card.
- `...` click → open `TaskDialog`.
- Modal backdrop/close click → close.
- Per-task cancel/remove moved into the detail card.
- "取消全部" kept in the modal footer.

## Edge Cases

- No operations and no system info → render `null`.
- All tasks completed → green blocks; clear via detail-card remove or modal action.
- Long titles never shown inside small blocks.
- `ResizeObserver` unavailable in tests → mock or fallback to showing all.

## Testing

- `StatusBar` renders null when empty.
- Renders correct number of `StatusBlock` components for visible tasks.
- Renders `...` when overflow occurs.
- Clicking `...` opens `TaskDialog`.
- Hover shows correct detail content.
- "取消全部" triggers cancelling state on running tasks.
- System blocks reflect sessions, active connection, and update progress.
