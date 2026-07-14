import React from 'react';
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { FileEntry } from './file-entry-formatters';

export interface SftpDndPayload {
  side: 'local' | 'remote';
  entries: FileEntry[];
}

export interface SftpDndContextProps {
  children: React.ReactNode;
  onDragEnd: (source: SftpDndPayload, targetSide: 'local' | 'remote') => void;
}

export const SftpDndContext: React.FC<SftpDndContextProps> = ({
  children,
  onDragEnd,
}) => {
  const [activePayload, setActivePayload] = React.useState<
    SftpDndPayload | undefined
  >();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const handleDragStart = (event: DragStartEvent): void => {
    const payload = event.active.data.current as SftpDndPayload | undefined;
    setActivePayload(payload);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    setActivePayload(undefined);
    const payload = event.active.data.current as SftpDndPayload | undefined;
    const targetSide = (event.over?.data.current as { side: 'local' | 'remote' } | undefined)?.side;
    if (payload && targetSide && payload.side !== targetSide) {
      onDragEnd(payload, targetSide);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activePayload ? (
          <div className="rounded-[4px] bg-app-primary px-2 py-1 text-xs text-app-primary-text shadow">
            {activePayload.entries.length} item
            {activePayload.entries.length > 1 ? 's' : ''}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
