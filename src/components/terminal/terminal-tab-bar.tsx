import React, { useEffect, useRef, useState, useSyncExternalStore, type WheelEvent as ReactWheelEvent } from 'react';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { BotIcon, CircleDotIcon, EllipsisIcon, Link2Icon, LockIcon, Minimize2Icon, PinIcon, RadioTowerIcon, XIcon } from 'lucide-react';
import { useCloseTerminal } from '@/hooks/useCloseTerminal';
import { cancelSshConnection } from '@/lib/terminal/ssh-connection-attempt';
import { TrackpadSafePointerSensor } from '@/lib/trackpad-safe-pointer-sensor';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { canReceiveTerminalBroadcast, useTerminalBroadcastStore } from '@/stores/terminalBroadcastStore';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { TerminalCloseDetails } from './terminal-close-details';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';
import { terminalInputReadiness } from './terminal-input-readiness';
import type { TerminalSplitDirection } from './terminal-split';
import type { SessionStatus } from '@/types';
import '@/components/ui/session-tab-bar.css';
import { resolveTerminalTheme } from './registry/terminal-registry';
import { useFocusStore } from '@/stores/focusStore';

const DRAG_OVERLAY_CURSOR_GAP = 2;

export interface TerminalPaneZoomState {
  zoomed: boolean;
  paneIndex: number;
  paneCount: number;
  hiddenActivity?: 'error' | 'unread' | null;
  shortcut?: string;
}

export interface TerminalTabBarProps {
  sessions?: TerminalSession[];
  activeSessionId?: string | null;
  forceVisible?: boolean;
  activeGroup?: boolean;
  paneZoom?: TerminalPaneZoomState;
  onNewTabClick?: () => void;
  onSwitchTab?: () => void;
  onConfigureBroadcast?: () => void;
  canSplitTab?: (direction: TerminalSplitDirection) => boolean;
  onSplitTab?: (sessionId: string, direction: TerminalSplitDirection) => void;
  onArrangePanes?: (action: 'terminalZoomPane' | 'terminalEqualizePanes' | 'terminalSwapPane') => void;
  onUnsplit?: () => void;
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
  dragPreview?: boolean;
  showDropIndicatorLeft?: boolean;
  showDropIndicatorRight?: boolean;
  onActivate: (sessionId: string) => void;
  onContextMenu: (session: TerminalSession, x: number, y: number) => void;
  onClose: (sessionId: string) => void;
  onTogglePin?: (sessionId: string) => void;
}

