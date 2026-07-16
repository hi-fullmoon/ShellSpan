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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PlusIcon, PinIcon, XIcon } from 'lucide-react';
import { invokeCloseSession } from '@/lib/tauri';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { SessionStatus } from '@/types';

export interface TerminalTabBarProps {
  onNewTabClick?: () => void;
  onTabContextMenu?: (session: TerminalSession, x: number, y: number) => void;
}

const sessionStatusDotClass = (status: SessionStatus): string => {
  switch (status) {
    case 'connected':
      return 'bg-app-success';
    case 'connecting':
      return 'bg-app-warning';
    case 'error':
      return 'bg-app-error';
    case 'disconnected':
    default:
      return 'bg-app-text-soft';
  }
};

// Icons replaced with lucide-react imports

interface SessionTabProps {
  session: TerminalSession;
  active: boolean;
  dragging?: boolean;
  renaming?: boolean;
  renameValue?: string;
  showDropIndicatorLeft?: boolean;
  showDropIndicatorRight?: boolean;
  onActivate: (sessionId: string) => void;
  onContextMenu: (session: TerminalSession, x: number, y: number) => void;
  onClose: (sessionId: string) => void;
  onTogglePin?: (sessionId: string) => void;
  onRenameStart?: (session: TerminalSession) => void;
  onRenameChange?: (value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
}

const SessionTab: React.FC<SessionTabProps> = ({
  session,
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
      data-session-tab={session.sessionId}
      onClick={() => onActivate(session.sessionId)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(session, e.clientX, e.clientY);
      }}
      onDoubleClick={() => onRenameStart?.(session)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(session.sessionId);
        }
      }}
      className={cn(
        'group relative flex h-9 w-48 shrink-0 items-center gap-1.5 px-2 text-left text-xs font-medium transition-colors select-none',
        active ? 'bg-app-surface text-app-text shadow-sm' : 'text-app-text-soft hover:bg-app-surface-muted hover:text-app-text',
        renaming ? 'cursor-text' : dragging ? 'cursor-grabbing opacity-80' : 'cursor-pointer',
      )}
      style={
        session.color
          ? { backgroundColor: `color-mix(in srgb, ${session.color} ${active ? 15 : 8}%, transparent)` }
          : undefined
      }
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
          style={session.color ? { backgroundColor: session.color } : undefined}
        />
      )}
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className={cn('h-2 w-2 shrink-0 rounded-sm', sessionStatusDotClass(session.status))} />
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
            <span className={cn('h-2 w-2 shrink-0 rounded-sm', sessionStatusDotClass(session.status))} />
            <strong className="block flex-1 truncate text-left text-xs font-medium leading-none">
              {session.title}
            </strong>
          </div>
          {session.pinned ? (
            <button
              type="button"
              aria-label="unpin"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin?.(session.sessionId);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-app-text-soft transition-all hover:bg-app-border hover:text-app-text"
            >
              <PinIcon className="size-3" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose(session.sessionId);
              }}
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded text-app-text-soft transition-all hover:bg-app-border hover:text-app-text',
                active ? 'flex' : 'hidden group-hover:flex',
              )}
            >
              <XIcon className="h-3 w-3" />
            </button>
          )}
        </>
      )}
    </div>
  );
};

interface SortableTabProps {
  session: TerminalSession;
  active: boolean;
  onActivate: (sessionId: string) => void;
  onContextMenu: (session: TerminalSession, x: number, y: number) => void;
  onClose: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
  renaming: boolean;
  renameValue: string;
  onRenameStart: (session: TerminalSession) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  showDropIndicatorLeft?: boolean;
  showDropIndicatorRight?: boolean;
}

