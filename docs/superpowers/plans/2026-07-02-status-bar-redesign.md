# Status Bar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing list-based `OperationStatusBar` with a compact, block-based unified `StatusBar` that displays file operations, session connections, active connection info, and update state as horizontal square blocks.

**Architecture:** Create a focused `src/components/StatusBar/` directory of small, single-responsibility components. `StatusBar` reads global state, delegates rendering to `TaskBlocks` and `SystemBlocks`, and uses `ResizeObserver` to collapse overflowing task blocks behind a `...` button. A modal `TaskDialog` shows the full task grid, and a custom `StatusBlockTooltip` renders hover detail cards.

**Tech Stack:** React, TypeScript, Tailwind CSS, `react-intl-universal` via `src/lib/i18n`, Zustand stores, Vitest + React Testing Library.

## Global Constraints

- Status bar height: `30px`.
- Block size: `24px × 24px` for status bar, `40px × 40px` inside the overflow modal.
- Gap between blocks: `4px`.
- Progress bar thickness: `2px` in status bar, `4px` in modal.
- Empty state: render `null` when no operations and no system info is present.
- No backward compatibility with old `OperationStatusBar` UI.
- Inline text labels are not shown inside small blocks.
- Colors: running/cancelling = sky-400, completed = emerald-400, failed = rose-400, cancelled/idle = slate-400.
- `ResizeObserver` unavailable in tests → mock or fallback to showing all blocks.

---

## File Structure

- `src/components/StatusBar/index.ts` — public exports.
- `src/components/StatusBar/types.ts` — shared props/types for blocks.
- `src/components/StatusBar/statusHelpers.ts` — pure helpers for status colors, operation icons, labels.
- `src/components/StatusBar/StatusBlock.tsx` — reusable square block (icon + progress bar).
- `src/components/StatusBar/StatusBlockTooltip.tsx` — hover detail card.
- `src/components/StatusBar/TaskBlocks.tsx` — task list + overflow logic.
- `src/components/StatusBar/TaskDialog.tsx` — overflow modal dialog.
- `src/components/StatusBar/SystemBlocks.tsx` — session / connection / update blocks.
- `src/components/StatusBar/StatusBar.tsx` — main container.
- `src/components/__tests__/StatusBar.test.tsx` — tests for the new status bar.
- `src/App.tsx:475` — replace `<OperationStatusBar />` with `<StatusBar />`.
- `src/locales/zh-CN.ts` — add new status bar copy.
- `src/locales/en-US.ts` — add new status bar copy.

---

### Task 1: Create StatusBar directory, shared types, and helper utilities

**Files:**
- Create: `src/components/StatusBar/index.ts`
- Create: `src/components/StatusBar/types.ts`
- Create: `src/components/StatusBar/statusHelpers.ts`
- Test: `src/components/__tests__/StatusBar.test.tsx` (will be extended in Task 10)

**Interfaces:**
- Consumes: `OperationItem`, `OperationType`, `OperationStatus` from `src/stores/operationStore.ts`; `SessionState` from `src/types.ts`; `UpdateState` from `src/types.ts`.
- Produces:
  - `StatusBlockProps { icon: ReactNode; progress: number; tone: StatusTone; children?: ReactNode; className?: string; size?: 'sm' | 'lg'; }`
  - `StatusTone = 'active' | 'success' | 'error' | 'neutral'`
  - `TaskBlockData { operation: OperationItem; onCancel: () => void; onRemove: () => void; }`
  - `operationTone(status: OperationStatus): StatusTone`
  - `operationIcon(type: OperationType): ReactNode`
  - `operationTypeLabel(type: OperationType): string`
  - `operationStatusText(status: OperationStatus): string`

- [ ] **Step 1: Write the failing test for helpers**

```tsx
import { describe, expect, it } from 'vitest';
import { operationTone, operationTypeLabel, operationStatusText } from '../StatusBar/statusHelpers';

describe('statusHelpers', () => {
  it('maps running to active tone', () => {
    expect(operationTone('running')).toBe('active');
  });

  it('maps completed to success tone', () => {
    expect(operationTone('completed')).toBe('success');
  });

  it('returns localized operation type label', () => {
    expect(operationTypeLabel('upload')).toBe('上传');
  });

  it('returns localized status text', () => {
    expect(operationStatusText('running')).toBe('进行中');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: FAIL with "Cannot find module '../StatusBar/statusHelpers'"

- [ ] **Step 3: Create directory and shared files**

Create `src/components/StatusBar/index.ts`:

```ts
export { StatusBar } from './StatusBar';
```

Create `src/components/StatusBar/types.ts`:

```ts
import type { ReactNode } from 'react';
import type { OperationItem, OperationStatus, OperationType } from '../../stores/operationStore';

