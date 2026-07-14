import React, { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';

interface SftpTabBarProps {
  onNewTabClick?: () => void;
  onTabContextMenu?: (connection: SftpConnection, x: number, y: number) => void;
}

const PlusIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const PinIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
  </svg>
);

interface ConnectionTabProps {
  connection: SftpConnection;
  active: boolean;
  dragging?: boolean;
  renaming?: boolean;
  renameValue?: string;
  showDropIndicatorLeft?: boolean;
  showDropIndicatorRight?: boolean;
  onActivate: (id: string) => void;
  onContextMenu: (connection: SftpConnection, x: number, y: number) => void;
  onClose: (id: string) => void;
  onTogglePin?: (id: string) => void;
  onRenameStart?: (connection: SftpConnection) => void;
  onRenameChange?: (value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
}

const ConnectionTab: React.FC<ConnectionTabProps> = ({
  connection,
  active,
  dragging = false,
  renaming = false,
  renameValue = '',
  showDropIndicatorLeft = false,
  showDropIndicatorRight = false,
  onActivate,
  onContextMenu,
  onClose,
  onTogglePin,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}) => {
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      data-sftp-tab={connection.id}
      onClick={() => onActivate(connection.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(connection, e.clientX, e.clientY);
      }}
      onDoubleClick={() => onRenameStart?.(connection)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(connection.id);
        }
      }}
      className={cn(
        'group relative flex h-[36px] w-48 shrink-0 items-center gap-1.5 border-r border-app-border px-2 text-left text-xs transition-colors select-none',
        active ? 'bg-app-surface text-app-text' : 'bg-transparent text-app-text-soft hover:bg-app-surface/60 hover:text-app-text',
        renaming ? 'cursor-text' : dragging ? 'cursor-grabbing opacity-80 shadow-md' : 'cursor-pointer',
      )}
    >
      {showDropIndicatorLeft && (
        <div className="pointer-events-none absolute left-0 top-1/2 z-10 h-[24px] w-0.5 -translate-y-1/2 rounded-full bg-app-primary shadow-[0_0_4px_var(--color-app-primary)]" />
      )}
      {showDropIndicatorRight && (
        <div className="pointer-events-none absolute right-0 top-1/2 z-10 h-[24px] w-0.5 -translate-y-1/2 rounded-full bg-app-primary shadow-[0_0_4px_var(--color-app-primary)]" />
      )}
      {active && (
        <div
          data-testid="tab-active-indicator"
          className="absolute bottom-0 left-0 right-0 h-0.5 bg-app-primary"
        />
      )}
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1">
            <Input
              autoFocus
              value={renameValue}
              onChange={(e) => onRenameChange?.(e.target.value)}
              onBlur={onRenameCommit}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  onRenameCommit?.();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  onRenameCancel?.();
                }
              }}
              className="h-5 border-0 bg-transparent px-1 py-0 text-xs font-medium shadow-none focus-visible:ring-0"
            />
          </span>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <strong className="block flex-1 truncate text-left text-xs font-medium" title={connection.title}>
              {connection.title}
            </strong>
          </div>
          {connection.pinned ? (
            <button
              type="button"
              aria-label="unpin"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin?.(connection.id);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-app-text-soft transition-all hover:bg-app-border hover:text-app-text"
            >
              <PinIcon />
            </button>
          ) : (
            <button
              type="button"
              aria-label="close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose(connection.id);
              }}
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded text-app-text-soft transition-all hover:bg-app-border hover:text-app-text',
                active ? 'flex' : 'hidden group-hover:flex',
              )}
            >
              ×
            </button>
          )}
        </>
      )}
    </div>
  );
};

interface SortableTabProps {
  connection: SftpConnection;
  active: boolean;
  onActivate: (id: string) => void;
  onContextMenu: (connection: SftpConnection, x: number, y: number) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  renaming: boolean;
  renameValue: string;
  onRenameStart: (connection: SftpConnection) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  showDropIndicatorLeft?: boolean;
  showDropIndicatorRight?: boolean;
}

const SortableTab: React.FC<SortableTabProps> = ({
  connection,
  active,
  onActivate,
  onContextMenu,
  onClose,
  onTogglePin,
  renaming,
  renameValue,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  showDropIndicatorLeft,
  showDropIndicatorRight,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: connection.id,
      disabled: renaming || connection.pinned,
    });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 20 : undefined,
      }}
    >
      <ConnectionTab
        connection={connection}
        active={active}
        dragging={isDragging}
        renaming={renaming}
        renameValue={renameValue}
        showDropIndicatorLeft={showDropIndicatorLeft}
        showDropIndicatorRight={showDropIndicatorRight}
        onActivate={onActivate}
        onContextMenu={onContextMenu}
        onClose={onClose}
        onTogglePin={onTogglePin}
        onRenameStart={onRenameStart}
        onRenameChange={onRenameChange}
        onRenameCommit={onRenameCommit}
        onRenameCancel={onRenameCancel}
      />
    </div>
  );
};

