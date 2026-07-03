import { useEffect, useRef, useState } from 'react';
import type { OperationItem } from '../../stores/operationStore';
import { t } from '../../lib/i18n';
import { DotsIcon } from '../ui';
import { TaskRow } from './TaskRow';

const ROW_HEIGHT = 36;
const ROW_GAP = 4;
const OVERFLOW_HEIGHT = 24;

interface TaskBlocksProps {
  operations: OperationItem[];
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenDialog: () => void;
}

function computeVisibleCount(total: number, containerHeight: number): number {
  if (containerHeight <= 0) {
    return total;
  }

  for (let count = total; count >= 0; count -= 1) {
    const hidden = total - count;
    let height = count * ROW_HEIGHT + Math.max(0, count - 1) * ROW_GAP;
    if (hidden > 0) {
      height += ROW_GAP + OVERFLOW_HEIGHT;
    }

    if (height <= containerHeight) {
      return count;
    }
  }

  return 0;
}

export function TaskBlocks({ operations, onCancel, onRemove, onOpenDialog }: TaskBlocksProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const operationsRef = useRef(operations);
  const [visibleCount, setVisibleCount] = useState<number>(operations.length);

  operationsRef.current = operations;

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === 'undefined') {
      setVisibleCount(operationsRef.current.length);
      return;
    }

    const element = containerRef.current;

    const updateVisibleCount = () => {
      const height = element.clientHeight;
      if (height === 0) {
        setVisibleCount(operationsRef.current.length);
        return;
      }

      setVisibleCount(computeVisibleCount(operationsRef.current.length, height));
    };

    updateVisibleCount();

    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(element);

    return () => observer.disconnect();
  }, [operations.length]);

  const visible = operations.slice(0, visibleCount);
  const hidden = operations.slice(visibleCount);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col justify-start gap-1 overflow-hidden">
      {visible.map((operation) => (
        <TaskRow
          key={operation.id}
          operation={operation}
          onCancel={() => onCancel(operation.id)}
          onRemove={() => onRemove(operation.id)}
        />
      ))}
      {hidden.length > 0 ? (
        <button
          className="icon-btn flex h-6 shrink-0 items-center justify-center gap-1 px-1.5 text-[11px]"
          onClick={onOpenDialog}
          type="button"
          title={t('statusBar.overflow.more', { count: hidden.length })}
          data-testid="task-overflow-button"
        >
          <DotsIcon />
          <span>{hidden.length}</span>
        </button>
      ) : null}
    </div>
  );
}
