import React from 'react';
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { invokeCloseSession } from '@/lib/tauri';
import {
  useTerminalStore,
  type TerminalSession,
} from '@/stores/terminalStore';

export interface TerminalTabBarProps {
  onNewTabClick?: () => void;
  onTabContextMenu?: (
    session: TerminalSession,
    x: number,
    y: number,
  ) => void;
}

interface SortableTabProps {
  session: TerminalSession;
  active: boolean;
  onActivate: (sessionId: string) => void;
  onContextMenu: (
    session: TerminalSession,
    x: number,
    y: number,
  ) => void;
  onClose: (sessionId: string) => void;
}

const SortableTab: React.FC<SortableTabProps> = ({
  session,
  active,
  onActivate,
  onContextMenu,
  onClose,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: session.sessionId });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="tab"
      tabIndex={0}
      onClick={() => onActivate(session.sessionId)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(session, e.clientX, e.clientY);
      }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
      }}
      className={cn(
        'group relative flex h-7 max-w-44 min-w-24 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors cursor-pointer',
        active
          ? 'text-app-text'
          : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
      )}
    >
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-app-primary" />
      )}
      {session.status === 'error' && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-app-error" />
      )}
      <span className="flex-1 truncate text-center">{session.title}</span>
      <button
        type="button"
        aria-label="close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(session.sessionId);
        }}
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-app-border',
          active ? 'flex' : 'hidden group-hover:flex',
        )}
      >
        ×
      </button>
    </div>
  );
};

export const TerminalTabBar: React.FC<TerminalTabBarProps> = ({
  onNewTabClick,
  onTabContextMenu,
}) => {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const setActiveSession = useTerminalStore((state) => state.setActiveSession);
  const removeSession = useTerminalStore((state) => state.removeSession);
  const reorderSessions = useTerminalStore((state) => state.reorderSessions);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleCloseSession = (sessionId: string): void => {
    removeSession(sessionId);
    invokeCloseSession(sessionId).catch(() => {});
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderSessions(String(active.id), String(over.id));
    }
  };

  return (
    <div className="flex h-9 items-center gap-1 border-b border-app-border bg-app-surface-muted px-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sessions.map((s) => s.sessionId)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {sessions.map((session) => (
              <SortableTab
                key={session.sessionId}
                session={session}
                active={activeSessionId === session.sessionId}
                onActivate={setActiveSession}
                onContextMenu={(s, x, y) => onTabContextMenu?.(s, x, y)}
                onClose={handleCloseSession}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <Button
        variant="ghost"
        size="icon"
        onClick={onNewTabClick}
        title={t('terminal.newTab')}
        className="ml-auto"
      >
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
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="Split"
        className="hidden"
      >
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
          <line x1="8" y1="3" x2="8" y2="21" />
          <path d="M3 7l5-4 5 4" />
          <path d="M3 17l5 4 5-4" />
        </svg>
      </Button>
    </div>
  );
};
