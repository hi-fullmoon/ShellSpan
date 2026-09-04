import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowDownUpIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ListEndIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiInboxItem } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiQueueDockProps {
  readonly items: readonly AiInboxItem[];
  readonly running?: boolean;
  readonly mutable?: boolean;
  readonly mutation?: AiQueueMutationState | null;
  readonly onUpdate?: (item: AiInboxItem, content: string) => void;
  readonly onRemove?: (item: AiInboxItem) => void;
  readonly onSteer?: (item: AiInboxItem) => void;
  readonly onReorder?: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
  readonly onRetry?: () => void;
}

function IconAction({
  label,
  tooltip = label,
  disabled,
  onClick,
  buttonRef,
  children,
}: {
  readonly label: string;
  readonly tooltip?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly buttonRef?: React.Ref<HTMLButtonElement>;
  readonly children: React.ReactNode;
}): React.ReactNode {
  const tooltipId = useId();
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
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

/** Runtime-projected Inbox rows with transient edit controls only. */
export function AiQueueDock({
  items,
  running = false,
  mutable = true,
  mutation = null,
  onUpdate,
  onRemove,
  onSteer,
  onReorder,
  onRetry,
}: AiQueueDockProps): React.ReactNode {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const restoreEditFocus = useRef<string | null>(null);
  const pending = mutation?.status === 'pending';

  const finishEditing = (): void => {
    restoreEditFocus.current = editingId;
    setEditingId(null);
  };

  useEffect(() => {
    const id = restoreEditFocus.current;
    if (id === null || editingId !== null || pending) return;
    // The editor disappears on save/cancel. Restore its trigger after a pending
    // save settles, unless the user has already focused another control.
    const button = editButtons.current.get(id);
    if (button && !button.disabled && document.activeElement === document.body) button.focus();
    restoreEditFocus.current = null;
  }, [editingId, items, pending]);

  useEffect(() => {
    if (editingId && (!mutable || !items.some((item) => item.id === editingId && item.state === 'queued'))) {
      setEditingId(null);
      setEditValue('');
    }
  }, [editingId, items, mutable]);

  if (items.length === 0 && !mutation) return null;
  const expanded = items.length === 1 || !collapsed || editingId !== null;

  const move = (item: AiInboxItem, offset: -1 | 1): void => {
    const laneItems = items.filter((candidate) => (
      candidate.lane === item.lane && candidate.state === 'queued'
    ));
    const index = laneItems.findIndex((candidate) => candidate.id === item.id);
    const destination = index + offset;
    if (index < 0 || destination < 0 || destination >= laneItems.length) return;
    const ordered = laneItems.map((candidate) => candidate.id);
    [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
    onReorder?.(item.lane, ordered);
  };

  return (
    <section
      data-slot="ai-queue-dock"
      aria-label={t('ai.workspace.queue.title')}
      className="ai-queue-dock"
    >
      {items.length > 1 && (
        <Button
          type="button"
          variant="plain"
          className="ai-queue-header"
          aria-expanded={expanded}
          disabled={editingId !== null}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ListEndIcon aria-hidden="true" />
          <span>{t('ai.workspace.queue.count', { count: items.length })}</span>
          {pending && <Spinner aria-label={t('ai.workspace.queue.pending')} />}
          {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronUpIcon aria-hidden="true" />}
        </Button>
      )}
      {expanded && <ul className="ai-queue-list">
        {items.map((item) => {
          const laneItems = items.filter((candidate) => (
            candidate.lane === item.lane && candidate.state === 'queued'
          ));
          const laneIndex = laneItems.findIndex((candidate) => candidate.id === item.id);
          const editable = mutable && item.state === 'queued' && item.source === 'user';
          const steering = pending && mutation.intent.type === 'steer' && mutation.intent.itemId === item.id;
          const editing = editingId === item.id;
          return (
            <li key={item.id} className="ai-queue-row" data-state={item.state}>
              {items.length === 1 && <ListEndIcon aria-hidden="true" />}
              {editing ? (
                <form
                  className="ai-queue-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const content = editValue.trim();
                    if (!content) return;
                    onUpdate?.(item, content);
                    finishEditing();
                  }}
                >
                  <FieldGroup className="min-w-0 flex-1 gap-0">
                    <Field data-invalid={!editValue.trim()}>
                      <FieldLabel htmlFor={`queue-edit-${item.id}`} className="sr-only">
                        {t('ai.workspace.queue.editLabel')}
                      </FieldLabel>
                      <Input
                        id={`queue-edit-${item.id}`}
                        value={editValue}
                        aria-invalid={!editValue.trim()}
                        disabled={pending}
                        autoFocus
                        onChange={(event) => setEditValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            finishEditing();
                          }
                        }}
                      />
                    </Field>
                  </FieldGroup>
                  <IconAction
                    label={t('common.save')}
                    disabled={pending || !editValue.trim()}
                    onClick={() => {
                      const content = editValue.trim();
                      if (content) {
                        onUpdate?.(item, content);
                        finishEditing();
                      }
                    }}
                  >
                    <CheckIcon data-icon="inline-start" />
                  </IconAction>
                  <IconAction label={t('common.cancel')} disabled={pending} onClick={finishEditing}>
                    <XIcon data-icon="inline-start" />
                  </IconAction>
                </form>
              ) : (
                <div className="ai-queue-row-content">
                  <span className="min-w-0 flex-1 truncate" title={item.content}>{item.content}</span>
                  {item.lane === 'nextStep' && <Badge variant="secondary">{t('ai.workspace.queue.lane.nextStep')}</Badge>}
                  {item.state === 'pending' && (
                    <Spinner aria-label={t('ai.workspace.queue.state.pending')} />
                  )}
                  <span className="sr-only">
                    {t(`ai.workspace.queue.lane.${item.lane}` as LocaleKey)} ·{' '}
                    {t(`ai.workspace.queue.state.${item.state}` as LocaleKey)}
                  </span>
                  {editable && (
                    <div className="ai-queue-actions">
                      {laneItems.length > 1 && onReorder && <DropdownMenu>
                        <DropdownMenuTrigger render={(
                          <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0"
                            disabled={pending} aria-label={t('ai.workspace.queue.reorder')} />
                        )}>
                          <ArrowDownUpIcon data-icon="inline-start" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem disabled={pending || laneIndex <= 0} onClick={() => move(item, -1)}>
                              <ChevronUpIcon />{t('ai.workspace.queue.moveUp')}
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={pending || laneIndex < 0 || laneIndex >= laneItems.length - 1} onClick={() => move(item, 1)}>
                              <ChevronDownIcon />{t('ai.workspace.queue.moveDown')}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>}
                      <IconAction
                        label={t('ai.workspace.queue.edit')}
                        buttonRef={(button) => {
                          if (button) editButtons.current.set(item.id, button);
                          else editButtons.current.delete(item.id);
                        }}
                        disabled={pending || onUpdate === undefined}
                        onClick={() => {
                          setEditingId(item.id);
                          setEditValue(item.content);
                        }}
                      >
                        <PencilIcon data-icon="inline-start" />
                      </IconAction>
                      <IconAction
                        label={t('ai.workspace.queue.remove')}
                        disabled={pending || onRemove === undefined}
                        onClick={() => onRemove?.(item)}
                      >
                        <Trash2Icon data-icon="inline-start" />
                      </IconAction>
                      {running && item.lane === 'nextTurn' && onSteer && (
                        <IconAction
                          label={t('ai.workspace.queue.steer')}
                          tooltip={t('ai.workspace.queue.steerTooltip')}
                          disabled={pending}
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
              )}
            </li>
          );
        })}
      </ul>}
      {mutation?.status === 'failed' && (
        <Alert variant="destructive" size="sm">
          <AlertTitle>
            {mutation.conflict
              ? t('ai.workspace.queue.conflict')
              : t('ai.workspace.queue.failure')}
          </AlertTitle>
          <AlertDescription className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-words">{mutation.error}</span>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCcwIcon data-icon="inline-start" />
                {t('ai.workspace.queue.retry')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
