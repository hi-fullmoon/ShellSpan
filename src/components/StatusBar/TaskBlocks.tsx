import { useEffect, useRef, useState } from 'react';
import { DotsIcon } from '../Icons';
import type { OperationItem } from '../../stores/operationStore';

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
