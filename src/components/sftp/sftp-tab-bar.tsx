import React, { useEffect, useRef, useState } from 'react';
import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Modifier,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import { PlusIcon, PinIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface SftpTabBarProps {
  onNewTabClick?: () => void;
  onTabContextMenu?: (connection: SftpConnection, x: number, y: number) => void;
}

interface ConnectionTabProps {
  connection: SftpConnection;
  active: boolean;
  dragging?: boolean;
  renaming?: boolean;
  renameValue?: string;
  showDropIndicatorLeft?: boolean;
  showDropIndicatorRight?: boolean;
  showSeparatorAfter?: boolean;
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
  showSeparatorAfter = false,
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
        if (
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
          e.target === e.currentTarget
        ) {
          e.preventDefault();
          const tabs = Array.from(
            e.currentTarget
              .closest('[role="tablist"]')
              ?.querySelectorAll<HTMLElement>('[data-sftp-tab]') ?? [],
          );
          const index = tabs.indexOf(e.currentTarget);
          const next = tabs[e.key === 'ArrowLeft' ? index - 1 : index + 1];
          next?.focus();
        }
      }}
      className={cn(
        'group relative flex w-48 shrink-0 items-center gap-1.5 px-2 text-left text-xs transition-colors select-none',
        active ? 'h-[31px] bg-app-surface text-app-text' : 'h-[31px] bg-app-border/25 text-app-text-soft',
        renaming ? 'cursor-text' : dragging ? 'cursor-default opacity-80 shadow-md' : 'cursor-pointer',
      )}
    >
      {active && (
        <div
          aria-hidden="true"
          data-active-tab-indicator
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-app-primary"
        />
      )}
      {showSeparatorAfter && (
        <Separator
          orientation="vertical"
          aria-hidden="true"
          data-tab-separator
          className="pointer-events-none absolute right-0 top-1/2 h-5 -translate-y-1/2 bg-app-border"
        />
      )}
      {showDropIndicatorLeft && (
        <div className="pointer-events-none absolute left-0 top-1/2 z-10 h-[20px] w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-app-primary" />
      )}
      {showDropIndicatorRight && (
        <div className="pointer-events-none absolute right-0 top-1/2 z-10 h-[20px] w-0.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-app-primary" />
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
              className="h-5 border-0 bg-transparent p-0 text-xs font-medium leading-none shadow-none focus-visible:ring-0"
            />
          </span>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className={cn('block flex-1 truncate text-left text-xs leading-none font-medium')}>{connection.title}</span>
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
              <PinIcon className="size-3" strokeWidth={1.5} />
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
                !dragging && active ? 'flex' : 'hidden group-hover:flex',
              )}
            >
              <XIcon className="h-3 w-3" strokeWidth={1.5} />
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
  showSeparatorAfter?: boolean;
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
  showSeparatorAfter,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
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
        showSeparatorAfter={showSeparatorAfter}
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

