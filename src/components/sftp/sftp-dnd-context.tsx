import React from 'react';
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type Modifier,
  PointerSensor,
  useDndContext,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import { FileIcon, FolderIcon, LinkIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { FileEntry } from './utils';

export interface SftpDndPayload {
  side: 'local' | 'remote';
  entries: FileEntry[];
}

export interface SftpDndContextProps {
  children: React.ReactNode;
  onDragEnd: (source: SftpDndPayload, targetSide: 'local' | 'remote') => void;
}

const DRAG_PREVIEW_CURSOR_OFFSET = 12;

const offsetDragPreviewFromCursor: Modifier = ({
  activatorEvent,
  activeNodeRect,
  transform,
}) => {
  const pointer = activatorEvent
    ? getEventCoordinates(activatorEvent)
    : null;

  if (!pointer || !activeNodeRect) return transform;

  return {
    ...transform,
    x:
      transform.x +
      pointer.x -
      activeNodeRect.left +
      DRAG_PREVIEW_CURSOR_OFFSET,
    y:
      transform.y +
      pointer.y -
      activeNodeRect.top +
      DRAG_PREVIEW_CURSOR_OFFSET,
  };
};

const dragPreviewModifiers = [offsetDragPreviewFromCursor];

const SftpDragPreview: React.FC<{
  payload: SftpDndPayload;
  visible: boolean;
}> = ({ payload, visible }) => {
  const entry = payload.entries[0];
  if (!entry) return null;

  const Icon =
    entry.kind === 'directory'
      ? FolderIcon
      : entry.kind === 'symlink'
        ? LinkIcon
        : FileIcon;

  return (
    <div
      className={cn(
        'relative flex size-24 cursor-grabbing flex-col items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface p-2 text-app-text shadow-[var(--shadow-dialog)]',
        !visible && 'invisible',
      )}
    >
      {payload.entries.length > 1 && (
        <Badge className="absolute right-1.5 top-1.5 px-1.5">
          {payload.entries.length}
        </Badge>
      )}
      <Icon
        aria-hidden="true"
        className={cn(
          'size-8 shrink-0',
          entry.kind === 'directory' || entry.kind === 'symlink'
            ? 'text-app-primary'
            : 'text-app-text-soft',
        )}
      />
      <span className="w-full truncate text-center text-xs font-medium">
        {entry.name}
      </span>
    </div>
  );
};

const SftpDragOverlay: React.FC = () => {
  const { active } = useDndContext();
  const payload = active?.data.current as SftpDndPayload | undefined;
  const [measuredActiveId, setMeasuredActiveId] = React.useState<
    string | number | null
  >(null);

  React.useEffect(() => {
    if (!active) {
      setMeasuredActiveId(null);
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      setMeasuredActiveId(active.id);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [active]);

  return (
    <DragOverlay dropAnimation={null} modifiers={dragPreviewModifiers}>
      {payload ? (
        <SftpDragPreview
          payload={payload}
          visible={measuredActiveId === active?.id}
        />
      ) : null}
    </DragOverlay>
  );
};

export const SftpDndContext: React.FC<SftpDndContextProps> = ({
  children,
  onDragEnd,
}) => {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const payload = event.active.data.current as SftpDndPayload | undefined;
    const targetSide = (event.over?.data.current as { side: 'local' | 'remote' } | undefined)?.side;
    if (payload && targetSide && payload.side !== targetSide) {
      onDragEnd(payload, targetSide);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      onDragEnd={handleDragEnd}
    >
      {children}
      <SftpDragOverlay />
    </DndContext>
  );
};