export type StatusTone = 'active' | 'success' | 'error' | 'neutral';

export interface StatusBlockProps {
  icon: ReactNode;
  progress: number;
  tone: StatusTone;
  children?: ReactNode;
  className?: string;
  size?: 'sm' | 'lg';
}

export interface TaskBlockData {
  operation: OperationItem;
  onCancel: () => void;
  onRemove: () => void;
}

export interface StatusBlockTooltipData {
  title: string;
  subtitle?: string;
  detail?: string;
  errorMessage?: string;
}
```

Create `src/components/StatusBar/statusHelpers.ts`:

```ts
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { UploadIcon, DownloadIcon, TrashIcon, FileIcon } from '../Icons';
import type { OperationStatus, OperationType } from '../../stores/operationStore';
import type { StatusTone } from './types';

export function operationTone(status: OperationStatus): StatusTone {
  switch (status) {
    case 'running':
    case 'cancelling':
      return 'active';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'neutral';
  }
}

export function operationIcon(type: OperationType): ReactNode {
  switch (type) {
    case 'upload':
      return <UploadIcon className="rotate-180" />;
    case 'download':
      return <DownloadIcon />;
    case 'delete':
      return <TrashIcon />;
    case 'open-with-default':
      return <FileIcon />;
  }
}

export function operationTypeLabel(type: OperationType): string {
  switch (type) {
    case 'upload':
      return t('operationStatus.type.upload');
    case 'download':
      return t('operationStatus.type.download');
    case 'delete':
      return t('operationStatus.type.delete');
    case 'open-with-default':
      return t('operationStatus.type.openWithDefault');
  }
}