export const SftpTabBar: React.FC<SftpTabBarProps> = ({ onNewTabClick, onTabContextMenu }) => {
  const { t } = useI18n();
  const sftpHideSingleTabBar = useAppStore((state) => state.sftpHideSingleTabBar);
  const connections = useSftpStore((state) => state.connections);
  const activeConnectionId = useSftpStore((state) => state.activeConnectionId);
  const setActiveConnection = useSftpStore((state) => state.setActiveConnection);
  const removeConnection = useSftpStore((state) => state.removeConnection);
  const reorderConnections = useSftpStore((state) => state.reorderConnections);
  const updateTitle = useSftpStore((state) => state.updateTitle);
  const togglePin = useSftpStore((state) => state.togglePin);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragPointerStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragOverlayOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragStartScrollLeftRef = useRef(0);

  const [draggingConnectionId, setDraggingConnectionId] = useState<string | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [renamingConnectionId, setRenamingConnectionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [closingConnectionId, setClosingConnectionId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const snapOverlayTopLeftToCursor = React.useCallback<Modifier>(({ transform }) => {
    const offset = dragOverlayOffsetRef.current;
    return {
      ...transform,
      x: transform.x + offset.x,
      y: transform.y + offset.y,
    };
  }, []);

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

  // React attaches root-level wheel listeners as passive, so preventDefault
  // inside an onWheel prop is ignored. Bind a non-passive native listener on
  // the scroll viewport instead.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const handleWheel = (event: WheelEvent): void => {
      const hasHorizontalOverflow = container.scrollWidth > container.clientWidth + 4;
      if (!hasHorizontalOverflow || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }
      container.scrollBy({ left: event.deltaY, behavior: 'auto' });
      event.preventDefault();
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [connections.length]);

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
    const activatorEvent = event.activatorEvent as PointerEvent;
    dragPointerStartRef.current = {
      x: activatorEvent.clientX ?? 0,
      y: activatorEvent.clientY ?? 0,
    };

    const container = scrollRef.current;
    if (container) {
      dragStartScrollLeftRef.current = container.scrollLeft;
      const tab = container.querySelector<HTMLElement>(`[data-sftp-tab="${nextId}"]`);
      if (tab) {
        const rect = tab.getBoundingClientRect();
        dragStartPosRef.current = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
        dragOverlayOffsetRef.current = {
          x: dragPointerStartRef.current.x - rect.left,
          y: dragPointerStartRef.current.y - rect.top,
        };
      }
    }
  };

  const handleDragMove = (event: DragMoveEvent): void => {
    if (!draggingConnectionId) {
      return;
    }

    const container = scrollRef.current;
    if (!container) {
      return;
    }
    // dnd-kit's event.delta is scroll-adjusted: it includes the tab bar's
    // scrollLeft change since drag start. Tab rects read below live in screen
    // space, so subtract that scroll delta to compare in the same space —
    // otherwise the insert indicator drifts while the bar scrolls mid-drag.
    const scrollDeltaX = container.scrollLeft - dragStartScrollLeftRef.current;
    const currentX = dragStartPosRef.current.x + event.delta.x - scrollDeltaX;

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
    // A pinned tab must stay inside the pinned region; a regular tab must not
    // move ahead of it. Clamp on the component side too instead of relying on
    // the store to defend the bounds.
    const maxInsertIndex = draggedConnection?.pinned
      ? Math.max(minInsertIndex, pinnedCount - 1)
      : visibleTabs.length;
    setInsertIndex(Math.min(maxInsertIndex, Math.max(minInsertIndex, newInsertIndex)));
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const activeId = String(event.active.id);
    if (insertIndex !== null) {
      const dragged = connections.find((c) => c.id === activeId);
      const pinnedCount = connections.filter((c) => c.pinned).length;
      const minIndex = dragged?.pinned ? 0 : pinnedCount;
      const maxIndex = dragged?.pinned
        ? Math.max(minIndex, pinnedCount - 1)
        : connections.length - 1;
      reorderConnections(activeId, Math.min(maxIndex, Math.max(minIndex, insertIndex)));
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

  const handleCloseConnection = (id: string): void => {
    setClosingConnectionId(id);
  };

  const confirmCloseConnection = (): void => {
    if (closingConnectionId) {
      removeConnection(closingConnectionId);
    }
    setClosingConnectionId(null);
  };

  const draggingConnection = draggingConnectionId ? (connections.find((c) => c.id === draggingConnectionId) ?? null) : null;

  const closingConnection = closingConnectionId ? (connections.find((c) => c.id === closingConnectionId) ?? null) : null;

  const visibleTabCount = connections.length - (draggingConnectionId ? 1 : 0);
  const visibleConnections = draggingConnectionId ? connections.filter((connection) => connection.id !== draggingConnectionId) : connections;

  // Dropping back into the dragged tab's own slot is a no-op, so suppress the
  // indicator that would otherwise sit between the dragged tab and its right
  // neighbor.
  const draggedOriginalIndex = draggingConnectionId
    ? connections.findIndex((c) => c.id === draggingConnectionId)
    : -1;
  const effectiveInsertIndex = insertIndex !== null && insertIndex === draggedOriginalIndex
    ? null
    : insertIndex;

  if (connections.length === 0) {
    return null;
  }

  if (connections.length === 1 && sftpHideSingleTabBar) {
    return null;
  }

  return (
    <div className="group/tabbar relative flex h-8 items-start gap-0 border-b border-app-border/50 bg-app-surface-muted px-0">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={connections.map((c) => c.id)} strategy={() => null}>
          <ScrollArea
            viewportRef={scrollRef}
            horizontal
            vertical={false}
            size="thin"
            className="h-[31px] min-w-0 flex-1"
          >
            <div role="tablist" className="flex min-w-0 items-start gap-0">
              {connections.map((connection, index) => {
              const isDragging = draggingConnectionId === connection.id;
              const draggedIndex = draggingConnectionId ? connections.findIndex((c) => c.id === draggingConnectionId) : -1;
              const visibleIndex = isDragging ? -1 : index - (draggedIndex >= 0 && draggedIndex < index ? 1 : 0);
              const isLastVisible = visibleIndex === visibleTabCount - 1;
              const isActive = activeConnectionId === connection.id;
              const nextVisibleConnection = visibleIndex >= 0 ? visibleConnections[visibleIndex + 1] : undefined;
              const showSeparatorAfter = !isActive && !!nextVisibleConnection && nextVisibleConnection.id !== activeConnectionId;

              return (
                <SortableTab
                  key={connection.id}
                  connection={connection}
                  active={isActive}
                  onActivate={setActiveConnection}
                  onContextMenu={(conn, x, y) => onTabContextMenu?.(conn, x, y)}
                  onClose={handleCloseConnection}
                  onTogglePin={togglePin}
                  renaming={renamingConnectionId === connection.id}
                  renameValue={renameValue}
                  onRenameStart={handleRenameStart}
                  onRenameChange={setRenameValue}
                  onRenameCommit={handleRenameCommit}
                  onRenameCancel={handleRenameCancel}
                  showDropIndicatorLeft={effectiveInsertIndex !== null && visibleIndex >= 0 && effectiveInsertIndex === visibleIndex}
                  showDropIndicatorRight={effectiveInsertIndex !== null && isLastVisible && effectiveInsertIndex === visibleTabCount}
                  showSeparatorAfter={showSeparatorAfter}
                />
              );
            })}
            </div>
          </ScrollArea>
        </SortableContext>
        {typeof document === 'undefined'
          ? null
          : createPortal(
              <DragOverlay dropAnimation={null} modifiers={[snapOverlayTopLeftToCursor]}>
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
        // Overlays the tab strip instead of taking layout space, so scrollable
        // tabs never leave an empty block at the right edge. The gradient keeps
        // the icon readable over the last tab; pointer events pass through
        // while hidden.
        <Button
          variant="ghost"
          size="icon"
          onClick={onNewTabClick}
          aria-label={t('sftp.newTab')}
          className="pointer-events-none absolute inset-y-0 right-0 z-10 h-[31px] w-11 rounded-none bg-gradient-to-l from-app-surface-muted from-60% to-transparent pl-4 opacity-0 transition-opacity hover:bg-transparent hover:text-app-primary focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/tabbar:pointer-events-auto group-hover/tabbar:opacity-100"
        >
          <PlusIcon strokeWidth={1.5} />
        </Button>
      )}
      <AlertDialog
        open={!!closingConnectionId}
        onOpenChange={(open) => {
          if (!open) setClosingConnectionId(null);
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
            <AlertDialogTitle className="text-sm leading-5">{t('sftp.tab.closeConfirmTitle')}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {closingConnection ? t('sftp.tab.closeConfirmMessage', { title: closingConnection.title }) : ''}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
            <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={confirmCloseConnection}>
              {t('common.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
