import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableAttributes,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, PinIcon } from './Icons';
import { ScrollArea } from './ScrollArea';
import { t } from '../lib/i18n';
import { cn, sessionStatusDot } from '../lib/ui';
import type { SessionState } from '../types';

interface SessionTabsProps {
  sessions: SessionState[];
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onReorder: (draggedSessionId: string, insertIndex: number) => void;
  onRename: (sessionId: string, title: string) => void;
  onCloseOthers?: (sessionId: string) => void;
  onCloseToRight?: (sessionId: string) => void;
  onCloseToLeft?: (sessionId: string) => void;
  onCloseAll?: () => void;
  onSetColor?: (sessionId: string, color?: string) => void;
  onTogglePin?: (sessionId: string) => void;
  onDragStateChange?: (dragging: boolean) => void;
}

interface SessionTabCardProps {
  session: SessionState;
  active: boolean;
  dragging?: boolean;
  tabProps?: HTMLAttributes<HTMLDivElement> & {
    ref?: (node: HTMLDivElement | null) => void;
  };
  dragListeners?: Record<string, unknown>;
  dragAttributes?: DraggableAttributes;
  onClose: (sessionId: string) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>, session: SessionState) => void;
  onRenameCancel?: () => void;
  onRenameChange?: (title: string) => void;
  onRenameCommit?: () => void;
  onRenameStart?: (session: SessionState) => void;
  onSelect: (sessionId: string) => void;
  onTogglePin?: (sessionId: string) => void;
  renameValue?: string;
  renaming?: boolean;
  showDropIndicator?: boolean;
  showDropIndicatorRight?: boolean;
}

interface TabContextMenuState {
  x: number;
  y: number;
  session: SessionState;
}

function SessionTabCard({
  session,
  active,
  dragging = false,
  tabProps,
  dragListeners,
  dragAttributes,
  onClose,
  onContextMenu,
  onRenameCancel,
  onRenameChange,
  onRenameCommit,
  onRenameStart,
  onSelect,
  onTogglePin,
  renameValue,
  renaming = false,
  showDropIndicator,
  showDropIndicatorRight,
}: SessionTabCardProps) {
  return (
    <div
      {...tabProps}
      {...dragAttributes}
      {...dragListeners}
      className={cn(
        'session-tab group relative flex h-[34px] w-48 shrink-0 items-center gap-1.5 border-r border-[var(--app-border)] px-2 py-0 text-left transition select-none',
        active ? 'session-tab-active' : 'session-tab-inactive',
        renaming
          ? 'session-tab-renaming cursor-text'
          : dragging
            ? 'cursor-grabbing opacity-70 shadow-[0_12px_24px_rgba(2,6,23,0.35)]'
            : 'cursor-pointer',
        tabProps?.className,
      )}
      style={{
        borderLeftWidth: session.profile.color ? 3 : undefined,
        borderLeftColor: session.profile.color,
        backgroundColor: session.profile.color
          ? active
            ? `color-mix(in srgb, ${session.profile.color} 12%, var(--app-surface))`
            : `color-mix(in srgb, ${session.profile.color} 6%, transparent)`
          : undefined,
        color: session.profile.color || undefined,
        ...tabProps?.style,
      }}
      data-session-tab={session.sessionId}
      onClick={() => onSelect(session.sessionId)}
      onContextMenu={(event) => onContextMenu?.(event, session)}
      onDoubleClick={() => onRenameStart?.(session)}
    >
      {showDropIndicator && (
        <div className="pointer-events-none absolute left-0 top-1/2 z-10 h-[24px] w-0.5 -translate-y-1/2 rounded-full bg-[var(--app-primary-bg)] shadow-[0_0_4px_var(--app-primary-bg)]" />
      )}
      {showDropIndicatorRight && (
        <div className="pointer-events-none absolute right-0 top-1/2 z-10 h-[24px] w-0.5 -translate-y-1/2 rounded-full bg-[var(--app-primary-bg)] shadow-[0_0_4px_var(--app-primary-bg)]" />
      )}
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 select-none">
          <span className={cn('h-2 w-2 rounded-sm', sessionStatusDot(session.status))} />
          <span className="min-w-0 flex-1">
            <input
              autoFocus
              className="session-tab-input block w-full outline-0 border-none px-1 py-0.5 text-[12px] font-medium leading-4 outline-none"
              onBlur={onRenameCommit}
              onChange={(event) => onRenameChange?.(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onRenameCommit?.();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onRenameCancel?.();
                }
              }}
              value={renameValue}
            />
          </span>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 select-none">
            <span className={cn('h-2 w-2 rounded-sm', sessionStatusDot(session.status))} />
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-[12px] font-medium text-left" title={session.title}>
                {session.title}
              </strong>
            </span>
          </div>

          {session.pinned ? (
            <button
              aria-label={t('sessionTabs.contextMenu.unpin')}
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-none bg-transparent p-0 opacity-100 transition-all',
                'hover:bg-black/10 dark:hover:bg-white/15',
              )}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin?.(session.sessionId);
              }}
              type="button"
            >
              <PinIcon />
            </button>
          ) : (
            <button
              aria-label={t('sessionTabs.close')}
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-none bg-transparent p-0 opacity-0 transition-all',
                active ? 'opacity-100' : 'group-hover:opacity-100',
                'hover:bg-black/10 dark:hover:bg-white/15',
              )}
              onClick={(event) => {
                event.stopPropagation();
                onClose(session.sessionId);
              }}
              type="button"
            >
              <CloseIcon />
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SortableSessionTab({
  active,
  session,
  onClose,
  onContextMenu,
  onRenameCancel,
  onRenameChange,
  onRenameCommit,
  onRenameStart,
  onSelect,
  onTogglePin,
  renameValue,
  renaming,
  showDropIndicator,
  showDropIndicatorRight,
}: {
  active: boolean;
  session: SessionState;
  onClose: (sessionId: string) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>, session: SessionState) => void;
  onRenameCancel: () => void;
  onRenameChange: (title: string) => void;
  onRenameCommit: () => void;
  onRenameStart: (session: SessionState) => void;
  onSelect: (sessionId: string) => void;
  onTogglePin?: (sessionId: string) => void;
  renameValue: string;
  renaming: boolean;
  showDropIndicator?: boolean;
  showDropIndicatorRight?: boolean;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: session.sessionId,
    disabled: renaming,
  });

  return (
    <SessionTabCard
      active={active}
      dragAttributes={renaming ? undefined : attributes}
      dragListeners={renaming ? undefined : listeners}
      dragging={isDragging}
      onClose={onClose}
      onContextMenu={onContextMenu}
      onRenameCancel={onRenameCancel}
      onRenameChange={onRenameChange}
      onRenameCommit={onRenameCommit}
      onRenameStart={onRenameStart}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      renameValue={renameValue}
      renaming={renaming}
      session={session}
      showDropIndicator={showDropIndicator}
      showDropIndicatorRight={showDropIndicatorRight}
      tabProps={{
        ref: setNodeRef,
        style: {
          transform: CSS.Transform.toString(transform),
          transition,
          zIndex: isDragging ? 20 : undefined,
        },
      }}
    />
  );
}

