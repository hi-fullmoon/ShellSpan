import { useEffect, useRef, useState } from 'react';
import { DotsIcon } from '../Icons';
import type { OperationItem } from '../../stores/operationStore';
import { t } from '../../lib/i18n';

import { StatusBlock } from './StatusBlock';
import { StatusBlockTooltip } from './StatusBlockTooltip';
import { operationIcon, operationStatusText, operationTone, operationTypeLabel } from './statusHelpers';
import { useDelayedHover } from './useDelayedHover';

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
  }, [operations]);

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
          className="icon-btn flex h-6 w-6 shrink-0 items-center justify-center p-0 text-[9px] font-semibold"
          onClick={onOpenDialog}
          type="button"
          title={t('statusBar.overflow.more', { count: hidden.length })}
          data-testid="task-overflow-button"
        >
          {hidden.length}
        </button>
      ) : null}
    </div>
  );
}

function TaskBlock({ operation, onCancel, onRemove }: { operation: OperationItem; onCancel: () => void; onRemove: () => void }) {
  const blockRef = useRef<HTMLDivElement>(null);
  const { hovered, onMouseEnter, onMouseLeave } = useDelayedHover(200);
  const isRunning = operation.status === 'running';
  const isCancelling = operation.status === 'cancelling';

  const tooltipAction =
    (isRunning || isCancelling) && operation.canCancel
      ? {
          label: t('operationStatus.actions.cancel'),
          onClick: onCancel,
          disabled: isCancelling,
        }
      : {
          label: t('operationStatus.actions.remove'),
          onClick: onRemove,
        };

  return (
    <div ref={blockRef} className="relative" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <StatusBlock icon={operationIcon(operation.type)} progress={operation.progress} tone={operationTone(operation.status)} />
      <StatusBlockTooltip
        open={hovered}
        anchorRef={blockRef}
        data={{
          title: `${operationTypeLabel(operation.type)} · ${operation.title}`,
          subtitle: operationStatusText(operation.status),
          detail: operation.totalText ? `${operation.progress}% · ${operation.totalText}` : `${operation.progress}%`,
          errorMessage: operation.errorMessage,
          action: tooltipAction,
        }}
      />
    </div>
  );
}