const SortableTab: React.FC<SortableTabProps> = ({
  session,
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.sessionId,
    disabled: renaming || session.pinned,
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
      <SessionTab
        session={session}
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

export const TerminalTabBar: React.FC<TerminalTabBarProps> = ({ onNewTabClick, onTabContextMenu }) => {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const setActiveSession = useTerminalStore((state) => state.setActiveSession);
  const removeSession = useTerminalStore((state) => state.removeSession);
  const reorderSessions = useTerminalStore((state) => state.reorderSessions);
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const togglePin = useTerminalStore((state) => state.togglePin);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeSessionId) {
      return;
    }
    const target = container.querySelector<HTMLElement>(`[data-session-tab="${activeSessionId}"]`);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeSessionId, sessions.length]);

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

  const handleCloseSession = (sessionId: string): void => {
    removeSession(sessionId);
    invokeCloseSession(sessionId).catch(() => {});
  };

  const finishDrag = (): void => {
    setDraggingSessionId(null);
    setInsertIndex(null);
  };

  const handleDragStart = (event: DragStartEvent): void => {
    if (renamingSessionId) {
      return;
    }
    const nextId = String(event.active.id);
    setDraggingSessionId(nextId);

    const container = scrollRef.current;
    if (container) {
      const tab = container.querySelector<HTMLElement>(`[data-session-tab="${nextId}"]`);
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
    if (!draggingSessionId) {
      return;
    }

    const currentX = dragStartPosRef.current.x + event.delta.x;
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[data-session-tab]'));
    const visibleTabs = tabs.filter((tab) => tab.dataset.sessionTab !== draggingSessionId);

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

    const draggedSession = sessions.find((s) => s.sessionId === draggingSessionId);
    const pinnedCount = sessions.filter((s) => s.pinned).length;
    const minInsertIndex = draggedSession?.pinned ? 0 : pinnedCount;
    setInsertIndex(Math.max(minInsertIndex, newInsertIndex));
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const activeId = String(event.active.id);
    if (insertIndex !== null) {
      reorderSessions(activeId, insertIndex);
    }
    finishDrag();
  };

  const handleDragCancel = (): void => {
    finishDrag();
  };

  const handleRenameStart = (session: TerminalSession): void => {
    setRenamingSessionId(session.sessionId);
    setRenameValue(session.title);
  };

  const handleRenameCommit = (): void => {
    if (renamingSessionId && renameValue.trim()) {
      updateTitle(renamingSessionId, renameValue.trim());
    }
    setRenamingSessionId(null);
    setRenameValue('');
  };

  const handleRenameCancel = (): void => {
    setRenamingSessionId(null);
    setRenameValue('');
  };

  const draggingSession = draggingSessionId ? (sessions.find((s) => s.sessionId === draggingSessionId) ?? null) : null;

  const visibleTabCount = sessions.length - (draggingSessionId ? 1 : 0);

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
        <SortableContext items={sessions.map((s) => s.sessionId)} strategy={() => null}>
          <div
            ref={scrollRef}
            onWheel={handleWheel}
            className="flex h-[36px] min-w-0 items-center gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {sessions.map((session, index) => {
              const isDragging = draggingSessionId === session.sessionId;
              const draggedIndex = draggingSessionId ? sessions.findIndex((s) => s.sessionId === draggingSessionId) : -1;
              const visibleIndex = isDragging ? -1 : index - (draggedIndex >= 0 && draggedIndex < index ? 1 : 0);
              const isLastVisible = visibleIndex === visibleTabCount - 1;

              return (
                <SortableTab
                  key={session.sessionId}
                  session={session}
                  active={activeSessionId === session.sessionId}
                  onActivate={setActiveSession}
                  onContextMenu={(s, x, y) => onTabContextMenu?.(s, x, y)}
                  onClose={handleCloseSession}
                  onTogglePin={togglePin}
                  renaming={renamingSessionId === session.sessionId}
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
                {draggingSession && (
                  <SessionTab
                    session={draggingSession}
                    active={activeSessionId === draggingSession.sessionId}
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
      {sessions.length > 0 && onNewTabClick && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onNewTabClick}
          aria-label={t('terminal.newTab')}
          className="h-[36px] w-8 shrink-0 rounded-none hover:bg-app-surface hover:text-app-primary"
        >
          <PlusIcon />
        </Button>
      )}
    </div>
  );
};