const TAB_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16',
  '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6',
  '#d946ef', '#f43f5e',
];

function TabContextMenu({
  menu,
  sessions,
  activeSessionId,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft,
  onCloseAll,
  onRenameStart,
  onSetColor,
  onTogglePin,
  onCloseMenu,
}: {
  menu: TabContextMenuState;
  sessions: SessionState[];
  activeSessionId?: string;
  onClose: (sessionId: string) => void;
  onCloseOthers?: (sessionId: string) => void;
  onCloseToRight?: (sessionId: string) => void;
  onCloseToLeft?: (sessionId: string) => void;
  onCloseAll?: () => void;
  onRenameStart?: (session: SessionState) => void;
  onSetColor?: (sessionId: string, color?: string) => void;
  onTogglePin?: (sessionId: string) => void;
  onCloseMenu: () => void;
}) {
  const sessionIndex = sessions.findIndex((s) => s.sessionId === menu.session.sessionId);
  const hasRight = sessionIndex >= 0 && sessionIndex < sessions.length - 1;
  const hasLeft = sessionIndex > 0;
  const hasOthers = sessions.length > 1;

  const handle = (action: () => void) => {
    action();
    onCloseMenu();
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onCloseMenu}
        onContextMenu={(event) => {
          event.preventDefault();
          onCloseMenu();
        }}
        role="presentation"
      />
      <div
        className="themed-menu fixed z-50 min-w-40 rounded-lg p-1 backdrop-blur"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        style={{ left: menu.x, top: menu.y }}
      >
        <button
          className="themed-menu-item flex w-full items-center rounded px-2 py-1 text-[12px] font-medium transition"
          onClick={() => handle(() => onClose(menu.session.sessionId))}
          type="button"
        >
          {t('sessionTabs.contextMenu.close')}
        </button>
        <div className="my-1 h-px bg-[var(--app-border)]" />
        {hasOthers && (
          <button
            className="themed-menu-item flex w-full items-center rounded px-2 py-1 text-[12px] font-medium transition"
            onClick={() => handle(() => onCloseOthers?.(menu.session.sessionId))}
            type="button"
          >
            {t('sessionTabs.contextMenu.closeOthers')}
          </button>
        )}
        {hasRight && (
          <button
            className="themed-menu-item flex w-full items-center rounded px-2 py-1 text-[12px] font-medium transition"
            onClick={() => handle(() => onCloseToRight?.(menu.session.sessionId))}
            type="button"
          >
            {t('sessionTabs.contextMenu.closeToRight')}
          </button>
        )}
        {hasLeft && (
          <button
            className="themed-menu-item flex w-full items-center rounded px-2 py-1 text-[12px] font-medium transition"
            onClick={() => handle(() => onCloseToLeft?.(menu.session.sessionId))}
            type="button"
          >
            {t('sessionTabs.contextMenu.closeToLeft')}
          </button>
        )}
        {(hasOthers || hasRight || hasLeft) && <div className="my-1 h-px bg-[var(--app-border)]" />}
        <button
          className="themed-menu-item flex w-full items-center rounded px-2 py-1 text-[12px] font-medium transition"
          onClick={() => handle(() => onCloseAll?.())}
          type="button"
        >
          {t('sessionTabs.contextMenu.closeAll')}
        </button>
        <div className="my-1 h-px bg-[var(--app-border)]" />
        <button
          className="themed-menu-item flex w-full items-center rounded px-2 py-1 text-[12px] font-medium transition"
          onClick={() => handle(() => onTogglePin?.(menu.session.sessionId))}
          type="button"
        >
          {menu.session.pinned ? t('sessionTabs.contextMenu.unpin') : t('sessionTabs.contextMenu.pin')}
        </button>
        <button
          className="themed-menu-item flex w-full items-center rounded px-2 py-1 text-[12px] font-medium transition"
          onClick={() => handle(() => onRenameStart?.(menu.session))}
          type="button"
        >
          {t('sessionTabs.contextMenu.rename')}
        </button>
        {onSetColor && (
          <>
            <div className="my-1 h-px bg-[var(--app-border)]" />
            <div className="flex items-center gap-1 px-2 py-1">
              <button
                className={cn(
                  'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] transition-transform hover:scale-110',
                  !menu.session.profile.color && 'ring-1 ring-offset-1 ring-[var(--app-primary-bg)]',
                )}
                onClick={() => handle(() => onSetColor(menu.session.sessionId, undefined))}
                title={t('sidebar.menu.clearColor')}
                type="button"
              >
                <span className="absolute block h-px w-full rotate-45 bg-[var(--app-text-muted)]/50" />
              </button>
              {TAB_COLORS.map((color) => (
                <button
                  className={cn(
                    'h-4 w-4 shrink-0 rounded-full transition-transform hover:scale-110',
                    menu.session.profile.color === color && 'ring-1 ring-offset-1 ring-[var(--app-primary-bg)]',
                  )}
                  key={color}
                  onClick={() => handle(() => onSetColor(menu.session.sessionId, color))}
                  style={{ backgroundColor: color }}
                  type="button"
                />
              ))}
            </div>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

export function SessionTabs({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
  onReorder,
  onRename,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft,
  onCloseAll,
  onSetColor,
  onTogglePin,
  onDragStateChange,
}: SessionTabsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string>();
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const [contextMenu, setContextMenu] = useState<TabContextMenuState>();
  const dragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(undefined);
    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, [contextMenu]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeSessionId) {
      return;
    }

    const target = container.querySelector<HTMLElement>(`[data-session-tab="${activeSessionId}"]`);
    target?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeSessionId, sessions.length]);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const hasHorizontalOverflow = container.scrollWidth > container.clientWidth + 4;
    if (!hasHorizontalOverflow || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }

    container.scrollBy({
      left: event.deltaY,
      behavior: 'auto',
    });
    event.preventDefault();
  };

  const handleDragStart = (event: DragStartEvent) => {
    if (renamingSessionId) {
      return;
    }
    const nextId = String(event.active.id);
    setDraggingSessionId(nextId);
    onDragStateChange?.(true);

    const container = scrollRef.current;
    if (container) {
      const tab = container.querySelector<HTMLElement>(`[data-session-tab="${nextId}"]`);
      if (tab) {
        const rect = tab.getBoundingClientRect();
        dragStartPosRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    if (!draggingSessionId) return;

    const currentX = dragStartPosRef.current.x + event.delta.x;
    const container = scrollRef.current;
    if (!container) return;

    const tabs = container.querySelectorAll<HTMLElement>('[data-session-tab]');
    let newInsertIndex = 0;
    let skippedBefore = 0;

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (tab.dataset.sessionTab === draggingSessionId) {
        skippedBefore++;
        continue;
      }
      const rect = tab.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      if (currentX > centerX) {
        newInsertIndex = i - skippedBefore + 1;
      }
    }

    setInsertIndex(newInsertIndex);
  };

  const finishDrag = () => {
    setDraggingSessionId(undefined);
    setInsertIndex(null);
    onDragStateChange?.(false);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    if (insertIndex !== null) {
      onReorder(activeId, insertIndex);
    }

    finishDrag();
  };

  const handleRenameStart = (session: SessionState) => {
    setRenamingSessionId(session.sessionId);
    setRenameValue(session.title);
    setContextMenu(undefined);
  };

  const handleRenameCancel = () => {
    setRenamingSessionId(undefined);
    setRenameValue('');
  };

  const handleRenameCommit = () => {
    if (!renamingSessionId) {
      return;
    }

    const nextTitle = renameValue.trim();
    if (nextTitle) {
      onRename(renamingSessionId, nextTitle);
    }
    handleRenameCancel();
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>, session: SessionState) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, session });
  };

  if (sessions.length === 0) {
    return (
      <div className="session-tabs-container surface session-tabs-empty flex flex-col justify-center items-start gap-1 px-2 py-1.5 text-xs">
        <span className="label">{t('sessionTabs.label')}</span>
        <div>{t('sessionTabs.empty')}</div>
      </div>
    );
  }

  const items = sessions.map((session) => session.sessionId as UniqueIdentifier);
  const draggingSession = draggingSessionId
    ? sessions.find((session) => session.sessionId === draggingSessionId)
    : undefined;
  const dragOverlay = (
    <DragOverlay dropAnimation={null}>
      {draggingSession ? (
        <SessionTabCard
          active={draggingSession.sessionId === activeSessionId}
          dragging
          onClose={onClose}
          onSelect={onSelect}
          session={draggingSession}
        />
      ) : null}
    </DragOverlay>
  );

  return (
    <div className="session-tabs-container surface min-w-0 flex flex-col gap-0 p-0">
      <ScrollArea
        className="min-w-0 max-w-full"
        onWheel={handleWheel}
        orientation="horizontal"
        ref={scrollRef}
        scrollbar="hover"
        scrollbarSize={3}
      >
        <DndContext
          collisionDetection={closestCenter}
          onDragCancel={finishDrag}
          onDragEnd={handleDragEnd}
          onDragMove={handleDragMove}
          onDragStart={handleDragStart}
          sensors={sensors}
        >
          <SortableContext items={items} strategy={() => null}>
            <div className="flex w-max min-w-full">
              {sessions.map((session, index) => (
                <SortableSessionTab
                  key={session.sessionId}
                  active={session.sessionId === activeSessionId}
                  onClose={onClose}
                  onContextMenu={handleContextMenu}
                  onRenameCancel={handleRenameCancel}
                  onRenameChange={setRenameValue}
                  onRenameCommit={handleRenameCommit}
                  onRenameStart={handleRenameStart}
                  onSelect={onSelect}
                  onTogglePin={onTogglePin}
                  renameValue={renameValue}
                  renaming={session.sessionId === renamingSessionId}
                  session={session}
                  showDropIndicator={insertIndex === index}
                  showDropIndicatorRight={index === sessions.length - 1 && insertIndex === sessions.length}
                />
              ))}
            </div>
          </SortableContext>
          {typeof document === 'undefined' ? dragOverlay : createPortal(dragOverlay, document.body)}
        </DndContext>
      </ScrollArea>

      {contextMenu ? (
        <TabContextMenu
          activeSessionId={activeSessionId}
          menu={contextMenu}
          onClose={onClose}
          onCloseAll={onCloseAll}
          onCloseMenu={() => setContextMenu(undefined)}
          onCloseOthers={onCloseOthers}
          onCloseToLeft={onCloseToLeft}
          onCloseToRight={onCloseToRight}
          onRenameStart={handleRenameStart}
          onSetColor={onSetColor}
          onTogglePin={onTogglePin}
          sessions={sessions}
        />
      ) : null}
    </div>
  );
}