const SessionTab: React.FC<SessionTabProps> = ({
  session,
  active,
  dragging = false,
  dragPreview = false,
  showDropIndicatorLeft = false,
  showDropIndicatorRight = false,
  onActivate,
  onContextMenu,
  onClose,
  onTogglePin,
}) => {
  const { t } = useI18n();
  const canCancel = Boolean(session.profileId && (session.pendingConnection || session.reconnecting));
  const hasAction = !session.pendingConnection || canCancel;
  const canUnpin = session.pinned && !canCancel;
  const colorScheme = useAppStore((state) => state.terminalColorScheme);
  const colorOverrides = useAppStore((state) => state.terminalColorOverrides);
  const agentTarget = useFocusStore(state => state.enabled && state.targetSessionId === session.sessionId);
  const inBroadcast = useTerminalBroadcastStore((state) => state.sessionIds.has(session.sessionId));
  const broadcastPreparing = useSyncExternalStore(
    terminalInputReadiness.subscribe,
    () => inBroadcast && terminalInputReadiness.isPreparing(session.sessionId),
  );
  const activeLease = useSyncExternalStore(
    agentTerminalLeaseState.subscribe,
    () => agentTerminalLeaseState.get(session.sessionId),
  );
  const broadcastLeased = inBroadcast && Boolean(activeLease);
  const agentActiveInBackground = !active && Boolean(activeLease && !activeLease.waitingForUserAction);
  const broadcastTarget = inBroadcast && !broadcastPreparing && !broadcastLeased && canReceiveTerminalBroadcast(session);
  const terminalTheme = colorScheme === 'app' ? colorOverrides : resolveTerminalTheme(colorScheme, colorOverrides);
  const tab = (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-busy={session.pendingConnection || undefined}
      aria-label={session.readOnly ? `${session.title} · ${t('terminal.inputLock.label')}` : session.title}
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
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          if (!session.pendingConnection) {
            const rect = e.currentTarget.getBoundingClientRect();
            onContextMenu(session, rect.left, rect.bottom);
          }
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(session.sessionId);
        }
      }}
      className={cn(
        'session-tab relative flex h-8 w-42 shrink-0 cursor-default items-center gap-1 rounded-t-md border-x border-transparent px-1.5 text-left text-xs outline-none transition-[background-color,color,opacity] select-none',
        dragPreview && 'session-tab-drag-preview',
        !dragPreview && (active
          ? 'border-(--terminal-tab-border) bg-app-surface text-app-text'
          : 'border-transparent bg-transparent text-app-text-soft hover:bg-accent hover:text-app-text'),
        dragging && !dragPreview && 'opacity-80',
      )}
      style={session.color ? {
        backgroundColor: `color-mix(in srgb, ${session.color} ${active ? 25 : 8}%, var(${active ? '--app-bg' : '--app-surface-muted'}))`,
      } : active && terminalTheme ? {
        backgroundColor: terminalTheme.background,
        color: terminalTheme.foreground,
      } : undefined}
    >
      {showDropIndicatorLeft && (
        <div
          data-drop-indicator="left"
          className="pointer-events-none absolute left-0 top-1/2 z-10 h-6 w-0.5 -translate-y-1/2 rounded-full bg-app-primary"
        />
      )}
      {showDropIndicatorRight && (
        <div
          data-drop-indicator="right"
          className="pointer-events-none absolute right-0 top-1/2 z-10 h-6 w-0.5 -translate-y-1/2 rounded-full bg-app-primary"
        />
      )}
      <div className={cn('flex min-w-0 flex-1 items-center gap-1', hasAction && 'mr-6')}>
        {session.pendingConnection ? (
          <Spinner className="size-3 shrink-0 text-app-warning" />
        ) : (
          <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full ring-1 ring-app-bg/60', sessionStatusDotClass(session.status))} />
        )}
        <span className="block flex-1 truncate text-left text-xs leading-none font-normal">{session.title}</span>
        {agentActiveInBackground && (session.pinned || session.pendingConnection) && <span role="img" data-terminal-agent-active aria-label={t('terminal.agentLease.turnRunning')} title={t('terminal.agentLease.turnRunning')} className="flex size-4 shrink-0 items-center justify-center text-(--terminal-agent-glow) motion-safe:animate-pulse">
          <BotIcon aria-hidden="true" className="size-3" />
        </span>}
        {session.readOnly && <span title={t('terminal.inputLock.label')} data-terminal-input-lock className="inline-flex shrink-0 items-center">
          <LockIcon aria-hidden="true" className="size-3" />
        </span>}
        {broadcastTarget && <span role="img" aria-label={t('terminal.broadcast.target')} title={t('terminal.broadcast.target')} className="inline-flex shrink-0 items-center text-app-warning">
          <RadioTowerIcon aria-hidden="true" className="size-3" />
        </span>}
        {session.recording?.active && <span role="img" aria-label={t('terminal.recording.active')} title={t('terminal.recording.active')} className="inline-flex shrink-0 items-center text-app-error motion-safe:animate-pulse">
          <CircleDotIcon aria-hidden="true" className="size-3" />
        </span>}
        {session.unreadCommand && <span role="img"
          aria-label={t(session.unreadCommand === 'failed' ? 'terminal.commandBlock.failed' : 'terminal.commandBlock.completed')}
          title={t(session.unreadCommand === 'failed' ? 'terminal.commandBlock.failed' : 'terminal.commandBlock.completed')}
          className={cn('size-2 shrink-0 rounded-full', session.unreadCommand === 'failed' ? 'bg-destructive' : 'bg-app-success')} />}
        {agentTarget && (session.pinned || session.pendingConnection) && <span data-slot="focus-tab-target" role="img" aria-label={t('focus.agentTarget')} className="flex size-4 shrink-0 items-center justify-center text-app-success">
          <Link2Icon aria-hidden="true" className="size-3" />
        </span>}
      </div>
    </div>
  );

  return (
    <>
      {tab}
      {hasAction && (
        <button
          type="button"
          data-slot="session-tab-action"
          aria-label={canCancel ? t('terminal.tab.cancelConnection') : t(canUnpin ? 'sessionTab.unpin' : 'sessionTab.close', { title: session.title })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (canUnpin) onTogglePin?.(session.sessionId);
            else onClose(session.sessionId);
          }}
          className={cn(
            'session-tab-action group/close',
            !canUnpin && !canCancel && !agentTarget && !agentActiveInBackground && (dragging || !active)
              && 'invisible group-hover/session-tab-slot:visible group-focus-within/session-tab-slot:visible',
          )}
        >
          {canUnpin ? <PinIcon aria-hidden="true" className="size-3" strokeWidth={1.5} /> : (
            <>
              {agentActiveInBackground && !canCancel ? (
                <span role="img" data-terminal-agent-active aria-label={t('terminal.agentLease.turnRunning')} title={t('terminal.agentLease.turnRunning')} className="flex size-4 items-center justify-center text-(--terminal-agent-glow) motion-safe:animate-pulse group-hover/close:hidden group-focus-visible/close:hidden">
                  <BotIcon aria-hidden="true" className="size-3" />
                </span>
              ) : agentTarget && !canCancel && (
                <span data-slot="focus-tab-target" role="img" aria-label={t('focus.agentTarget')} className="flex size-4 items-center justify-center text-app-success group-hover/close:hidden group-focus-visible/close:hidden">
                  <Link2Icon aria-hidden="true" className="size-3" />
                </span>
              )}
              <XIcon aria-hidden="true" className={cn('size-3', (agentActiveInBackground || agentTarget) && !canCancel && 'hidden group-hover/close:block group-focus-visible/close:block')} strokeWidth={1.5} />
            </>
          )}
        </button>
      )}
    </>
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
}) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: session.sessionId,
    disabled: session.pendingConnection,
    attributes: { role: 'group' },
  });
  const setSortableRef = React.useCallback((element: HTMLDivElement | null) => {
    setNodeRef(element);
    setActivatorNodeRef(element);
  }, [setNodeRef, setActivatorNodeRef]);

  return (
    <div
      ref={setSortableRef}
      className="session-tab-slot group/session-tab-slot relative h-8 shrink-0"
      {...attributes}
      {...listeners}
      aria-label={session.title}
      aria-disabled={undefined}
      tabIndex={session.pendingConnection ? undefined : attributes.tabIndex}
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
  paneZoom,
  onNewTabClick,
  onSwitchTab,
  onConfigureBroadcast,
  canSplitTab,
  onSplitTab,
  onArrangePanes,
  onUnsplit,
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
  const activeSessionId = controlledActiveSessionId === undefined ? storeActiveSessionId : controlledActiveSessionId;
  const setActiveSession = useTerminalStore((state) => state.setActiveSession);
  const closeTerminal = useCloseTerminal();
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
  const [actionsOpen, setActionsOpen] = useState(false);

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
      const pending = sessions.find((session) => session.sessionId === closeId && session.pendingConnection);
      if (pending) {
        if (pending.profileId) void closeTerminal(pending.sessionId);
        return;
      }
      if (closeId) setClosingSessionId(closeId);
    };
    document.addEventListener('shellspan:close-terminal-tab', handleCloseTabRequest);
    return () => document.removeEventListener('shellspan:close-terminal-tab', handleCloseTabRequest);
  }, [activeGroup, activeSessionId, closeTerminal, sessions]);

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
    const getElement = (target: EventTarget | null): Element | null => (target instanceof Element ? target : null);
    const isInteractiveControl = (target: EventTarget | null): boolean =>
      Boolean(getElement(target)?.closest('button, a[href], input, select, textarea'));
    const getTabId = (target: EventTarget | null): string | null =>
      getElement(target)?.closest('[data-session-tab]')?.getAttribute('data-session-tab') ?? null;

    let outsidePointerOrigin: { x: number; y: number } | null = null;
    let externalDragActive = false;
    const handlePointerDown = (event: PointerEvent): void => {
      const tabId = getTabId(event.target);
      lastPointerDownTabRef.current = tabId;
      outsidePointerOrigin = tabId === null ? { x: event.clientX, y: event.clientY } : null;
      externalDragActive = false;
    };
    const handlePointerMove = (event: PointerEvent): void => {
      if (!outsidePointerOrigin || externalDragActive) return;
      if ((event.buttons & 1) === 0) {
        outsidePointerOrigin = null;
        return;
      }
      if (Math.hypot(event.clientX - outsidePointerOrigin.x, event.clientY - outsidePointerOrigin.y) >= 4) {
        externalDragActive = true;
      }
    };
    const handlePointerCancel = (): void => {
      outsidePointerOrigin = null;
      externalDragActive = false;
    };
    const handlePointerUp = (event: PointerEvent): void => {
      const wasExternalDrag = externalDragActive;
      outsidePointerOrigin = null;
      externalDragActive = false;
      if (event.button !== 0) return;
      // A release that ends a reorder drag or an outside drag (e.g. terminal
      // text selection) is not a tab activation.
      if (wasExternalDrag || document.body.classList.contains('tab-dragging')) return;
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
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    document.addEventListener('pointercancel', handlePointerCancel, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointermove', handlePointerMove, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
      document.removeEventListener('pointercancel', handlePointerCancel, true);
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
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (session?.pendingConnection) {
      if (session.profileId) void closeTerminal(sessionId);
      return;
    }
    if (session?.profileId && session.reconnecting) {
      cancelSshConnection(sessionId);
      return;
    }
    setClosingSessionId(sessionId);
  };

  const confirmCloseSession = (): void => {
    if (closingSessionId) {
      void closeTerminal(closingSessionId);
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
    const isKeyboardDrag = typeof KeyboardEvent !== 'undefined' && event.activatorEvent instanceof KeyboardEvent;
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

  const resolveDraggedSessionId = (id: string): string | null => {
    const currentSessions = tabBarSessionsRef.current;
    if (currentSessions.some((session) => session.sessionId === id)) return id;
    const replacement = currentSessions.find(
      (session) => session.replacesSessionId === id || session.replacedSessionIds?.includes(id),
    );
    return replacement?.sessionId ?? null;
  };

  const handleDragMove = (event: DragMoveEvent): void => {
    if (!draggingSessionId) {
      return;
    }
    const activeId = resolveDraggedSessionId(draggingSessionId);
    if (!activeId) {
      onTabDragCancel?.();
      setInsertIndex(null);
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
      onTabDragMove?.(activeId, pointerX, pointerY);
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
    const tabs = container ? Array.from(container.querySelectorAll<HTMLElement>('[data-session-tab]')) : [];
    const tabRects = tabs.map((tab) => tab.getBoundingClientRect());
    const isInsideTabBar = isKeyboardDrag
      ? true
      : tabBarRect && tabBarRect.width > 0 && tabBarRect.height > 0
        ? pointerX >= tabBarRect.left && pointerX <= tabBarRect.right && pointerY >= tabBarRect.top && pointerY <= tabBarRect.bottom
        : tabRects.some((rect) => pointerX >= rect.left && pointerX <= rect.right && pointerY >= rect.top && pointerY <= rect.bottom);
    if (!container || !isInsideTabBar) {
      setInsertIndex(null);
      return;
    }

    const visibleTabs = tabs.filter((tab) => tab.dataset.sessionTab !== activeId);

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

    const draggedSession = sessions.find((s) => s.sessionId === activeId);
    const pinnedCount = sessions.filter((s) => s.pinned).length;
    const minInsertIndex = draggedSession?.pinned ? 0 : pinnedCount;
    setInsertIndex(Math.max(minInsertIndex, newInsertIndex));
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const activeId = resolveDraggedSessionId(String(event.active.id));
    if (!activeId) {
      onTabDragCancel?.();
      finishDrag();
      return;
    }
    // Keyboard drags only reorder within this tab bar; pointer coordinates are
    // meaningless there, so split/cross-group handling is skipped.
    // Same scroll compensation as handleDragMove: drop coordinates must be in
    // screen space for split/cross-group hit-testing.
    const scrollDeltaX = (scrollRef.current?.scrollLeft ?? dragStartScrollLeftRef.current) - dragStartScrollLeftRef.current;
    const splitHandled = keyboardDragRef.current
      ? false
      : (onTabDragEnd?.(activeId, dragPointerStartRef.current.x + event.delta.x - scrollDeltaX, dragPointerStartRef.current.y + event.delta.y) ??
        false);
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

  const draggingSession = draggingSessionId
    ? (sessions.find((s) => s.sessionId === draggingSessionId)
      ?? sessions.find((s) => s.replacesSessionId === draggingSessionId || s.replacedSessionIds?.includes(draggingSessionId))
      ?? null)
    : null;
  const effectiveDraggingSessionId = draggingSession?.sessionId ?? draggingSessionId;

  const closingSession = closingSessionId ? (sessions.find((s) => s.sessionId === closingSessionId) ?? null) : null;

  useEffect(() => {
    if (closingSessionId && !closingSession) {
      setClosingSessionId(null);
    }
  }, [closingSession, closingSessionId]);

  const visibleTabCount = sessions.length - (draggingSession ? 1 : 0);
  const displayedInsertIndex = externalInsertIndex !== null ? externalInsertIndex : draggingSessionId ? insertIndex : null;
  // Dropping back into the dragged tab's own slot is a no-op, so suppress the
  // indicator that would otherwise sit between the dragged tab and its right
  // neighbor.
  const draggedOriginalIndex = effectiveDraggingSessionId ? sessions.findIndex((s) => s.sessionId === effectiveDraggingSessionId) : -1;
  const effectiveInsertIndex = displayedInsertIndex !== null && displayedInsertIndex === draggedOriginalIndex ? null : displayedInsertIndex;

  const focusEnabled = useFocusStore(state => state.enabled);
  const shouldHide = !forceVisible && !focusEnabled && sessions.length === 1 && terminalHideSingleTabBar && !sessions[0]?.pendingConnection;
  const activeTab = sessions.find((session) => session.sessionId === activeSessionId);
  const canCloseCurrent = activeTab && !activeTab.pendingConnection && !activeTab.reconnecting;
  const splitTarget = activeTab && !activeTab.pendingConnection ? activeTab.sessionId : null;
  const actionsLabel = t('terminal.tab.moreActions');

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
      className={cn(
        'group/tabbar relative my-0 flex h-8 items-start bg-app-surface-muted py-0',
        shouldHide && 'h-0 overflow-hidden',
      )}
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
            className="h-8 min-w-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:top-0 [&>[data-slot=scroll-area-scrollbar]]:z-30"
          >
            <div role="tablist" className="flex h-8 min-w-full items-center gap-0 p-0">
              {sessions.map((session, index) => {
                const isDragging = effectiveDraggingSessionId === session.sessionId;
                const visibleIndex = isDragging ? -1 : index - (draggedOriginalIndex >= 0 && draggedOriginalIndex < index ? 1 : 0);
                const isLastVisible = visibleIndex === visibleTabCount - 1;
                const isActive = activeSessionId === session.sessionId;

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
                  <div className="group/session-tab-slot relative" inert>
                    <SessionTab
                      session={draggingSession}
                      active={activeSessionId === draggingSession.sessionId}
                      dragging
                      dragPreview
                      onActivate={() => {}}
                      onContextMenu={() => {}}
                      onClose={() => {}}
                    />
                  </div>
                )}
              </DragOverlay>,
              document.body,
            )}
      </DndContext>
      {!shouldHide && ((paneZoom?.zoomed && onArrangePanes) || onNewTabClick) && (
        <div data-terminal-tab-actions className="relative flex h-8 shrink-0 items-center gap-1 px-1">
          {paneZoom?.zoomed && onArrangePanes && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      type="button"
                      variant="plain"
                      size="xs"
                      data-slot="terminal-pane-zoom"
                      data-zoomed="true"
                      aria-pressed
                      aria-label={t('terminal.tab.restoreZoom')}
                      onPointerDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onClick={() => onArrangePanes('terminalZoomPane')}
                      className="shrink-0 bg-app-primary/12 text-app-primary hover:bg-app-primary/20 @max-[280px]/tabbar:w-6 @max-[280px]/tabbar:px-0"
                    />
                  )}
                >
                  <Minimize2Icon aria-hidden="true" />
                  <span className="hidden @min-[420px]/tabbar:inline">{t('terminal.tab.paneMaximized')}</span>
                  <span aria-hidden="true" className="hidden text-app-primary/60 @min-[420px]/tabbar:inline">·</span>
                  <span className="hidden tabular-nums @min-[280px]/tabbar:inline">{paneZoom.paneIndex}/{paneZoom.paneCount}</span>
                  {paneZoom.hiddenActivity && (
                    <span
                      data-slot="terminal-pane-zoom-activity"
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        paneZoom.hiddenActivity === 'error' ? 'bg-destructive' : 'bg-app-success',
                      )}
                    />
                  )}
                </TooltipTrigger>
                <TooltipContent align="end">
                  <span>
                    {t('terminal.tab.restoreZoomTooltip', { count: Math.max(1, paneZoom.paneCount - 1) })}
                  </span>
                  {paneZoom.hiddenActivity && (
                    <span className="text-muted-foreground">
                      · {t(paneZoom.hiddenActivity === 'error' ? 'terminal.tab.hiddenPaneError' : 'terminal.tab.hiddenPaneUnread')}
                    </span>
                  )}
                  {paneZoom.shortcut && (
                    <Kbd className="in-data-[slot=tooltip-content]:bg-muted in-data-[slot=tooltip-content]:text-muted-foreground">
                      {paneZoom.shortcut}
                    </Kbd>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {onNewTabClick && (
            <DropdownMenu onOpenChange={setActionsOpen}>
              <DropdownMenuTrigger
                render={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 aria-expanded:bg-accent"
                  />
                )}
                aria-label={actionsLabel}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <EllipsisIcon aria-hidden="true" className="text-app-text-soft" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-max max-w-[calc(100vw-16px)]"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem size="sm" onClick={onNewTabClick}>{t('terminal.newSession.title')}</DropdownMenuItem>
                  {onSwitchTab && <DropdownMenuItem size="sm" onClick={onSwitchTab}>{t('terminal.tabSwitcher.title')}</DropdownMenuItem>}
                  {onConfigureBroadcast && <DropdownMenuItem size="sm" onClick={onConfigureBroadcast}>
                    {t('terminal.broadcast.configure')}
                  </DropdownMenuItem>}
                </DropdownMenuGroup>
                {onSplitTab && (
                  <>
                    <DropdownMenuSeparator inset />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        size="sm"
                        disabled={!splitTarget || (actionsOpen && !canSplitTab?.('right'))}
                        onClick={() => { if (splitTarget) onSplitTab(splitTarget, 'right'); }}
                      >
                        {t('terminal.tab.splitRight')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        size="sm"
                        disabled={!splitTarget || (actionsOpen && !canSplitTab?.('bottom'))}
                        onClick={() => { if (splitTarget) onSplitTab(splitTarget, 'bottom'); }}
                      >
                        {t('terminal.tab.splitDown')}
                      </DropdownMenuItem>
                      {onArrangePanes && <>
                        <DropdownMenuItem size="sm" onClick={() => onArrangePanes('terminalZoomPane')}>
                          {t(paneZoom?.zoomed ? 'terminal.tab.restoreZoom' : 'terminal.tab.maximizePane')}
                          {paneZoom?.shortcut && <DropdownMenuShortcut>{paneZoom.shortcut}</DropdownMenuShortcut>}
                        </DropdownMenuItem>
                        <DropdownMenuItem size="sm" disabled={paneZoom?.zoomed} onClick={() => onArrangePanes('terminalEqualizePanes')}>
                          {t('settings.shortcuts.terminalEqualizePanes')}
                        </DropdownMenuItem>
                        <DropdownMenuItem size="sm" disabled={paneZoom?.zoomed} onClick={() => onArrangePanes('terminalSwapPane')}>
                          {t('settings.shortcuts.terminalSwapPane')}
                        </DropdownMenuItem>
                      </>}
                      {onUnsplit && <DropdownMenuItem size="sm" onClick={onUnsplit}>{t('terminal.tab.unsplit')}</DropdownMenuItem>}
                    </DropdownMenuGroup>
                  </>
                )}
                <DropdownMenuSeparator inset />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    size="sm"
                    disabled={!canCloseCurrent}
                    onClick={() => { if (canCloseCurrent) handleCloseSession(activeTab.sessionId); }}
                  >
                    {t('terminal.tab.closeCurrent')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <ConfirmationDialog
        open={Boolean(closingSession)}
        onOpenChange={(open) => {
          if (!open) setClosingSessionId(null);
        }}
        title={t('terminal.tab.closeConfirmTitle')}
        description={closingSession ? t('terminal.tab.closeConfirmMessage', { title: closingSession.title }) : ''}
        confirmLabel={t('common.close')}
        confirmVariant="destructive"
        onConfirm={confirmCloseSession}
      >
        {closingSession && <TerminalCloseDetails sessions={[closingSession]} />}
      </ConfirmationDialog>
    </div>
  );
};
