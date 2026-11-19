import { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDownUpIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ListEndIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiInboxItem } from '@/lib/ai/session-adapter';
import { documentMessageSummary } from '@/lib/ai/document-message';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import { AiQueueNotice } from './ai-queue-notice';
import { AiCommittedImages } from './ai-image-attachments';
import type { AiQueueMutationState } from './use-ai-session-controller';

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
    <div className="flex w-full min-w-0 shrink-0 flex-col gap-3">
      {(mutation?.status === 'failed' || retrying) && (
        <AiQueueNotice conflict={mutation.conflict} error={mutation.error} retrying={retrying} onRetry={onRetry} />
      )}
      {items.length > 0 && <section
      data-slot="ai-queue-dock"
      aria-label={t('ai.workspace.queue.title')}
      className={cn('ai-queue-dock relative w-full min-w-0 shrink-0 overflow-hidden box-border',
        items.length === 1 ? 'py-px' : 'pb-0.5')}
    >
      {items.length > 1 && (
        <Button
          type="button"
          variant="plain"
          className="ai-queue-header flex h-9 w-full min-w-0 items-center gap-1 px-3 py-1 [&>:last-child]:ml-auto"
          aria-expanded={expanded}
          disabled={Boolean(editingId)}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ListEndIcon aria-hidden="true" />
          <span>{t('ai.workspace.queue.count', { count: items.length })}</span>
          {pending && <Spinner aria-label={t('ai.workspace.queue.pending')} />}
          {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronUpIcon aria-hidden="true" />}
        </Button>
      )}
      {expanded && <ul className="ai-queue-list m-0 max-h-[min(108px,16dvh)] list-none overflow-y-auto p-0">
        {items.map((item) => {
          const laneItems = items.filter((candidate) => (
            candidate.lane === item.lane && candidate.state === 'queued'
          ));
          const laneIndex = laneItems.findIndex((candidate) => candidate.id === item.id);
          const editable = mutable && !resumeOnly && item.state === 'queued' && item.source === 'user';
          const steering = pending && mutation.intent.type === 'steer' && mutation.intent.itemId === item.id;
          const editing = editingId === item.id;
          const imageCount = item.images?.length ?? 0;
          const summary = documentMessageSummary(item.content);
          return (
            <li key={item.id} className="ai-queue-row flex h-9 w-full min-w-0 items-center gap-1 box-border py-1 pr-[5px] pl-3"
              data-state={item.state} data-editing={editing || undefined}>
              {items.length === 1 && <ListEndIcon aria-hidden="true" />}
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
                  {!editable && mutable && item.paused && onResume && <IconAction label={t('ai.workspace.queue.resume')} disabled={pending} onClick={() => onResume(item)}><ArrowUpIcon data-icon="inline-start" /></IconAction>}
                  {editing && <Badge variant="secondary">{t('ai.workspace.queue.editing')}</Badge>}
                  {editable && !editing && (
                    <div className="ai-queue-actions flex shrink-0 items-center gap-1">
                      {laneItems.length > 1 && onReorder && <DropdownMenu>
                        <DropdownMenuTrigger render={(
                          <Button type="button" variant="ghost" size="icon-xs" className="shrink-0"
                            disabled={pending || Boolean(editingId)} aria-label={t('ai.workspace.queue.reorder')} />
                        )}>
                          <ArrowDownUpIcon data-icon="inline-start" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" side="top" className="w-40 max-w-(--available-width)">
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>{t(`ai.workspace.queue.lane.${item.lane}` as LocaleKey)}</DropdownMenuLabel>
                            <DropdownMenuItem className="whitespace-nowrap" disabled={pending || laneIndex <= 0} onClick={() => move(item, -1)}>
                              <ArrowUpIcon />{t('ai.workspace.queue.moveUp')}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="whitespace-nowrap" disabled={pending || laneIndex < 0 || laneIndex >= laneItems.length - 1} onClick={() => move(item, 1)}>
                              <ArrowDownIcon />{t('ai.workspace.queue.moveDown')}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>}
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
                        disabled={pending || Boolean(editingId) || onEdit === undefined}
                        onClick={() => onEdit?.(item)}
                      >
                        <PencilIcon data-icon="inline-start" />
                      </IconAction>
                      <IconAction
                        label={t('ai.workspace.queue.remove')}
                        disabled={pending || Boolean(editingId) || onRemove === undefined}
                        onClick={() => onRemove?.(item)}
                      >
                        <Trash2Icon data-icon="inline-start" />
                      </IconAction>
                      {item.paused && onResume && <IconAction label={t('ai.workspace.queue.resume')} disabled={pending || Boolean(editingId)} onClick={() => onResume(item)}><ArrowUpIcon data-icon="inline-start" /></IconAction>}
                      {running && !item.paused && item.lane === 'nextTurn' && onSteer && (
                        <IconAction
                          label={t('ai.workspace.queue.steer')}
                          tooltip={t('ai.workspace.queue.steerTooltip')}
                          disabled={pending || Boolean(editingId)}
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
        })}
      </ul>}
      </section>}
    </div>
  );
}
