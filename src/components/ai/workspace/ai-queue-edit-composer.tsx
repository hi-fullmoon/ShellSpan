import { useId, useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, ImagePlusIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
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
  const labelId = useId();
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
  const busy = loading || saving || pending;
  const canSave = !busy && !unavailable && Boolean(value.trim() || source.documents.length || count);
  const canAdd = allowImageAdd && !busy && !unavailable && Boolean(sessionId) && count < IMAGE_LIMITS.maxImages;

  useLayoutEffect(() => {
    mounted.current = true;
    editor.current?.focus({ preventScroll: true });
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
    <InputGroup data-composer-card="" data-queue-edit-composer="" aria-labelledby={labelId}
      className="ai-queue-editor h-auto min-h-0 flex-col items-stretch gap-0 overflow-hidden pt-2.5"
      aria-busy={busy || undefined}
      onKeyDown={event => {
        if (!event.currentTarget.contains(event.target as Node)
          || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape' && !saving && !pending) {
          event.preventDefault();
          onClose(false);
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        }
      }}>
      <label id={labelId} htmlFor={`${labelId}-input`} className="px-4 text-sm font-medium">{t('ai.workspace.queue.editingTitle')}</label>
      <InputGroupTextarea ref={editor} id={`${labelId}-input`} aria-label={t('ai.workspace.queue.editLabel')} rows={2}
        className="max-h-[min(192px,30dvh)] min-h-14 resize-none overflow-y-auto px-4 [field-sizing:content]"
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
      {(count > 0 || files.length > 0) && (
        <InputGroupAddon align="block-start" className="ai-image-draft-addon order-none block min-w-0 px-3">
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
      <InputGroupAddon align="block-end" className="flex min-w-0 shrink-0 flex-wrap justify-between gap-1 px-3 py-2">
        <input ref={picker} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={event => {
          const selected = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void addFiles(async () => selected);
        }} />
        {allowImageAdd && <Button type="button" size="sm" variant="ghost" disabled={!canAdd} onClick={() => {
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
        }}><ImagePlusIcon data-icon="inline-start" />{t('ai.workspace.images.add')}</Button>}
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" disabled={saving || pending} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
          <Button type="button" size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving || pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <CheckIcon data-icon="inline-start" aria-hidden="true" />}
            {t('common.save')}
          </Button>
        </div>
      </InputGroupAddon>
    </InputGroup>
  );
}
