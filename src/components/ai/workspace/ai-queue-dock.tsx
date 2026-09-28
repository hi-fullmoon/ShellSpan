import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowDownUpIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ListEndIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import type { AiInboxItem } from '@/lib/ai/session-adapter';
import { decodeDocumentMessage, documentMessageSummary, encodeDocumentMessage } from '@/lib/ai/document-message';
import { DOCUMENT_LIMITS, documentErrorKey } from '@/lib/ai/document-import';
import type { LocaleKey } from '@/locales';
import { AiQueueNotice } from './ai-queue-notice';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiQueueDockProps {
  readonly items: readonly AiInboxItem[];
  readonly running?: boolean;
  readonly mutable?: boolean;
  readonly mutation?: AiQueueMutationState | null;
  readonly onUpdate?: (item: AiInboxItem, content: string) => void;
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

/** Runtime-projected Inbox rows with transient edit controls only. */
export function AiQueueDock({
  items,
  running = false,
  mutable = true,
  mutation = null,
  onUpdate,
  onRemove,
  onSteer,
  onResume,
  onReorder,
}: AiQueueDockProps): React.ReactNode {
  const { t } = useI18n();
  const toast = useToast();
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
    <div className="flex w-full min-w-0 shrink-0 flex-col gap-3">
      {mutation?.status === 'failed' && (
        <AiQueueNotice conflict={mutation.conflict} error={mutation.error} />
      )}
      {items.length > 0 && <section
      data-slot="ai-queue-dock"
      aria-label={t('ai.workspace.queue.title')}
      className="ai-queue-dock relative w-full min-w-0 shrink-0 overflow-hidden box-border pb-0.5"
    >
      {items.length > 1 && (
        <Button
          type="button"
          variant="plain"
          className="ai-queue-header flex h-9 w-full min-w-0 items-center gap-1 px-3 py-1 [&>:last-child]:ml-auto"
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
      {expanded && <ul className="ai-queue-list m-0 max-h-[min(108px,16dvh)] list-none overflow-y-auto p-0">
        {items.map((item) => {
          const documentMessage = decodeDocumentMessage(item.content);
          const canSave = Boolean(editValue.trim() || documentMessage.documents.length);
          const save = (): void => {
            if (!canSave) return;
            let content: string;
            try {
              content = encodeDocumentMessage(editValue.trim(), documentMessage.documents, true, documentMessage.skills);
            } catch (error) {
              toast.error(t(documentErrorKey(error)));
              return;
            }
            onUpdate?.(item, content);
            finishEditing();
          };
          const laneItems = items.filter((candidate) => (
            candidate.lane === item.lane && candidate.state === 'queued'
          ));
          const laneIndex = laneItems.findIndex((candidate) => candidate.id === item.id);
          const editable = mutable && item.state === 'queued' && item.source === 'user';
          const steering = pending && mutation.intent.type === 'steer' && mutation.intent.itemId === item.id;
          const editing = editingId === item.id;
          return (
            <li key={item.id} className="ai-queue-row flex h-9 w-full min-w-0 items-center gap-1 box-border py-1 pr-[5px] pl-3" data-state={item.state}>
              {items.length === 1 && <ListEndIcon aria-hidden="true" />}
              {editing ? (
                <form
                  className="ai-queue-editor flex w-full min-w-0 items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save();
                  }}
                >
                  <FieldGroup className="min-w-0 flex-1 gap-0">
                    <Field data-invalid={!canSave}>
                      <FieldLabel htmlFor={`queue-edit-${item.id}`} className="sr-only">
                        {t('ai.workspace.queue.editLabel')}
                      </FieldLabel>
                      <Input
                        id={`queue-edit-${item.id}`}
                        className="h-6 px-2 py-0"
                        value={editValue}
                        aria-invalid={!canSave}
                        maxLength={documentMessage.documents.length ? DOCUMENT_LIMITS.maxDraftCharacters - documentMessage.documents.reduce((sum, document) => sum + document.text.length, 0) : undefined}
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
                    disabled={pending || !canSave}
                    onClick={save}
                  >
                    <CheckIcon data-icon="inline-start" />
                  </IconAction>
                  <IconAction label={t('common.cancel')} disabled={pending} onClick={finishEditing}>
                    <XIcon data-icon="inline-start" />
                  </IconAction>
                </form>
              ) : (
                <div className="ai-queue-row-content flex w-full min-w-0 items-center gap-2.5">
                  <span className="min-w-0 flex-1 truncate">{documentMessageSummary(item.content)}</span>
                  {item.paused && <Badge variant="secondary">{t('ai.workspace.queue.paused')}</Badge>}
                  {item.lane === 'nextStep' && <Badge variant="secondary">{t(item.state === 'pending'
                    ? 'ai.workspace.queue.lane.nextStep' : 'ai.workspace.queue.waitingNextStep')}</Badge>}
                  {item.state === 'pending' && (
                    <Spinner aria-label={t('ai.workspace.queue.state.pending')} />
                  )}
                  <span className="sr-only">
                    {t(`ai.workspace.queue.lane.${item.lane}` as LocaleKey)} ·{' '}
                    {t(`ai.workspace.queue.state.${item.state}` as LocaleKey)}
                  </span>
                  {!editable && mutable && item.paused && onResume && <IconAction label={t('ai.workspace.queue.resume')} disabled={pending} onClick={() => onResume(item)}><ArrowUpIcon data-icon="inline-start" /></IconAction>}
                  {editable && (
                    <div className="ai-queue-actions flex shrink-0 items-center gap-1">
                      {laneItems.length > 1 && onReorder && <DropdownMenu>
                        <DropdownMenuTrigger render={(
                          <Button type="button" variant="ghost" size="icon-xs" className="shrink-0"
                            disabled={pending} aria-label={t('ai.workspace.queue.reorder')} />
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
                        disabled={pending || onUpdate === undefined}
                        onClick={() => {
                          setEditingId(item.id);
                          setEditValue(documentMessage.text);
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
                      {item.paused && onResume && <IconAction label={t('ai.workspace.queue.resume')} disabled={pending} onClick={() => onResume(item)}><ArrowUpIcon data-icon="inline-start" /></IconAction>}
                      {running && !item.paused && item.lane === 'nextTurn' && onSteer && (
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
      </section>}
    </div>
  );
}
