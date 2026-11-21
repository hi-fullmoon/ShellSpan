import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ListEndIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiInboxItem } from '@/lib/ai/session-adapter';
import { documentMessageSummary } from '@/lib/ai/document-message';
import { TrackpadSafePointerSensor } from '@/lib/trackpad-safe-pointer-sensor';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import { AiQueueNotice } from './ai-queue-notice';
import { AiCommittedImages } from './ai-image-attachments';
import type { AiQueueMutationState } from './use-ai-session-controller';

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

export interface AiQueueDockProps {
  readonly items: readonly AiInboxItem[];
  readonly sessionId?: string | null;
  readonly editingId?: string;
  readonly running?: boolean;
  readonly mutable?: boolean;
  readonly resumeOnly?: boolean;
  readonly mutation?: AiQueueMutationState | null;
  readonly onRetry?: () => void;
  readonly onEdit?: (item: AiInboxItem) => void;
  readonly onRemove?: (item: AiInboxItem) => void;
  readonly onSteer?: (item: AiInboxItem) => void;
  readonly onResume?: (item: AiInboxItem) => void;
  readonly onReorder?: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
}

function IconAction({
  label,
  tooltip = label,
  disabled,
  onClick,
  buttonRef,
  onTooltipOpenChange,
  children,
}: {
  readonly label: string;
  readonly tooltip?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly buttonRef?: React.Ref<HTMLButtonElement>;
  readonly onTooltipOpenChange?: React.ComponentProps<typeof Tooltip>['onOpenChange'];
  readonly children: React.ReactNode;
}): React.ReactNode {
  const tooltipId = useId();
  return (
    <Tooltip onOpenChange={onTooltipOpenChange}>
      <TooltipTrigger
        render={(
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            aria-describedby={tooltip !== label ? tooltipId : undefined}
          />
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent id={tooltipId} role="tooltip" className="max-w-[min(20rem,var(--available-width))]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

interface SortableQueueRowProps {
  readonly item: AiInboxItem;
  readonly singleItem: boolean;
  readonly sessionId?: string | null;
  readonly editing: boolean;
  readonly editingActive: boolean;
  readonly editable: boolean;
  readonly draggable: boolean;
  readonly running: boolean;
  readonly mutable: boolean;
  readonly pending: boolean;
  readonly steering: boolean;
  readonly editButtons: React.RefObject<Map<string, HTMLButtonElement>>;
  readonly restoreEditFocus: React.RefObject<string | null>;
  readonly onEdit?: (item: AiInboxItem) => void;
  readonly onRemove?: (item: AiInboxItem) => void;
  readonly onSteer?: (item: AiInboxItem) => void;
  readonly onResume?: (item: AiInboxItem) => void;
}

function SortableQueueRow({
  item,
  singleItem,
  sessionId,
  editing,
  editingActive,
  editable,
  draggable,
  running,
  mutable,
  pending,
  steering,
  editButtons,
  restoreEditFocus,
  onEdit,
  onRemove,
  onSteer,
  onResume,
}: SortableQueueRowProps): React.ReactNode {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    disabled: !draggable,
    attributes: { role: 'listitem' },
  });
  const imageCount = item.images?.length ?? 0;
  const summary = documentMessageSummary(item.content);
  const style = transform || transition
    ? { transform: CSS.Transform.toString(transform), transition }
    : undefined;

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...(draggable ? { ...attributes, ...listeners } : {})}
      className={cn(
        'ai-queue-row relative flex min-h-8 w-full min-w-0 items-center gap-1 box-border py-1 pr-[5px] pl-3',
        draggable && 'cursor-grab touch-none select-none active:cursor-grabbing',
        isDragging && 'z-10 cursor-grabbing',
      )}
      data-state={item.state}
      data-editing={editing || undefined}
      data-draggable={draggable || undefined}
      data-dragging={isDragging || undefined}
    >
      {singleItem && <ListEndIcon aria-hidden="true" />}
      <div className="ai-queue-row-content flex w-full min-w-0 items-center gap-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {sessionId && imageCount > 0 && <AiCommittedImages sessionId={sessionId} images={item.images?.slice(0, 2)} compact />}
          {summary && <span className="min-w-0 truncate">{summary}</span>}
          {imageCount > 0
            ? <span className="shrink-0 text-muted-foreground">{t(imageCount === 1 ? 'ai.workspace.queue.image' : 'ai.workspace.queue.images', { count: imageCount })}</span>
            : !summary && item.hasImages ? <span className="truncate">{t('ai.workspace.images.attachments')}</span> : null}
        </div>
        {item.paused && <Badge variant="secondary">{t('ai.workspace.queue.paused')}</Badge>}
        {item.confirming && <Badge variant="secondary">{t('ai.workspace.messageConfirming')}</Badge>}
        {item.waitingForAdmission && <Badge variant="secondary">{t('ai.workspace.queue.waitingAdmission')}</Badge>}
        {item.redirected && <Badge variant="secondary" title={t('ai.workspace.queue.redirectedDescription')}>{t('ai.workspace.queue.redirected')}</Badge>}
        {item.lane === 'nextStep' && <Badge variant="secondary">{t(item.state === 'pending'
          ? 'ai.workspace.queue.lane.nextStep' : 'ai.workspace.queue.waitingNextStep')}</Badge>}
        {item.state === 'pending' && !item.waitingForAdmission && !item.confirming && (
          <Spinner aria-label={t('ai.workspace.queue.state.pending')} />
        )}
        <span className="sr-only">
          {t(`ai.workspace.queue.lane.${item.lane}` as LocaleKey)} ·{' '}
          {t(`ai.workspace.queue.state.${item.state}` as LocaleKey)}
        </span>
        {!editable && mutable && item.paused && onResume && (
          <div
            className="ai-queue-actions flex shrink-0 cursor-default items-center gap-1"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <IconAction label={t('ai.workspace.queue.resume')} disabled={pending} onClick={() => onResume(item)}>
              <ArrowUpIcon data-icon="inline-start" />
            </IconAction>
          </div>
        )}
        {editing && <Badge variant="secondary">{t('ai.workspace.queue.editing')}</Badge>}
        {editable && !editing && (
          <div
            className="ai-queue-actions flex shrink-0 cursor-default items-center gap-1"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <IconAction
              label={t('ai.workspace.queue.edit')}
              onTooltipOpenChange={(open, details) => {
                // Restoring focus after editing should not announce the edit hint again.
                if (open && details.reason === 'trigger-focus' && restoreEditFocus.current === item.id) {
                  details.cancel();
                }
              }}
              buttonRef={(button) => {
                if (button) editButtons.current.set(item.id, button);
                else editButtons.current.delete(item.id);
              }}
              disabled={pending || editingActive || onEdit === undefined}
              onClick={() => onEdit?.(item)}
            >
              <PencilIcon data-icon="inline-start" />
            </IconAction>
            <IconAction
              label={t('ai.workspace.queue.remove')}
              disabled={pending || editingActive || onRemove === undefined}
              onClick={() => onRemove?.(item)}
            >
              <Trash2Icon data-icon="inline-start" />
            </IconAction>
            {item.paused && onResume && (
              <IconAction label={t('ai.workspace.queue.resume')} disabled={pending || editingActive} onClick={() => onResume(item)}>
                <ArrowUpIcon data-icon="inline-start" />
              </IconAction>
            )}
            {running && !item.paused && item.lane === 'nextTurn' && onSteer && (
              <IconAction
                label={t('ai.workspace.queue.steer')}
                tooltip={t('ai.workspace.queue.steerTooltip')}
                disabled={pending || editingActive}
                onClick={() => onSteer(item)}
              >
                {steering
                  ? <Spinner aria-label={t('ai.workspace.queue.pending')} data-icon="inline-start" />
                  : <ArrowUpIcon data-icon="inline-start" />}
              </IconAction>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Runtime-projected Inbox rows. Editing takes place in the composer. */
export function AiQueueDock({
  items,
  sessionId,
  editingId,
  running = false,
  mutable = true,
  resumeOnly = false,
  mutation = null,
  onRetry,
  onEdit,
  onRemove,
  onSteer,
  onResume,
  onReorder,
}: AiQueueDockProps): React.ReactNode {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const restoreEditFocus = useRef<string | null>(null);
  const retrying = mutation?.status === 'retrying';
  const pending = mutation?.status === 'pending' || retrying;
  const sensors = useSensors(
    useSensor(TrackpadSafePointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortableIds = useMemo(() => items.map((item) => item.id), [items]);

  useLayoutEffect(() => {
    if (editingId) {
      restoreEditFocus.current = editingId;
      return;
    }
    const id = restoreEditFocus.current;
    if (id === null || pending) return;
    const button = editButtons.current.get(id);
    if (button && !button.disabled && document.activeElement === document.body) button.focus({ preventScroll: true });
    restoreEditFocus.current = null;
  }, [editingId, pending]);

  if (items.length === 0 && !mutation) return null;
  const expanded = items.length === 1 || !collapsed || Boolean(editingId);

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id || !onReorder) return;
    const activeItem = items.find((candidate) => candidate.id === active.id);
    const overItem = items.find((candidate) => candidate.id === over.id);
    if (!activeItem || !overItem) return;
    if (activeItem.lane !== overItem.lane || activeItem.state !== 'queued' || overItem.state !== 'queued') return;
    const laneItems = items.filter((candidate) => (
      candidate.lane === activeItem.lane && candidate.state === 'queued'
    ));
    const oldIndex = laneItems.findIndex((candidate) => candidate.id === activeItem.id);
    const newIndex = laneItems.findIndex((candidate) => candidate.id === overItem.id);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    onReorder(activeItem.lane, arrayMove(laneItems, oldIndex, newIndex).map((candidate) => candidate.id));
  };

  return (
    <div className="flex w-full min-w-0 shrink-0 flex-col gap-3">
      {(mutation?.status === 'failed' || retrying) && (
        <AiQueueNotice conflict={mutation.conflict} error={mutation.error} retrying={retrying} onRetry={onRetry} />
      )}
      {items.length > 0 && <section
      data-slot="ai-queue-dock"
      aria-label={t('ai.workspace.queue.title')}
      className="ai-queue-dock relative w-full min-w-0 shrink-0 overflow-hidden box-border"
    >
      {items.length > 1 && (
        <Button
          type="button"
          variant="plain"
          size="sm"
          className="ai-queue-header flex h-8 w-full min-w-0 items-center gap-1 px-3 py-1 disabled:opacity-100 [&>:last-child]:ml-auto"
          aria-expanded={expanded}
          aria-label={t('ai.workspace.queue.count', { count: items.length })}
          disabled={Boolean(editingId)}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ListEndIcon aria-hidden="true" />
          <span className="ai-queue-title shrink-0">{t('ai.workspace.queue.header')}</span>
          <span className="ai-queue-count shrink-0">· {items.length}</span>
          {pending && <Spinner aria-label={t('ai.workspace.queue.pending')} />}
          {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronUpIcon aria-hidden="true" />}
        </Button>
      )}
      {expanded && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <ul className="ai-queue-list m-0 max-h-[min(108px,16dvh)] list-none overflow-x-hidden overflow-y-auto p-0">
              {items.map((item) => {
                const laneCount = items.filter((candidate) => (
                  candidate.lane === item.lane && candidate.state === 'queued'
                )).length;
                const editable = mutable && !resumeOnly && item.state === 'queued' && item.source === 'user';
                const steering = pending && mutation.intent.type === 'steer' && mutation.intent.itemId === item.id;
                const editing = editingId === item.id;
                const draggable = editable && !editing && !pending && !editingId && laneCount > 1 && Boolean(onReorder);
                return (
                  <SortableQueueRow
                    key={item.id}
                    item={item}
                    singleItem={items.length === 1}
                    sessionId={sessionId}
                    editing={editing}
                    editingActive={Boolean(editingId)}
                    editable={editable}
                    draggable={draggable}
                    running={running}
                    mutable={mutable}
                    pending={pending}
                    steering={steering}
                    editButtons={editButtons}
                    restoreEditFocus={restoreEditFocus}
                    onEdit={onEdit}
                    onRemove={onRemove}
                    onSteer={onSteer}
                    onResume={onResume}
                  />
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      </section>}
    </div>
  );
}