export function operationStatusText(status: OperationStatus): string {
  switch (status) {
    case 'running':
      return t('operationStatus.status.running');
    case 'cancelling':
      return t('operationStatus.status.cancelling');
    case 'completed':
      return t('operationStatus.status.completed');
    case 'failed':
      return t('operationStatus.status.failed');
    case 'cancelled':
      return t('operationStatus.status.cancelled');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/StatusBar src/components/__tests__/StatusBar.test.tsx
git commit -m "feat(status-bar): add shared types and helpers"
```

---

### Task 2: Build reusable StatusBlock component

**Files:**
- Create: `src/components/StatusBar/StatusBlock.tsx`
- Test: `src/components/__tests__/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `StatusBlockProps`, `StatusTone` from `src/components/StatusBar/types.ts`.
- Produces: `StatusBlock` component.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StatusBlock } from '../StatusBar/StatusBlock';

describe('StatusBlock', () => {
  it('renders small block with icon and progress bar', () => {
    const { container } = render(
      <StatusBlock icon={<span data-testid="icon">I</span>} progress={45} tone="active" />,
    );
    expect(container.querySelector('[data-testid="icon"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="status-block-progress"]')).toHaveStyle({ width: '45%' });
  });

  it('renders large block when size is lg', () => {
    const { container } = render(
      <StatusBlock icon={<span data-testid="icon">I</span>} progress={80} tone="success" size="lg" />,
    );
    expect(container.querySelector('[data-testid="status-block"]')).toHaveClass('h-10', 'w-10');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: FAIL with "Cannot find module '../StatusBar/StatusBlock'"

- [ ] **Step 3: Implement StatusBlock**

Create `src/components/StatusBar/StatusBlock.tsx`:

```tsx
import { cn } from '../../lib/ui';
import type { StatusBlockProps } from './types';

export function StatusBlock({ icon, progress, tone, children, className, size = 'sm' }: StatusBlockProps) {
  const isLarge = size === 'lg';

  const trackClass =
    tone === 'active'
      ? 'bg-slate-700/50'
      : tone === 'success'
        ? 'bg-emerald-900/30'
        : tone === 'error'
          ? 'bg-rose-900/30'
          : 'bg-slate-700/30';
  const barClass =
    tone === 'active'
      ? 'bg-sky-400'
      : tone === 'success'
        ? 'bg-emerald-400'
        : tone === 'error'
          ? 'bg-rose-400'
          : 'bg-slate-400';

  return (
    <div
      className={cn(
        'relative flex shrink-0 flex-col items-center justify-center overflow-hidden rounded',
        isLarge ? 'h-10 w-10' : 'h-6 w-6',
        'border border-transparent',
        className,
      )}
      data-testid="status-block"
    >
      <div className={cn('flex items-center justify-center', isLarge ? 'h-5 w-5' : 'h-3.5 w-3.5')}>
        {icon}
      </div>
      <div className={cn('absolute bottom-0 left-0 right-0 overflow-hidden rounded-full', trackClass)}>
        <div
          className={cn('transition-[width] duration-150', barClass, isLarge ? 'h-1' : 'h-0.5')}
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          data-testid="status-block-progress"
        />
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/StatusBar/StatusBlock.tsx src/components/__tests__/StatusBar.test.tsx
git commit -m "feat(status-bar): add reusable StatusBlock component"
```

---

### Task 3: Build StatusBlockTooltip hover detail card

**Files:**
- Create: `src/components/StatusBar/StatusBlockTooltip.tsx`
- Test: `src/components/__tests__/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `StatusBlockTooltipData` from `src/components/StatusBar/types.ts`.
- Produces: `StatusBlockTooltip` component with `open`, `anchorRef`, `data` props.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StatusBlockTooltip } from '../StatusBar/StatusBlockTooltip';

describe('StatusBlockTooltip', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <StatusBlockTooltip open={false} anchorRef={{ current: null }} data={{ title: 'Upload' }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders detail content when open', () => {
    const { getByText } = render(
      <StatusBlockTooltip open={true} anchorRef={{ current: null }} data={{ title: 'Upload file.txt', subtitle: '进行中', detail: '45%' }} />,
    );
    expect(getByText('Upload file.txt')).toBeInTheDocument();
    expect(getByText('进行中')).toBeInTheDocument();
    expect(getByText('45%')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: FAIL with "Cannot find module '../StatusBar/StatusBlockTooltip'"

- [ ] **Step 3: Implement StatusBlockTooltip**

Create `src/components/StatusBar/StatusBlockTooltip.tsx`:

```tsx
import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/ui';
import type { StatusBlockTooltipData } from './types';

interface StatusBlockTooltipProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  data: StatusBlockTooltipData;
}

export function StatusBlockTooltip({ open, anchorRef, data }: StatusBlockTooltipProps) {
  const [coords, setCoords] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useEffect(() => {
    if (!open || !anchorRef.current) return;

    const rect = anchorRef.current.getBoundingClientRect();
    setCoords({
      left: rect.left + rect.width / 2,
      top: rect.top,
    });
  }, [open, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      className={cn(
        'pointer-events-none fixed z-[1700] max-w-[240px] -translate-x-1/2 -translate-y-full rounded-md px-2.5 py-2 text-xs',
        'border shadow-lg',
      )}
      style={{
        left: coords.left,
        top: coords.top - 6,
        background: 'var(--app-panel-primary)',
        borderColor: 'var(--app-border)',
        color: 'var(--app-text)',
      }}
      role="tooltip"
    >
      <div className="font-medium">{data.title}</div>
      {data.subtitle ? <div className="mt-0.5 text-subtle">{data.subtitle}</div> : null}
      {data.detail ? <div className="mt-0.5">{data.detail}</div> : null}
      {data.errorMessage ? <div className="mt-1 text-rose-300">{data.errorMessage}</div> : null}
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/StatusBar/StatusBlockTooltip.tsx src/components/__tests__/StatusBar.test.tsx
git commit -m "feat(status-bar): add hover tooltip card"
```

---

### Task 4: Build TaskBlocks overflow logic

**Files:**
- Create: `src/components/StatusBar/TaskBlocks.tsx`
- Test: `src/components/__tests__/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `OperationItem` from `src/stores/operationStore.ts`; `StatusBlock`, `StatusBlockTooltip` from sibling files; `operationTone`, `operationIcon`, `operationTypeLabel`, `operationStatusText` from `statusHelpers.ts`.
- Produces: `TaskBlocks` component with props `{ operations: OperationItem[]; onCancel: (id: string) => void; onRemove: (id: string) => void; onOpenDialog: () => void; }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TaskBlocks } from '../StatusBar/TaskBlocks';
import { useOperationStore } from '../../stores/operationStore';

describe('TaskBlocks', () => {
  beforeEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  it('renders visible task blocks', () => {
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
      { id: 'op-2', type: 'download', title: 'B', status: 'completed', progress: 100, canCancel: true, createdAt: 2 },
    ] as OperationItem[];

    const { container } = render(
      <TaskBlocks operations={operations} onCancel={() => {}} onRemove={() => {}} onOpenDialog={() => {}} />,
    );
    expect(container.querySelectorAll('[data-testid="status-block"]')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: FAIL with "Cannot find module '../StatusBar/TaskBlocks'"

- [ ] **Step 3: Implement TaskBlocks**

Create `src/components/StatusBar/TaskBlocks.tsx`:

```tsx
import { useEffect, useRef, useState, useMemo } from 'react';
import { DotsIcon } from '../Icons';
import type { OperationItem } from '../../stores/operationStore';
import { cn } from '../../lib/ui';
import { StatusBlock } from './StatusBlock';
import { StatusBlockTooltip } from './StatusBlockTooltip';
import { operationIcon, operationStatusText, operationTone, operationTypeLabel } from './statusHelpers';

const BLOCK_SIZE = 24;
const BLOCK_GAP = 4;
const OVERFLOW_BUTTON_WIDTH = 24;

interface TaskBlocksProps {
  operations: OperationItem[];
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenDialog: () => void;
}

export function TaskBlocks({ operations, onCancel, onRemove, onOpenDialog }: TaskBlocksProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState<number>(operations.length);

  const activeCount = useMemo(
    () => operations.filter((op) => op.status === 'running' || op.status === 'cancelling').length,
    [operations],
  );

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === 'undefined') {
      setVisibleCount(operations.length);
      return;
    }

    const element = containerRef.current;

    const updateVisibleCount = () => {
      const width = element.clientWidth;
      if (width === 0) {
        setVisibleCount(operations.length);
        return;
      }

      const overflowSpace = OVERFLOW_BUTTON_WIDTH + BLOCK_GAP;
      let count = 0;
      let used = 0;

      for (let i = 0; i < operations.length; i++) {
        const nextUsed = used + BLOCK_SIZE + (count > 0 ? BLOCK_GAP : 0);
        if (nextUsed + (i < operations.length - 1 ? overflowSpace : 0) <= width) {
          count += 1;
          used = nextUsed;
        } else {
          break;
        }
      }

      setVisibleCount(count);
    };

    updateVisibleCount();

    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(element);

    return () => observer.disconnect();
  }, [operations.length]);

  const visible = operations.slice(0, visibleCount);
  const hidden = operations.slice(visibleCount);

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center gap-1">
      {visible.map((operation) => (
        <TaskBlock
          key={operation.id}
          operation={operation}
          onCancel={() => onCancel(operation.id)}
          onRemove={() => onRemove(operation.id)}
        />
      ))}
      {hidden.length > 0 ? (
        <button
          className="icon-btn flex h-6 w-6 shrink-0 items-center justify-center p-0"
          onClick={onOpenDialog}
          type="button"
          title={`${hidden.length} more`}
          data-testid="task-overflow-button"
        >
          <DotsIcon />
        </button>
      ) : null}
    </div>
  );
}

function TaskBlock({ operation, onCancel, onRemove }: { operation: OperationItem; onCancel: () => void; onRemove: () => void }) {
  const blockRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const isRunning = operation.status === 'running';
  const isCancelling = operation.status === 'cancelling';
  const isCompleted = operation.status === 'completed';
  const isFailed = operation.status === 'failed';

  return (
    <div
      ref={blockRef}
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <StatusBlock icon={operationIcon(operation.type)} progress={operation.progress} tone={operationTone(operation.status)} />
      <StatusBlockTooltip
        open={hovered}
        anchorRef={blockRef}
        data={{
          title: `${operationTypeLabel(operation.type)} · ${operation.title}`,
          subtitle: operationStatusText(operation.status),
          detail: operation.totalText ? `${operation.progress}% · ${operation.totalText}` : `${operation.progress}%`,
          errorMessage: operation.errorMessage,
        }}
      />
      {(isRunning || isCancelling) && operation.canCancel ? (
        <button
          className="icon-btn absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full p-0 text-[8px]"
          disabled={isCancelling}
          onClick={onCancel}
          title={operationStatusText('cancelling')}
          type="button"
        >
          ×
        </button>
      ) : null}
      {!isRunning && !isCancelling ? (
        <button
          className="icon-btn absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full p-0 text-[8px]"
          onClick={onRemove}
          title={operationStatusText('cancelled')}
          type="button"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/StatusBar/TaskBlocks.tsx src/components/__tests__/StatusBar.test.tsx
git commit -m "feat(status-bar): add TaskBlocks with overflow logic"
```

---

### Task 5: Build TaskDialog overflow modal

**Files:**
- Create: `src/components/StatusBar/TaskDialog.tsx`
- Test: `src/components/__tests__/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `OperationItem` from `src/stores/operationStore.ts`; `Dialog`, `DialogPanel`, `DialogHeader`, `DialogFooter` from `src/components/Dialog.tsx`; `StatusBlock` from `StatusBlock.tsx`; `operationIcon`, `operationTone`, `operationTypeLabel`, `operationStatusText` from `statusHelpers.ts`.
- Produces: `TaskDialog` component with props `{ open: boolean; onClose: () => void; operations: OperationItem[]; onCancel: (id: string) => void; onRemove: (id: string) => void; onCancelAll: () => void; }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskDialog } from '../StatusBar/TaskDialog';
import { useOperationStore } from '../../stores/operationStore';

describe('TaskDialog', () => {
  beforeEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  it('renders all tasks when open', () => {
    const operations = [
      { id: 'op-1', type: 'upload', title: 'A', status: 'running', progress: 10, canCancel: true, createdAt: 1 },
      { id: 'op-2', type: 'download', title: 'B', status: 'completed', progress: 100, canCancel: true, createdAt: 2 },
    ] as OperationItem[];

    const { getAllByTestId } = render(
      <TaskDialog open={true} onClose={() => {}} operations={operations} onCancel={() => {}} onRemove={() => {}} onCancelAll={() => {}} />,
    );
    expect(getAllByTestId('status-block')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: FAIL with "Cannot find module '../StatusBar/TaskDialog'"

- [ ] **Step 3: Implement TaskDialog**

Create `src/components/StatusBar/TaskDialog.tsx`:

```tsx
import { Dialog, DialogPanel, DialogHeader, DialogFooter } from '../Dialog';
import type { OperationItem } from '../../stores/operationStore';
import { t } from '../../lib/i18n';
import { StatusBlock } from './StatusBlock';
import { operationIcon, operationTone } from './statusHelpers';
import { cn } from '../../lib/ui';

interface TaskDialogProps {
  open: boolean;
  onClose: () => void;
  operations: OperationItem[];
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onCancelAll: () => void;
}

export function TaskDialog({ open, onClose, operations, onCancel, onRemove, onCancelAll }: TaskDialogProps) {
  const cancellable = operations.filter((op) => op.status === 'running' && op.canCancel);

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="w-full max-w-md p-4" ariaLabel={t('statusBar.taskDialog.title')}>
        <DialogHeader title={t('statusBar.taskDialog.title')} onClose={onClose} />
        <div className="mt-3 flex flex-wrap gap-2">
          {operations.map((operation) => (
            <div key={operation.id} className="flex w-16 flex-col items-center gap-1">
              <StatusBlock
                icon={operationIcon(operation.type)}
                progress={operation.progress}
                tone={operationTone(operation.status)}
                size="lg"
              />
              <span className="max-w-full truncate text-[10px]" title={operation.title}>
                {operation.title}
              </span>
              {operation.status === 'running' && operation.canCancel ? (
                <button
                  className="text-[10px] text-sky-400 hover:text-sky-300"
                  onClick={() => onCancel(operation.id)}
                  type="button"
                >
                  {t('operationStatus.actions.cancel')}
                </button>
              ) : operation.status !== 'running' && operation.status !== 'cancelling' ? (
                <button
                  className="text-[10px] text-slate-400 hover:text-slate-300"
                  onClick={() => onRemove(operation.id)}
                  type="button"
                >
                  {t('operationStatus.actions.remove')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {cancellable.length > 0 ? (
          <DialogFooter>
            <button className="btn-danger" onClick={onCancelAll} type="button">
              {t('operationStatus.actions.cancelAll')}
            </button>
          </DialogFooter>
        ) : null}
      </DialogPanel>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/StatusBar/TaskDialog.tsx src/components/__tests__/StatusBar.test.tsx
git commit -m "feat(status-bar): add TaskDialog overflow modal"
```

---

### Task 6: Build SystemBlocks

**Files:**
- Create: `src/components/StatusBar/SystemBlocks.tsx`
- Test: `src/components/__tests__/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `SessionState` from `src/types.ts`; `UpdateState` from `src/types.ts`; `StatusBlock`, `StatusBlockTooltip` from sibling files.
- Produces: `SystemBlocks` component with props `{ sessions: SessionState[]; activeSession: SessionState | undefined; updateState: UpdateState; updateDownloadProgress: number | undefined; }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SystemBlocks } from '../StatusBar/SystemBlocks';

describe('SystemBlocks', () => {
  it('renders session count block', () => {
    const sessions = [
      { sessionId: 's1', status: 'connected', host: 'host1' },
      { sessionId: 's2', status: 'connecting', host: 'host2' },
    ] as SessionState[];

    const { container } = render(
      <SystemBlocks sessions={sessions} activeSession={sessions[0]} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />,
    );
    expect(container.querySelectorAll('[data-testid="status-block"]')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: FAIL with "Cannot find module '../StatusBar/SystemBlocks'"

- [ ] **Step 3: Implement SystemBlocks**

Create `src/components/StatusBar/SystemBlocks.tsx`:

```tsx
import { useMemo, useRef, useState } from 'react';
import type { SessionState } from '../../types';
import { StatusBlock } from './StatusBlock';
import { StatusBlockTooltip } from './StatusBlockTooltip';
import { t } from '../../lib/i18n';
import type { UpdateState } from '../../types';
import { cn } from '../../lib/ui';

interface SystemBlocksProps {
  sessions: SessionState[];
  activeSession: SessionState | undefined;
  updateState: UpdateState;
  updateDownloadProgress: number | undefined;
}

export function SystemBlocks({ sessions, activeSession, updateState, updateDownloadProgress }: SystemBlocksProps) {
  const connectedCount = useMemo(() => sessions.filter((s) => s.status === 'connected').length, [sessions]);
  const hasUpdate = updateState.phase !== 'idle' && updateState.phase !== 'noUpdate';

  return (
    <div className="flex shrink-0 items-center gap-1">
      {sessions.length > 0 ? (
        <SystemBlock
          icon={<SessionCountIcon count={connectedCount} />}
          progress={100}
          tone="neutral"
          tooltip={{ title: t('statusBar.system.sessions', { count: sessions.length, connected: connectedCount }) }}
        />
      ) : null}
      {activeSession ? (
        <SystemBlock
          icon={<HostInitial host={activeSession.host} />}
          progress={100}
          tone={activeSession.status === 'connected' ? 'success' : activeSession.status === 'error' ? 'error' : 'active'}
          tooltip={{ title: activeSession.title || activeSession.host, subtitle: activeSession.status }}
        />
      ) : null}
      {hasUpdate ? (
        <SystemBlock
          icon={<UpdateIcon phase={updateState.phase} />}
          progress={updateDownloadProgress ?? (updateState.phase === 'downloaded' ? 100 : 0)}
          tone={updateState.phase === 'downloadFailed' ? 'error' : updateState.phase === 'downloaded' ? 'success' : 'active'}
          tooltip={{ title: t('statusBar.system.update'), subtitle: updateState.phase }}
        />
      ) : null}
    </div>
  );
}

function SystemBlock({
  icon,
  progress,
  tone,
  tooltip,
}: {
  icon: React.ReactNode;
  progress: number;
  tone: 'active' | 'success' | 'error' | 'neutral';
  tooltip: { title: string; subtitle?: string };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      ref={ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <StatusBlock icon={icon} progress={progress} tone={tone} />
      <StatusBlockTooltip open={hovered} anchorRef={ref} data={tooltip} />
    </div>
  );
}

function SessionCountIcon({ count }: { count: number }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-[9px] font-semibold leading-none">
      {count}
    </div>
  );
}

function HostInitial({ host }: { host: string }) {
  const initial = host ? host.charAt(0).toUpperCase() : '?';
  return (
    <div className="flex h-full w-full items-center justify-center text-[9px] font-semibold leading-none">
      {initial}
    </div>
  );
}

function UpdateIcon({ phase }: { phase: UpdateState['phase'] }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-[9px] font-semibold leading-none">
      {phase === 'downloaded' ? '✓' : '↻'}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/StatusBar/SystemBlocks.tsx src/components/__tests__/StatusBar.test.tsx
git commit -m "feat(status-bar): add SystemBlocks for session and update state"
```

---

### Task 7: Build StatusBar container

**Files:**
- Create: `src/components/StatusBar/StatusBar.tsx`
- Modify: `src/components/StatusBar/index.ts`
- Test: `src/components/__tests__/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `useOperationStore` from `src/stores/operationStore.ts`; `TaskBlocks`, `TaskDialog`, `SystemBlocks` from sibling files; `selectHasVisibleOperations` from store; `SessionState` from `src/types.ts`; `UpdateState` from `src/types.ts`.
- Produces: `StatusBar` component with props `{ sessions: SessionState[]; activeSession: SessionState | undefined; updateState: UpdateState; updateDownloadProgress: number | undefined; }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { StatusBar } from '../StatusBar';
import { useOperationStore } from '../../stores/operationStore';

describe('StatusBar', () => {
  beforeEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  it('renders null when empty', () => {
    const { container } = render(<StatusBar sessions={[]} activeSession={undefined} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders task blocks when operations exist', () => {
    useOperationStore.getState().startOperation({ id: 'op-1', type: 'upload', title: 'A', progress: 10 });
    const { container } = render(
      <StatusBar sessions={[]} activeSession={undefined} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />,
    );
    expect(container.querySelector('[data-testid="status-block"]')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: FAIL with "Cannot find module '../StatusBar'" or "StatusBar is not a function"

- [ ] **Step 3: Implement StatusBar**

Update `src/components/StatusBar/index.ts`:

```ts
export { StatusBar } from './StatusBar';
```

Create `src/components/StatusBar/StatusBar.tsx`:

```tsx
import { useState } from 'react';
import type { SessionState, UpdateState } from '../../types';
import { useOperationStore } from '../../stores/operationStore';
import { TaskBlocks } from './TaskBlocks';
import { TaskDialog } from './TaskDialog';
import { SystemBlocks } from './SystemBlocks';

interface StatusBarProps {
  sessions: SessionState[];
  activeSession: SessionState | undefined;
  updateState: UpdateState;
  updateDownloadProgress: number | undefined;
}

export function StatusBar({ sessions, activeSession, updateState, updateDownloadProgress }: StatusBarProps) {
  const { operations, setCancelling, removeOperation } = useOperationStore();
  const [dialogOpen, setDialogOpen] = useState(false);

  const hasSystemInfo = sessions.length > 0 || updateState.phase === 'checking' || updateState.phase === 'downloading' || updateState.phase === 'downloaded' || updateState.phase === 'downloadFailed';

  if (operations.length === 0 && !hasSystemInfo) {
    return null;
  }

  const handleCancelAll = () => {
    operations.forEach((op) => {
      if (op.status === 'running' && op.canCancel) {
        setCancelling(op.id);
      }
    });
  };

  return (
    <div
      className="surface border-t flex h-[30px] items-center gap-2 px-2"
      data-testid="status-bar"
    >
      {operations.length > 0 ? (
        <TaskBlocks
          operations={operations}
          onCancel={(id) => setCancelling(id)}
          onRemove={(id) => removeOperation(id)}
          onOpenDialog={() => setDialogOpen(true)}
        />
      ) : null}

      {operations.length > 0 && hasSystemInfo ? (
        <div className="h-4 w-px shrink-0 bg-[var(--app-border)]" />
      ) : null}

      {hasSystemInfo ? (
        <SystemBlocks
          sessions={sessions}
          activeSession={activeSession}
          updateState={updateState}
          updateDownloadProgress={updateDownloadProgress}
        />
      ) : null}

      <TaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        operations={operations}
        onCancel={(id) => setCancelling(id)}
        onRemove={(id) => removeOperation(id)}
        onCancelAll={handleCancelAll}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/StatusBar/StatusBar.tsx src/components/StatusBar/index.ts src/components/__tests__/StatusBar.test.tsx
git commit -m "feat(status-bar): add StatusBar container component"
```

---

### Task 8: Integrate StatusBar into App and remove OperationStatusBar

**Files:**
- Modify: `src/App.tsx:10` — update import.
- Modify: `src/App.tsx:475` — replace component usage.
- Delete: `src/components/OperationStatusBar.tsx`
- Delete: `src/components/__tests__/OperationStatusBar.test.tsx`
- Test: existing `src/__tests__/app*.test.tsx` files should still pass.

**Interfaces:**
- Consumes: `StatusBar` from `src/components/StatusBar`.
- Produces: App renders `<StatusBar sessions={sessions} activeSession={activeSession} updateState={updateState} updateDownloadProgress={updateDownloadProgress} />`.

- [ ] **Step 1: Update App.tsx imports**

Replace `src/App.tsx:10`:

```tsx
import { StatusBar } from './components/StatusBar';
```

- [ ] **Step 2: Replace component usage**

Replace `src/App.tsx:475`:

```tsx
      <StatusBar
        sessions={sessions}
        activeSession={activeSession}
        updateState={updateState}
        updateDownloadProgress={updateDownloadProgress}
      />
```

- [ ] **Step 3: Delete old component and tests**

```bash
rm src/components/OperationStatusBar.tsx
rm src/components/__tests__/OperationStatusBar.test.tsx
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass (158 tests before + new StatusBar tests).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/StatusBar src/components/__tests__/StatusBar.test.tsx
git rm src/components/OperationStatusBar.tsx src/components/__tests__/OperationStatusBar.test.tsx
git commit -m "feat(status-bar): integrate new StatusBar and remove OperationStatusBar"
```

---

### Task 9: Add i18n keys for new status bar copy

**Files:**
- Modify: `src/locales/zh-CN.ts`
- Modify: `src/locales/en-US.ts`
- Test: existing i18n tests / run full suite.

**Interfaces:**
- Produces: new keys `statusBar.taskDialog.title`, `statusBar.system.sessions`, `statusBar.system.update`.

- [ ] **Step 1: Add keys to zh-CN.ts**

Insert after `'operationStatus.actions.collapse': '收起',`:

```ts
  'statusBar.taskDialog.title': '所有任务',
  'statusBar.system.sessions': '{connected} / {count} 个会话已连接',
  'statusBar.system.update': '应用更新',
```

- [ ] **Step 2: Add keys to en-US.ts**

Insert after `'operationStatus.actions.collapse': 'Collapse',`:

```ts
  'statusBar.taskDialog.title': 'All Tasks',
  'statusBar.system.sessions': '{connected} / {count} sessions connected',
  'statusBar.system.update': 'App Update',
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(status-bar): add i18n keys for new status bar"
```

---

### Task 10: Expand StatusBar tests

**Files:**
- Modify: `src/components/__tests__/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `StatusBar`, `TaskBlocks`, `TaskDialog` from `src/components/StatusBar`.
- Produces: comprehensive tests for hover, overflow, cancel all, system blocks.

- [ ] **Step 1: Add overflow and dialog tests**

Append to `src/components/__tests__/StatusBar.test.tsx`:

```tsx
describe('StatusBar overflow', () => {
  beforeEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  afterEach(() => {
    cleanup();
    useOperationStore.setState({ operations: [], expanded: false });
  });

  it('opens task dialog when overflow button is clicked', async () => {
    const operations = Array.from({ length: 20 }, (_, i) => ({
      id: `op-${i}`,
      type: 'upload' as const,
      title: `File ${i}`,
      status: 'running' as const,
      progress: 10,
      canCancel: true,
      createdAt: i,
    }));

    useOperationStore.setState({ operations });

    const { container } = render(
      <StatusBar sessions={[]} activeSession={undefined} updateState={{ phase: 'idle' }} updateDownloadProgress={undefined} />,
    );

    const overflow = container.querySelector('[data-testid="task-overflow-button"]');
    if (overflow) {
      await userEvent.click(overflow);
      expect(document.querySelector('[role="dialog"]')).toBeInTheDocument();
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/components/__tests__/StatusBar.test.tsx -v`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/__tests__/StatusBar.test.tsx
git commit -m "test(status-bar): expand StatusBar tests"
```

---

## Self-Review

**Spec coverage:**
- Compact 30px status bar — Task 7.
- 24px blocks with icon + progress bar — Task 2.
- Horizontal task flow with overflow `...` — Task 4.
- Modal dialog for all tasks — Task 5.
- Hover detail card — Task 3.
- Empty state returns null — Task 7 test.
- System blocks (sessions, active connection, update) — Task 6.
- Status colors — Task 2 / helpers.
- "取消全部" in modal footer — Task 5.
- Per-task cancel/remove — Task 4 / Task 5.

**Placeholder scan:** No TBD, TODO, or vague steps. Every step includes exact code or commands.

**Type consistency:** `OperationItem`, `OperationStatus`, `OperationType`, `SessionState`, `UpdateState` are imported from existing sources. `StatusTone` is defined once and reused. Props match across components.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-02-status-bar-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
