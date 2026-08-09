import React, { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlusIcon, PinIcon, XIcon } from 'lucide-react';
import { invokeCloseSession } from '@/lib/tauri';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
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
import type { SessionStatus } from '@/types';

export interface TerminalTabBarProps {
  sessions?: TerminalSession[];
  activeSessionId?: string | null;
  forceVisible?: boolean;
  activeGroup?: boolean;
  onNewTabClick?: () => void;
  onTabContextMenu?: (session: TerminalSession, x: number, y: number) => void;
  onTabActivate?: (sessionId: string) => void;
  onTabDragMove?: (sessionId: string, x: number, y: number) => void;
  onTabDragEnd?: (sessionId: string, x: number, y: number) => boolean;
  onTabDragCancel?: () => void;
  onTabReorder?: (sessionId: string, insertIndex: number) => void;
  externalInsertIndex?: number | null;
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
  showSeparatorAfter?: boolean;
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
        'group relative flex w-48 shrink-0 items-center gap-1.5 px-2 text-left text-xs transition-colors select-none',
        active ? 'h-[31px] bg-app-surface text-app-text' : 'h-[31px] bg-app-border/25 text-app-text-soft',
        renaming ? 'cursor-text' : dragging ? 'cursor-default opacity-80' : 'cursor-pointer',
      )}
      style={session.color ? { backgroundColor: `color-mix(in srgb, ${session.color} ${active ? 25 : 8}%, transparent)` } : undefined}
    >
      {active && (
        <div
          aria-hidden="true"
          data-active-tab-indicator
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-app-primary"
          style={session.color ? { backgroundColor: session.color } : undefined}
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
            <span className={cn('block flex-1 truncate text-left text-xs leading-none font-medium')}>{session.title}</span>
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
              <PinIcon className="size-3" strokeWidth={1.5} />
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
  showSeparatorAfter?: boolean;
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
  showSeparatorAfter,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.sessionId,
    disabled: renaming,
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

export const TerminalTabBar: React.FC<TerminalTabBarProps> = ({
  sessions: controlledSessions,
  activeSessionId: controlledActiveSessionId,
  forceVisible = false,
  activeGroup = true,
  onNewTabClick,
  onTabContextMenu,
  onTabActivate,
  onTabDragMove,
  onTabDragEnd,
  onTabDragCancel,
  onTabReorder,
  externalInsertIndex = null,
}) => {
  const { t } = useI18n();
  const terminalHideSingleTabBar = useAppStore((state) => state.terminalHideSingleTabBar);
  const storeSessions = useTerminalStore((state) => state.sessions);
  const storeActiveSessionId = useTerminalStore((state) => state.activeSessionId);
  const sessions = controlledSessions ?? storeSessions;
  const activeSessionId = controlledActiveSessionId === undefined
    ? storeActiveSessionId
    : controlledActiveSessionId;
  const setActiveSession = useTerminalStore((state) => state.setActiveSession);
  const removeSession = useTerminalStore((state) => state.removeSession);
  const reorderSessions = useTerminalStore((state) => state.reorderSessions);
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const togglePin = useTerminalStore((state) => state.togglePin);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const dragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragPointerStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragOverlayOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const keyboardDragRef = useRef(false);
  const autoScrollSpeedRef = useRef(0);
  const dragStartScrollLeftRef = useRef(0);

  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
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

  useEffect(() => {
    const handleCloseTabRequest = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      const requestedId = detail?.sessionId;
      if (requestedId && !sessions.some((session) => session.sessionId === requestedId)) return;
      if (!requestedId && !activeGroup) return;
      const closeId = requestedId ?? activeSessionId;
      if (closeId) setClosingSessionId(closeId);
    };
    document.addEventListener('termbridge:close-terminal-tab', handleCloseTabRequest);
    return () => document.removeEventListener('termbridge:close-terminal-tab', handleCloseTabRequest);
  }, [activeGroup, activeSessionId, sessions]);

  // Auto-scroll the overflowed tab bar while dragging near its edges. Runs on
  // an interval so holding the pointer still at the edge keeps scrolling.
  useEffect(() => {
    if (!draggingSessionId) return;
    const timer = window.setInterval(() => {
      const container = scrollRef.current;
      const speed = autoScrollSpeedRef.current;
      if (container && speed !== 0) {
        container.scrollLeft += speed;
      }
    }, 16);
    return () => window.clearInterval(timer);
  }, [draggingSessionId]);

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
    setClosingSessionId(sessionId);
  };

  const confirmCloseSession = (): void => {
    if (closingSessionId) {
      removeSession(closingSessionId);
      invokeCloseSession(closingSessionId).catch(() => {});
    }
    setClosingSessionId(null);
  };

  const finishDrag = (): void => {
    setDraggingSessionId(null);
    setInsertIndex(null);
    keyboardDragRef.current = false;
    autoScrollSpeedRef.current = 0;
  };

  const handleDragStart = (event: DragStartEvent): void => {
    if (renamingSessionId) {
      return;
    }
    const nextId = String(event.active.id);
    setDraggingSessionId(nextId);
    const isKeyboardDrag = typeof KeyboardEvent !== 'undefined'
      && event.activatorEvent instanceof KeyboardEvent;
    keyboardDragRef.current = isKeyboardDrag;
    const activatorEvent = event.activatorEvent as PointerEvent;
    dragPointerStartRef.current = {
      x: activatorEvent.clientX ?? 0,
      y: activatorEvent.clientY ?? 0,
    };

    const container = scrollRef.current;
    if (container) {
      dragStartScrollLeftRef.current = container.scrollLeft;
      const tab = container.querySelector<HTMLElement>(`[data-session-tab="${nextId}"]`);
      if (tab) {
        const rect = tab.getBoundingClientRect();
        dragStartPosRef.current = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
        // Keyboard drags have no pointer to follow; keep the overlay anchored
        // to the tab itself.
        dragOverlayOffsetRef.current = isKeyboardDrag
          ? { x: 0, y: 0 }
          : {
            x: dragPointerStartRef.current.x - rect.left,
            y: dragPointerStartRef.current.y - rect.top,
          };
      }
    }
  };

  const handleDragMove = (event: DragMoveEvent): void => {
    if (!draggingSessionId) {
      return;
    }

    const isKeyboardDrag = keyboardDragRef.current;
    const container = scrollRef.current;
    // dnd-kit's event.delta is scroll-adjusted: it includes the tab bar's
    // scrollLeft change since drag start. Tab rects read below live in screen
    // space, so subtract that scroll delta to compare in the same space —
    // otherwise the insert indicator drifts while the bar auto-scrolls.
    const scrollDeltaX = container ? container.scrollLeft - dragStartScrollLeftRef.current : 0;
    const currentX = dragStartPosRef.current.x + event.delta.x - scrollDeltaX;
    const pointerX = dragPointerStartRef.current.x + event.delta.x - scrollDeltaX;
    const pointerY = dragPointerStartRef.current.y + event.delta.y;

    if (isKeyboardDrag) {
      autoScrollSpeedRef.current = 0;
    } else {
      onTabDragMove?.(draggingSessionId, pointerX, pointerY);
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const edgeSize = 48;
        if (pointerX < containerRect.left + edgeSize) {
          autoScrollSpeedRef.current = -Math.max(2, Math.ceil((containerRect.left + edgeSize - pointerX) / 4));
        } else if (pointerX > containerRect.right - edgeSize) {
          autoScrollSpeedRef.current = Math.max(2, Math.ceil((pointerX - (containerRect.right - edgeSize)) / 4));
        } else {
          autoScrollSpeedRef.current = 0;
        }
      }
    }

    const tabBarRect = tabBarRef.current?.getBoundingClientRect();
    const tabs = container
      ? Array.from(container.querySelectorAll<HTMLElement>('[data-session-tab]'))
      : [];
    const tabRects = tabs.map((tab) => tab.getBoundingClientRect());
    const isInsideTabBar = isKeyboardDrag
      ? true
      : tabBarRect && tabBarRect.width > 0 && tabBarRect.height > 0
        ? pointerX >= tabBarRect.left
          && pointerX <= tabBarRect.right
          && pointerY >= tabBarRect.top
          && pointerY <= tabBarRect.bottom
        : tabRects.some((rect) => (
          pointerX >= rect.left
          && pointerX <= rect.right
          && pointerY >= rect.top
          && pointerY <= rect.bottom
        ));
    if (
      !container
      || !isInsideTabBar
    ) {
      setInsertIndex(null);
      return;
    }

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
    // Keyboard drags only reorder within this tab bar; pointer coordinates are
    // meaningless there, so split/cross-group handling is skipped.
    // Same scroll compensation as handleDragMove: drop coordinates must be in
    // screen space for split/cross-group hit-testing.
    const scrollDeltaX = (scrollRef.current?.scrollLeft ?? dragStartScrollLeftRef.current) - dragStartScrollLeftRef.current;
    const splitHandled = keyboardDragRef.current
      ? false
      : onTabDragEnd?.(
        activeId,
        dragPointerStartRef.current.x + event.delta.x - scrollDeltaX,
        dragPointerStartRef.current.y + event.delta.y,
      ) ?? false;
    if (!splitHandled && insertIndex !== null) {
      const draggedSession = sessions.find((s) => s.sessionId === activeId);
      const pinnedCount = sessions.filter((s) => s.pinned).length;
      // A pinned tab dropped into the unpinned region loses its pin.
      if (draggedSession?.pinned && insertIndex >= pinnedCount) {
        togglePin(activeId);
      }
      if (onTabReorder) {
        onTabReorder(activeId, insertIndex);
      } else {
        reorderSessions(activeId, insertIndex);
      }
    }
    finishDrag();
  };

  const handleDragCancel = (): void => {
    onTabDragCancel?.();
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

  const closingSession = closingSessionId ? (sessions.find((s) => s.sessionId === closingSessionId) ?? null) : null;

  const visibleTabCount = sessions.length - (draggingSessionId ? 1 : 0);
  const visibleSessions = draggingSessionId ? sessions.filter((session) => session.sessionId !== draggingSessionId) : sessions;
  const displayedInsertIndex = externalInsertIndex ?? insertIndex;
  // Dropping back into the dragged tab's own slot is a no-op, so suppress the
  // indicator that would otherwise sit between the dragged tab and its right
  // neighbor.
  const draggedOriginalIndex = draggingSessionId
    ? sessions.findIndex((s) => s.sessionId === draggingSessionId)
    : -1;
  const effectiveInsertIndex = displayedInsertIndex !== null && displayedInsertIndex === draggedOriginalIndex
    ? null
    : displayedInsertIndex;

  const shouldHide = !forceVisible && sessions.length === 1 && terminalHideSingleTabBar;

  return (
    <div
      ref={tabBarRef}
      data-terminal-tab-bar
      className={cn('group/tabbar relative flex h-8 items-start gap-0 border-b border-app-border bg-app-surface-muted px-0', shouldHide && 'h-0 overflow-hidden')}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        autoScroll={false}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={sessions.map((s) => s.sessionId)} strategy={() => null}>
          <ScrollArea
            viewportRef={scrollRef}
            horizontal
            vertical={false}
            size="thin"
            onWheel={handleWheel}
            className="h-[31px] min-w-0 flex-1"
          >
            <div className="flex min-w-0 items-start gap-0">
              {sessions.map((session, index) => {
              const isDragging = draggingSessionId === session.sessionId;
              const draggedIndex = draggingSessionId ? sessions.findIndex((s) => s.sessionId === draggingSessionId) : -1;
              const visibleIndex = isDragging ? -1 : index - (draggedIndex >= 0 && draggedIndex < index ? 1 : 0);
              const isLastVisible = visibleIndex === visibleTabCount - 1;
              const isActive = activeSessionId === session.sessionId;
              const nextVisibleSession = visibleIndex >= 0 ? visibleSessions[visibleIndex + 1] : undefined;
              const showSeparatorAfter = !isActive && !!nextVisibleSession && nextVisibleSession.sessionId !== activeSessionId;

              return (
                <SortableTab
                  key={session.sessionId}
                  session={session}
                  active={isActive}
                  onActivate={onTabActivate ?? setActiveSession}
                  onContextMenu={(s, x, y) => onTabContextMenu?.(s, x, y)}
                  onClose={handleCloseSession}
                  onTogglePin={togglePin}
                  renaming={renamingSessionId === session.sessionId}
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
        // Overlays the tab strip instead of taking layout space, so scrollable
        // tabs never leave an empty block at the right edge. The gradient keeps
        // the icon readable over the last tab; pointer events pass through
        // while hidden.
        <Button
          variant="ghost"
          size="icon"
          onClick={onNewTabClick}
          aria-label={t('terminal.newTab')}
          className="pointer-events-none absolute inset-y-0 right-0 z-10 h-[31px] w-11 rounded-none bg-gradient-to-l from-app-surface-muted from-60% to-transparent pl-4 opacity-0 transition-opacity hover:bg-transparent hover:text-app-primary focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/tabbar:pointer-events-auto group-hover/tabbar:opacity-100"
        >
          <PlusIcon strokeWidth={1.5} />
        </Button>
      )}
      <AlertDialog
        open={!!closingSessionId}
        onOpenChange={(open) => {
          if (!open) setClosingSessionId(null);
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
            <AlertDialogTitle className="text-sm leading-5">{t('terminal.tab.closeConfirmTitle')}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {closingSession ? t('terminal.tab.closeConfirmMessage', { title: closingSession.title }) : ''}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
            <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={confirmCloseSession}>
              {t('common.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
