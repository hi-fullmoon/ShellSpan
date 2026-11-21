import { useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';
import { DOCUMENT_LIMITS, IMAGE_ACCEPT, documentErrorKey } from '@/lib/ai/document-import';
import { decodeDocumentMessage, encodeDocumentMessage } from '@/lib/ai/document-message';
import { imageErrorKey } from '@/lib/ai/image-error';
import { prepareImageFiles, readLocalImageFile } from '@/lib/ai/prepare-image-files';
import type { AiInboxItem } from '@/lib/ai/session-adapter';
import { IMAGE_LIMITS } from '@/lib/ai/vision-contract';
import { invokePickLocalFiles, isTauriRuntime } from '@/lib/ipc/tauri';
import type { AgentImageRef, AgentImageUpload, AgentInboxImageEdit } from '@/types/agent-image';
import { AiCommittedImages } from './ai-image-attachments';
import { AiDraftAttachmentRail, AiImageDraftRail, UnifiedAttachmentContext } from './ai-image-draft-rail';
import type { AiQueueMutationState, AiSessionController } from './use-ai-session-controller';

const noImages: readonly AgentImageRef[] = [];

function sameImages(left: readonly AgentImageRef[], right: readonly AgentImageRef[]): boolean {
  return left.length === right.length && left.every((image, index) => (
    image.sha256 === right[index].sha256 && image.name === right[index].name
  ));
}

export function AiQueueEditComposer({ item, current, sessionId, mutation, onUpdate, onRetry, onClose, allowImageAdd }: {
  item: AiInboxItem;
  current?: AiInboxItem;
  sessionId?: string | null;
  mutation: AiQueueMutationState | null;
  onUpdate: AiSessionController['updateQueueItem'];
  onRetry?: AiSessionController['retryQueueMutation'];
  onClose: (saved: boolean) => void;
  allowImageAdd: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const editor = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const active = useRef(false);
  const sourceImages = item.images ?? noImages;
  const source = decodeDocumentMessage(item.content);
  const intent = mutation?.intent;
  const failedEdit = mutation?.status === 'failed' && (intent?.type === 'update' || intent?.type === 'updateWithImages')
    && intent.itemId === item.id ? intent : undefined;
  const [value, setValue] = useState(() => failedEdit ? decodeDocumentMessage(failedEdit.content).text : source.text);
  const [kept, setKept] = useState(() => failedEdit?.type === 'updateWithImages' ? failedEdit.images.kept : sourceImages);
  const [added, setAdded] = useState<readonly AgentImageUpload[]>(() => failedEdit?.type === 'updateWithImages' ? failedEdit.images.added : []);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = mutation?.status === 'pending' || mutation?.status === 'retrying';
  const changedElsewhere = current && (current.content !== item.content || !sameImages(current.images ?? noImages, sourceImages));
  const unavailable = !current || changedElsewhere;
  const count = kept.length + added.length;
  const hasAttachments = count > 0 || files.length > 0;
  const busy = loading || saving || pending;
  const canSave = !busy && !unavailable && Boolean(value.trim() || source.documents.length || count);
  const canAdd = allowImageAdd && !busy && !unavailable && Boolean(sessionId) && count < IMAGE_LIMITS.maxImages;

  useLayoutEffect(() => {
    mounted.current = true;
    const element = editor.current;
    if (element) {
      element.focus({ preventScroll: true });
      const end = element.value.length;
      element.setSelectionRange(end, end);
    }
    return () => { mounted.current = false; };
  }, []);

  const addFiles = async (select: () => Promise<readonly File[]>) => {
    if (!canAdd || active.current) return;
    active.current = true;
    setLoading(true);
    try {
      const selected = await select();
      if (!mounted.current || !selected.length) return;
      if (count + selected.length > IMAGE_LIMITS.maxImages) {
        toast.error(t('ai.workspace.images.error.count', { max: IMAGE_LIMITS.maxImages }));
        return;
      }
      setFiles(selected);
      const normalized = await prepareImageFiles(selected, () => mounted.current);
      if (normalized && mounted.current) setAdded(previous => [...previous, ...normalized]);
    } catch (error) {
      if (mounted.current) toast.error(t(imageErrorKey(String(error))));
    } finally {
      active.current = false;
      if (mounted.current) {
        setLoading(false);
        setFiles([]);
      }
    }
  };

  const save = async () => {
    if (!canSave || active.current) return;
    let content: string;
    try {
      content = encodeDocumentMessage(value.trim(), source.documents, true, source.skills);
    } catch (error) {
      toast.error(t(documentErrorKey(error)));
      return;
    }
    const images: AgentInboxImageEdit | undefined = added.length || !sameImages(kept, sourceImages)
      ? { kept, added } : undefined;
    const retry = failedEdit?.content === content && (failedEdit.type === 'updateWithImages'
      ? images && sameImages(failedEdit.images.kept, kept)
        && failedEdit.images.added.length === added.length && failedEdit.images.added.every((image, index) => image === added[index])
      : !images);
    active.current = true;
    setSaving(true);
    try {
      const saved = await (retry && onRetry ? onRetry()
        : images ? onUpdate(item, content, images) : onUpdate(item, content));
      if (saved && mounted.current) onClose(true);
    } finally {
      active.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <InputGroup data-composer-card="" data-queue-edit-composer="" aria-label={t('ai.workspace.queue.editingTitle')}
      className={cn(
        'ai-queue-editor h-auto min-h-0 flex-col items-stretch gap-0 overflow-hidden',
        !hasAttachments && 'pt-2.5',
      )}
      aria-busy={busy || undefined}
      onClick={event => {
        if (event.target === event.currentTarget) editor.current?.focus();
      }}
      onKeyDown={event => {
        if (!event.currentTarget.contains(event.target as Node)
          || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape' && !saving && !pending) {
          event.preventDefault();
          onClose(false);
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (!event.shiftKey && event.target === editor.current))) {
          event.preventDefault();
          if (!event.repeat) void save();
        }
      }}>
      <InputGroupTextarea ref={editor} aria-label={t('ai.workspace.queue.editLabel')} rows={1}
        className="w-full shrink resize-none overflow-y-auto pt-1 pr-3 pb-0 pl-4 [field-sizing:content] max-h-[min(336px,42vh)] min-h-7"
        value={value} onChange={event => setValue(event.currentTarget.value)}
        readOnly={saving || pending}
        placeholder={t('ai.workspace.queue.editPlaceholder')}
        maxLength={source.documents.length ? DOCUMENT_LIMITS.maxDraftCharacters - source.documents.reduce((sum, document) => sum + document.text.length, 0) : undefined}
        onPaste={event => {
          const transfer = event.clipboardData;
          const pasted = Array.from(transfer.files).filter(file => file.type.startsWith('image/'));
          if (!pasted.length) {
            for (const entry of Array.from(transfer.items)) {
              if (entry.kind !== 'file' || !entry.type.startsWith('image/')) continue;
              const file = entry.getAsFile();
              if (file) pasted.push(file);
            }
          }
          if (!pasted.length) return;
          event.preventDefault();
          void addFiles(async () => pasted);
        }} />
      {hasAttachments && (
        <InputGroupAddon align="block-start" className="ai-image-draft-addon block min-w-0 px-3" onClick={event => event.stopPropagation()}>
          <UnifiedAttachmentContext value>
            <AiDraftAttachmentRail unified count={count + files.length}>
              {sessionId && <AiCommittedImages sessionId={sessionId} images={kept}
                onRemove={busy || unavailable ? undefined : index => {
                  setKept(previous => previous.filter((_, position) => position !== index));
                  editor.current?.focus({ preventScroll: true });
                }} />}
              <AiImageDraftRail images={added} pendingFiles={files} busy={busy} locked={Boolean(unavailable)} error={false}
                onRemove={index => {
                  setAdded(previous => previous.filter((_, position) => position !== index));
                  editor.current?.focus({ preventScroll: true });
                }} />
            </AiDraftAttachmentRail>
          </UnifiedAttachmentContext>
        </InputGroupAddon>
      )}
      {unavailable && !saving && <Alert variant="warning" size="sm" className="mx-3 my-1 w-auto">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertDescription>{t(changedElsewhere ? 'ai.workspace.queue.editChanged' : 'ai.workspace.queue.errorNotActionable')}</AlertDescription>
      </Alert>}
      <InputGroupAddon align="block-end" className="ai-composer-toolbar mt-3 min-h-10.5 min-w-0 shrink-0 justify-between gap-3 px-2 pt-0.5 pb-1.5 @max-[400px]/ai-workspace:gap-1 @max-[400px]/ai-workspace:px-[7px]" onClick={event => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (!(event.target as HTMLElement).closest('button, [role="button"]')) editor.current?.focus();
      }}>
        <div className="ai-composer-tools flex min-w-0 flex-[0_2_auto] items-center gap-1">
          <input ref={picker} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={event => {
            const selected = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void addFiles(async () => selected);
          }} />
          {allowImageAdd && (
            <Tooltip disabled={!canAdd}>
              <TooltipTrigger
                render={(
                  <InputGroupButton
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="ai-composer-add size-7 shrink-0 rounded-full"
                    aria-label={t('ai.workspace.images.add')}
                    disabled={!canAdd}
                    onClick={() => {
                      if (!isTauriRuntime()) { picker.current?.click(); return; }
                      void addFiles(async () => {
                        const paths = await invokePickLocalFiles();
                        if (!mounted.current) return [];
                        if (count + paths.length > IMAGE_LIMITS.maxImages) {
                          toast.error(t('ai.workspace.images.error.count', { max: IMAGE_LIMITS.maxImages }));
                          return [];
                        }
                        return Promise.all(paths.map(readLocalImageFile));
                      });
                    }}
                  />
                )}
              >
                <PlusIcon nonScalingStroke strokeWidth={1.2} />
              </TooltipTrigger>
              <TooltipContent>{t('ai.workspace.images.add')}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="ai-composer-trailing flex min-w-0 flex-[1_1_auto] items-center justify-end gap-1.5 @max-[400px]/ai-workspace:gap-[3px]">
          <Button type="button" size="xs" variant="ghost" className="ai-queue-editor-action h-7 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground" disabled={saving || pending} onClick={() => onClose(false)}>
            {t('common.cancel')}
          </Button>
          <Tooltip disabled={!canSave}>
            <TooltipTrigger
              render={(
                <InputGroupButton
                  type="button"
                  variant="default"
                  size="icon-sm"
                  className="ai-composer-primary size-7 shrink-0"
                  disabled={!canSave}
                  aria-label={t('common.save')}
                  aria-busy={saving || pending || undefined}
                  onClick={() => void save()}
                />
              )}
            >
              {saving || pending ? <Spinner aria-hidden="true" /> : <CheckIcon />}
            </TooltipTrigger>
            <TooltipContent>{t('common.save')}</TooltipContent>
          </Tooltip>
        </div>
      </InputGroupAddon>
    </InputGroup>
  );
}
