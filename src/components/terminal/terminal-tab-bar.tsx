import React, { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  KeyboardSensor,
  type Modifier,
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
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { PinIcon, XIcon } from 'lucide-react';
import { invokeCloseSession } from '@/lib/tauri';
import { TrackpadSafePointerSensor } from '@/lib/trackpad-safe-pointer-sensor';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import type { SessionStatus } from '@/types';

const DRAG_OVERLAY_CURSOR_GAP = 2;

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
  showDropIndicatorLeft?: boolean;
  showDropIndicatorRight?: boolean;
  showSeparatorAfter?: boolean;
  onActivate: (sessionId: string) => void;
  onContextMenu: (session: TerminalSession, x: number, y: number) => void;
  onClose: (sessionId: string) => void;
  onTogglePin?: (sessionId: string) => void;
}

const SessionTab: React.FC<SessionTabProps> = ({
  session,
  active,
  dragging = false,
  showDropIndicatorLeft = false,
  showDropIndicatorRight = false,
  showSeparatorAfter = false,
  onActivate,
  onContextMenu,
  onClose,
  onTogglePin,
}) => {
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-busy={session.pendingConnection || undefined}
      data-session-tab={session.sessionId}
      // Activate on pointerdown (like browser tabs) instead of click: dnd-kit
      // swallows the click after any drag, so a trackpad tap that jitters past
      // the sensor threshold would otherwise both start a drag and lose the
      // activation.
      onPointerDown={(e) => {
        if (e.button === 0) onActivate(session.sessionId);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (session.pendingConnection) return;
        onContextMenu(session, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(session.sessionId);
        }
      }}
      className={cn(
        'group relative flex h-8 w-40 shrink-0 items-center gap-1.5 rounded-md border border-transparent px-2 text-left text-xs outline-none transition-[background-color,border-color,color,opacity] select-none focus-visible:ring-2 focus-visible:ring-app-tab-accent focus-visible:ring-inset',
        active
          ? 'bg-app-tab-active text-app-tab-accent'
          : 'bg-transparent text-app-text-soft hover:bg-app-surface-muted hover:text-app-text',
        dragging ? 'cursor-default opacity-80' : 'cursor-pointer',
      )}
      style={session.color ? { backgroundColor: `color-mix(in srgb, ${session.color} ${active ? 25 : 8}%, transparent)` } : undefined}
    >
      {active && (
        <div
          aria-hidden="true"
          data-active-tab-indicator
          className="pointer-events-none absolute inset-0 rounded-md border border-app-tab-accent"
          style={session.color ? { borderColor: session.color } : undefined}
        />
      )}
      {showSeparatorAfter && (
        <Separator
          orientation="vertical"
          aria-hidden="true"
          data-tab-separator
          className="pointer-events-none absolute right-[-4px] top-1/2 h-4 -translate-y-1/2 bg-app-border"
        />
      )}
      {showDropIndicatorLeft && (
        <div
          data-drop-indicator="left"
          // Absolute offsets start at the tab's inner border edge. Account
          // for that 1px border when centering in the 5px outer gap.
          className="pointer-events-none absolute left-[-3.5px] top-1/2 z-10 h-[20px] w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-app-primary"
        />
      )}
      {showDropIndicatorRight && (
        <div
          data-drop-indicator="right"
          className="pointer-events-none absolute right-[-3.5px] top-1/2 z-10 h-[20px] w-0.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-app-primary"
        />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {session.pendingConnection ? (
          <Spinner className="size-3 shrink-0 text-app-warning" />
        ) : (
          <span
            aria-hidden="true"
            className={cn('size-1.5 shrink-0 rounded-full ring-1 ring-app-bg/60', sessionStatusDotClass(session.status))}
          />
        )}
        <span className={cn('block flex-1 truncate text-left text-xs leading-none font-medium')}>{session.title}</span>
      </div>
      {!session.pendingConnection && (session.pinned ? (
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
      ))}
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
  showDropIndicatorLeft,
  showDropIndicatorRight,
  showSeparatorAfter,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.sessionId,
    disabled: session.pendingConnection,
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
        showDropIndicatorLeft={showDropIndicatorLeft}
        showDropIndicatorRight={showDropIndicatorRight}
        showSeparatorAfter={showSeparatorAfter}
        onActivate={onActivate}
        onContextMenu={onContextMenu}
        onClose={onClose}
        onTogglePin={onTogglePin}
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
  const togglePin = useTerminalStore((state) => state.togglePin);

  // macOS tap-to-click in WKWebView can drop the pointerdown of a tap that
  // immediately follows another one (the single-tap gesture recognizer stays
  // blocked until the double-tap recognizer fails). Activation already runs on
  // pointerdown; when the pointerdown is lost the release still lands on the
  // tab, so track the last pointerdown target and use a pointerup on a
  // different tab as the fallback activation signal. See handleTabPointerUp.
  const lastPointerDownTabRef = useRef<string | null>(null);
  const activateTabRef = useRef<(id: string) => void>(() => {});
  activateTabRef.current = onTabActivate ?? setActiveSession;
  const tabBarSessionsRef = useRef(sessions);
  tabBarSessionsRef.current = sessions;

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
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(TrackpadSafePointerSensor, {
      // 10px dead zone: trackpad taps (tap-to-click) often jitter a few px;
      // a low threshold misreads them as drags.
      activationConstraint: { distance: 10 },
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
      if (sessions.some((session) => (
        session.sessionId === closeId && session.pendingConnection
      ))) return;
      if (closeId) setClosingSessionId(closeId);
    };
    document.addEventListener('shellspan:close-terminal-tab', handleCloseTabRequest);
    return () => document.removeEventListener('shellspan:close-terminal-tab', handleCloseTabRequest);
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

  // Force the default cursor for the whole drag via a body class (see
  // base.css); removed automatically when the drag ends or is cancelled.
  useEffect(() => {
    if (!draggingSessionId) return;
    document.body.classList.add('tab-dragging');
    return () => document.body.classList.remove('tab-dragging');
  }, [draggingSessionId]);

  // Fallback tab activation for a pointerdown that WKWebView dropped (see
  // lastPointerDownTabRef). Listeners run in the capture phase so they see the
  // events before the close/pin buttons can stop their propagation.
  useEffect(() => {
    const getElement = (target: EventTarget | null): Element | null =>
      target instanceof Element ? target : null;
    const isInteractiveControl = (target: EventTarget | null): boolean =>
      Boolean(getElement(target)?.closest('button, a[href], input, select, textarea'));
    const getTabId = (target: EventTarget | null): string | null =>
      getElement(target)?.closest('[data-session-tab]')
        ?.getAttribute('data-session-tab') ?? null;

    const handlePointerDown = (event: PointerEvent): void => {
      lastPointerDownTabRef.current = getTabId(event.target);
    };
    const handlePointerUp = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      // A release that ends a reorder drag is not an activation: dropping a tab
      // onto another one must stay a pure reorder.
      if (document.body.classList.contains('tab-dragging')) return;
      // Close/pin buttons stop their own pointerdown, but this fallback exists
      // for taps whose pointerdown was never delivered. Do not turn their
      // release into a tab activation before the button action runs.
      if (isInteractiveControl(event.target)) return;
      const tabId = getTabId(event.target);
      if (!tabId) return;
      if (!tabBarSessionsRef.current.some((session) => session.sessionId === tabId)) return;
      // The pointerdown for this tap was delivered on the tab itself: it
      // already activated, nothing to do.
      if (lastPointerDownTabRef.current === tabId) return;
      activateTabRef.current(tabId);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
    };
  }, []);

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
    if (sessions.some((session) => (
      session.sessionId === sessionId && session.pendingConnection
    ))) return;
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
            // Keep the overlay 2px down and right from the pointer hotspot so
            // the cursor remains visibly separate from the dragged tab.
            x: dragPointerStartRef.current.x - rect.left + DRAG_OVERLAY_CURSOR_GAP,
            y: dragPointerStartRef.current.y - rect.top + DRAG_OVERLAY_CURSOR_GAP,
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

  const draggingSession = draggingSessionId ? (sessions.find((s) => s.sessionId === draggingSessionId) ?? null) : null;

  const closingSession = closingSessionId ? (sessions.find((s) => s.sessionId === closingSessionId) ?? null) : null;

  const visibleTabCount = sessions.length - (draggingSessionId ? 1 : 0);
  const visibleSessions = draggingSessionId ? sessions.filter((session) => session.sessionId !== draggingSessionId) : sessions;
  const displayedInsertIndex = externalInsertIndex !== null
    ? externalInsertIndex
    : draggingSessionId
      ? insertIndex
      : null;
  // Dropping back into the dragged tab's own slot is a no-op, so suppress the
  // indicator that would otherwise sit between the dragged tab and its right
  // neighbor.
  const draggedOriginalIndex = draggingSessionId
    ? sessions.findIndex((s) => s.sessionId === draggingSessionId)
    : -1;
  const effectiveInsertIndex = displayedInsertIndex !== null && displayedInsertIndex === draggedOriginalIndex
    ? null
    : displayedInsertIndex;

  const shouldHide = !forceVisible
    && sessions.length === 1
    && terminalHideSingleTabBar
    && !sessions[0]?.pendingConnection;

  return (
    <div
      ref={tabBarRef}
      data-terminal-tab-bar
      // Double-clicking empty tab bar space opens a new tab; ignore events
      // coming from inside a tab itself.
      onDoubleClick={(e) => {
        if (!onNewTabClick) return;
        if ((e.target as HTMLElement).closest('[data-session-tab]')) return;
        onNewTabClick();
      }}
      className={cn('group/tabbar relative flex h-10 items-start border-b border-app-border/40 bg-app-bg px-1', shouldHide && 'h-0 overflow-hidden border-0 px-0')}
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
            className="h-10 min-w-0 flex-1"
          >
            <div role="tablist" className="flex min-w-0 items-center gap-[5px] py-1">
              {sessions.map((session, index) => {
              const isDragging = draggingSessionId === session.sessionId;
              const draggedIndex = draggingSessionId ? sessions.findIndex((s) => s.sessionId === draggingSessionId) : -1;
              const visibleIndex = isDragging ? -1 : index - (draggedIndex >= 0 && draggedIndex < index ? 1 : 0);
              const isLastVisible = visibleIndex === visibleTabCount - 1;
              const isActive = activeSessionId === session.sessionId;
              const nextVisibleSession = visibleIndex >= 0 ? visibleSessions[visibleIndex + 1] : undefined;
              const showSeparatorAfter = !!nextVisibleSession
                && effectiveInsertIndex !== visibleIndex + 1;

              return (
                <SortableTab
                  key={session.sessionId}
                  session={session}
                  active={isActive}
                  onActivate={onTabActivate ?? setActiveSession}
                  onContextMenu={(s, x, y) => onTabContextMenu?.(s, x, y)}
                  onClose={handleCloseSession}
                  onTogglePin={togglePin}
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
      <ConfirmationDialog
        open={!!closingSessionId}
        onOpenChange={(open) => {
          if (!open) setClosingSessionId(null);
        }}
        title={t('terminal.tab.closeConfirmTitle')}
        description={closingSession ? t('terminal.tab.closeConfirmMessage', { title: closingSession.title }) : ''}
        confirmLabel={t('common.close')}
        confirmVariant="destructive"
        onConfirm={confirmCloseSession}
      />
    </div>
  );
};