export const SftpTabBar: React.FC<SftpTabBarProps> = ({
  onNewTabClick,
  onTabContextMenu,
}) => {
  const { t } = useI18n();
  const connections = useSftpStore((state) => state.connections);
  const activeConnectionId = useSftpStore((state) => state.activeConnectionId);
  const setActiveConnection = useSftpStore((state) => state.setActiveConnection);
  const removeConnection = useSftpStore((state) => state.removeConnection);
  const reorderConnections = useSftpStore((state) => state.reorderConnections);
  const updateTitle = useSftpStore((state) => state.updateTitle);
  const togglePin = useSftpStore((state) => state.togglePin);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [draggingConnectionId, setDraggingConnectionId] = useState<string | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [renamingConnectionId, setRenamingConnectionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeConnectionId) {
      return;
    }
    const target = container.querySelector<HTMLElement>(`[data-sftp-tab="${activeConnectionId}"]`);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeConnectionId, connections.length]);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const hasHorizontalOverflow = container.scrollWidth > container.clientWidth + 4;
    if (!hasHorizontalOverflow || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    container.scrollBy({ left: event.deltaY, behavior: 'auto' });
    event.preventDefault();
  };

  const finishDrag = (): void => {
    setDraggingConnectionId(null);
    setInsertIndex(null);
  };

  const handleDragStart = (event: DragStartEvent): void => {
    if (renamingConnectionId) {
      return;
    }
    const nextId = String(event.active.id);
    setDraggingConnectionId(nextId);

    const container = scrollRef.current;
    if (container) {
      const tab = container.querySelector<HTMLElement>(`[data-sftp-tab="${nextId}"]`);
      if (tab) {
        const rect = tab.getBoundingClientRect();
        dragStartPosRef.current = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
    }
  };

  const handleDragMove = (event: DragMoveEvent): void => {
    if (!draggingConnectionId) {
      return;
    }

    const currentX = dragStartPosRef.current.x + event.delta.x;
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[data-sftp-tab]'));
    const visibleTabs = tabs.filter((tab) => tab.dataset.sftpTab !== draggingConnectionId);

    let newInsertIndex = 0;
    for (let i = 0; i < visibleTabs.length; i++) {
      const rect = visibleTabs[i].getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      if (currentX > centerX) {
        newInsertIndex = i + 1;
      }
    }

    const lastVisibleTab = visibleTabs[visibleTabs.length - 1];
    if (lastVisibleTab) {
      const lastRect = lastVisibleTab.getBoundingClientRect();
      if (currentX > lastRect.right) {
        newInsertIndex = visibleTabs.length;
      }
    }

    const draggedConnection = connections.find((c) => c.id === draggingConnectionId);
    const pinnedCount = connections.filter((c) => c.pinned).length;
    const minInsertIndex = draggedConnection?.pinned ? 0 : pinnedCount;
    setInsertIndex(Math.max(minInsertIndex, newInsertIndex));
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const activeId = String(event.active.id);
    if (insertIndex !== null) {
      reorderConnections(activeId, insertIndex);
    }
    finishDrag();
  };

  const handleDragCancel = (): void => {
    finishDrag();
  };

  const handleRenameStart = (connection: SftpConnection): void => {
    setRenamingConnectionId(connection.id);
    setRenameValue(connection.title);
  };

  const handleRenameCommit = (): void => {
    if (renamingConnectionId && renameValue.trim()) {
      updateTitle(renamingConnectionId, renameValue.trim());
    }
    setRenamingConnectionId(null);
    setRenameValue('');
  };

  const handleRenameCancel = (): void => {
    setRenamingConnectionId(null);
    setRenameValue('');
  };

  const draggingConnection = draggingConnectionId
    ? (connections.find((c) => c.id === draggingConnectionId) ?? null)
    : null;

  const visibleTabCount = connections.length - (draggingConnectionId ? 1 : 0);

  if (connections.length === 0) {
    return null;
  }

  return (
    <div className="flex h-9 items-center gap-0 border-b border-app-border bg-app-surface-muted px-0">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={connections.map((c) => c.id)} strategy={() => null}>
          <div
            ref={scrollRef}
            onWheel={handleWheel}
            className="flex h-[36px] min-w-0 items-center gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {connections.map((connection, index) => {
              const isDragging = draggingConnectionId === connection.id;
              const draggedIndex = draggingConnectionId
                ? connections.findIndex((c) => c.id === draggingConnectionId)
                : -1;
              const visibleIndex = isDragging
                ? -1
                : index - (draggedIndex >= 0 && draggedIndex < index ? 1 : 0);
              const isLastVisible = visibleIndex === visibleTabCount - 1;

              return (
                <SortableTab
                  key={connection.id}
                  connection={connection}
                  active={activeConnectionId === connection.id}
                  onActivate={setActiveConnection}
                  onContextMenu={(conn, x, y) => onTabContextMenu?.(conn, x, y)}
                  onClose={removeConnection}
                  onTogglePin={togglePin}
                  renaming={renamingConnectionId === connection.id}
                  renameValue={renameValue}
                  onRenameStart={handleRenameStart}
                  onRenameChange={setRenameValue}
                  onRenameCommit={handleRenameCommit}
                  onRenameCancel={handleRenameCancel}
                  showDropIndicatorLeft={insertIndex !== null && visibleIndex >= 0 && insertIndex === visibleIndex}
                  showDropIndicatorRight={insertIndex !== null && isLastVisible && insertIndex === visibleTabCount}
                />
              );
            })}
          </div>
        </SortableContext>
        {typeof document === 'undefined'
          ? null
          : createPortal(
              <DragOverlay dropAnimation={null}>
                {draggingConnection && (
                  <ConnectionTab
                    connection={draggingConnection}
                    active={activeConnectionId === draggingConnection.id}
                    dragging
                    onActivate={() => {}}
                    onContextMenu={() => {}}
                    onClose={() => {}}
                    onTogglePin={() => {}}
                  />
                )}
              </DragOverlay>,
              document.body,
            )}
      </DndContext>
      {connections.length > 0 && onNewTabClick && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onNewTabClick}
          title={t('sftp.newTab')}
          className="h-[36px] w-8 shrink-0 rounded-none hover:bg-app-surface hover:text-app-primary"
        >
          <PlusIcon />
        </Button>
      )}
    </div>
  );
};
