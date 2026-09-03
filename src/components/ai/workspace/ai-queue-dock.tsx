import { useEffect, useState } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CornerDownRightIcon,
  ListEndIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  readonly mutation?: AiQueueMutationState | null;
  readonly onUpdate?: (item: AiInboxItem, content: string) => void;
  readonly onRemove?: (item: AiInboxItem) => void;
  readonly onReorder?: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
  readonly onRetry?: () => void;
}

function IconAction({
  label,
  disabled,
  destructive = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant={destructive ? 'destructiveOutline' : 'ghost'}
            size="icon"
            className="size-7 shrink-0"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
          />
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Runtime-projected Inbox rows with transient edit controls only. */
export function AiQueueDock({
  items,
  mutation = null,
  onUpdate,
  onRemove,
  onReorder,
  onRetry,
}: AiQueueDockProps): React.ReactNode {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const pending = mutation?.status === 'pending';

  useEffect(() => {
    if (editingId && !items.some((item) => item.id === editingId)) {
      setEditingId(null);
      setEditValue('');
    }
  }, [editingId, items]);

  if (items.length === 0) return null;

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
      className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
        <ListEndIcon aria-hidden="true" />
        <span>{t('ai.workspace.queue.count', { count: items.length })}</span>
        {pending && <Spinner className="ms-auto" aria-label={t('ai.workspace.queue.pending')} />}
      </div>
      <ul className="flex min-w-0 flex-col gap-1">
        {items.map((item) => {
          const laneItems = items.filter((candidate) => (
            candidate.lane === item.lane && candidate.state === 'queued'
          ));
          const laneIndex = laneItems.findIndex((candidate) => candidate.id === item.id);
          const editable = item.state === 'queued' && item.source === 'user';
          const editing = editingId === item.id;
          return (
            <li key={item.id} className="flex min-w-0 flex-col gap-1 rounded-md py-0.5">
              {editing ? (
                <form
                  className="flex min-w-0 items-start gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const content = editValue.trim();
                    if (!content) return;
                    onUpdate?.(item, content);
                    setEditingId(null);
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
                            setEditingId(null);
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
                        setEditingId(null);
                      }
                    }}
                  >
                    <CheckIcon />
                  </IconAction>
                  <IconAction label={t('common.cancel')} disabled={pending} onClick={() => setEditingId(null)}>
                    <XIcon />
                  </IconAction>
                </form>
              ) : (
                <div className="flex min-w-0 items-center gap-1 text-xs">
                  <CornerDownRightIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{item.content}</span>
                  <Badge variant="outline" className="shrink-0">
                    {t(`ai.workspace.queue.lane.${item.lane}` as LocaleKey)}
                  </Badge>
                  <span className="sr-only">
                    {t(`ai.workspace.queue.state.${item.state}` as LocaleKey)}
                  </span>
                  {editable && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <IconAction
                        label={t('ai.workspace.queue.moveUp')}
                        disabled={pending || laneIndex <= 0}
                        onClick={() => move(item, -1)}
                      >
                        <ChevronUpIcon />
                      </IconAction>
                      <IconAction
                        label={t('ai.workspace.queue.moveDown')}
                        disabled={pending || laneIndex < 0 || laneIndex >= laneItems.length - 1}
                        onClick={() => move(item, 1)}
                      >
                        <ChevronDownIcon />
                      </IconAction>
                      <IconAction
                        label={t('ai.workspace.queue.edit')}
                        disabled={pending || onUpdate === undefined}
                        onClick={() => {
                          setEditingId(item.id);
                          setEditValue(item.content);
                        }}
                      >
                        <PencilIcon />
                      </IconAction>
                      <IconAction
                        label={t('ai.workspace.queue.remove')}
                        destructive
                        disabled={pending || onRemove === undefined}
                        onClick={() => onRemove?.(item)}
                      >
                        <Trash2Icon />
                      </IconAction>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
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
