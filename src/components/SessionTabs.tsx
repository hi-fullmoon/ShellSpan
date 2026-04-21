import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableAttributes,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './Icons';
import { t } from '../lib/i18n';
import { cn, sessionStatusDot } from '../lib/ui';
import type { SessionState } from '../types';

interface SessionTabsProps {
  sessions: SessionState[];
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onReorder: (draggedSessionId: string, targetSessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
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
  onRenameCancel?: () => void;
  onRenameChange?: (title: string) => void;
  onRenameCommit?: () => void;
  onRenameStart?: (session: SessionState) => void;
  onSelect: (sessionId: string) => void;
  renameValue?: string;
  renaming?: boolean;
}

function SessionTabCard({
  session,
  active,
  dragging = false,
  tabProps,
  dragListeners,
  dragAttributes,
  onClose,
  onRenameCancel,
  onRenameChange,
  onRenameCommit,
  onRenameStart,
  onSelect,
  renameValue,
  renaming = false,
}: SessionTabCardProps) {
  return (
    <div
      {...tabProps}
      {...dragAttributes}
      {...dragListeners}
      className={cn(
        'session-tab relative flex w-55 shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-left transition',
        active ? 'session-tab-active' : 'session-tab-inactive',
        renaming
          ? 'session-tab-renaming cursor-text'
          : dragging
            ? 'cursor-grabbing opacity-70 shadow-[0_12px_24px_rgba(2,6,23,0.35)]'
            : 'cursor-grab',
        tabProps?.className,
      )}
      data-session-tab={session.sessionId}
      onDoubleClick={() => onRenameStart?.(session)}
    >
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 w-50 h-8">
          <span className={cn('h-2 w-2 rounded-full', sessionStatusDot(session.status))} />
          <span className="min-w-0 flex-1">
            <input
              autoFocus
              className="session-tab-input block w-full outline-0 border-none rounded-sm px-1.5 py-1 text-[13px] font-semibold leading-4 outline-none"
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
          <button className="flex min-w-0 flex-1 items-center gap-2 w-50 h-8" onClick={() => onSelect(session.sessionId)} type="button">
            <span className={cn('h-2 w-2 rounded-full', sessionStatusDot(session.status))} />
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-xs text-left" title={session.title}>
                {session.title}
              </strong>
              <small className="session-tab-subtitle block truncate text-[11px] text-left">
                {session.username}@{session.host}
              </small>
            </span>
          </button>

          <button
            aria-label={t('sessionTabs.close')}
            className="icon-btn px-0.5 py-0.5 rounded-md"
            onClick={(event) => {
              event.stopPropagation();
              onClose(session.sessionId);
            }}
            type="button"
          >
            <CloseIcon />
          </button>
        </>
      )}
    </div>
  );
}

function SortableSessionTab({
  active,
  session,
  onClose,
  onRenameCancel,
  onRenameChange,
  onRenameCommit,
  onRenameStart,
  onSelect,
  renameValue,
  renaming,
}: {
  active: boolean;
  session: SessionState;
  onClose: (sessionId: string) => void;
  onRenameCancel: () => void;
  onRenameChange: (title: string) => void;
  onRenameCommit: () => void;
  onRenameStart: (session: SessionState) => void;
  onSelect: (sessionId: string) => void;
  renameValue: string;
  renaming: boolean;
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
      onRenameCancel={onRenameCancel}
      onRenameChange={onRenameChange}
      onRenameCommit={onRenameCommit}
      onRenameStart={onRenameStart}
      onSelect={onSelect}
      renameValue={renameValue}
      renaming={renaming}
      session={session}
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

export function SessionTabs({ sessions, activeSessionId, onSelect, onClose, onReorder, onRename, onDragStateChange }: SessionTabsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string>();
  const [renamingSessionId, setRenamingSessionId] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );

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
  };

  const finishDrag = () => {
    setDraggingSessionId(undefined);
    onDragStateChange?.(false);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : undefined;

    if (overId && activeId !== overId) {
      onReorder(activeId, overId);
    }

    finishDrag();
  };

  const handleRenameStart = (session: SessionState) => {
    setRenamingSessionId(session.sessionId);
    setRenameValue(session.title);
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

  if (sessions.length === 0) {
    return (
      <div className="surface rounded-lg session-tabs-empty flex flex-col justify-center items-start gap-1 px-2 py-2 text-xs">
        <span className="label">{t('sessionTabs.label')}</span>
        <div>{t('sessionTabs.empty')}</div>
      </div>
    );
  }

  const items = sessions.map((session) => session.sessionId as UniqueIdentifier);
  const draggingSession = draggingSessionId ? sessions.find((session) => session.sessionId === draggingSessionId) : undefined;
  const dragOverlay = (
    <DragOverlay>
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
    <div className="surface rounded-lg min-w-0 flex flex-col gap-1 p-1">
      <span className="label px-1.5 pt-0.5">{t('sessionTabs.label')}</span>
      <div className="session-tabs-scroll min-w-0 max-w-full overflow-x-auto overflow-y-hidden pb-1" onWheel={handleWheel} ref={scrollRef}>
        <DndContext
          collisionDetection={closestCenter}
          onDragCancel={finishDrag}
          onDragEnd={handleDragEnd}
          onDragStart={handleDragStart}
          sensors={sensors}
        >
          <SortableContext items={items} strategy={horizontalListSortingStrategy}>
            <div className="flex w-max min-w-full gap-1 pr-0.5">
              {sessions.map((session) => (
                <SortableSessionTab
                  active={session.sessionId === activeSessionId}
                  key={session.sessionId}
                  onClose={onClose}
                  onRenameCancel={handleRenameCancel}
                  onRenameChange={setRenameValue}
                  onRenameCommit={handleRenameCommit}
                  onRenameStart={handleRenameStart}
                  onSelect={onSelect}
                  renameValue={renameValue}
                  renaming={session.sessionId === renamingSessionId}
                  session={session}
                />
              ))}
            </div>
          </SortableContext>
          {typeof document === 'undefined' ? dragOverlay : createPortal(dragOverlay, document.body)}
        </DndContext>
      </div>
    </div>
  );
}
