import { useContext, useEffect, useRef, useState } from 'react';
import { ImageIcon, XIcon } from 'lucide-react';
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia, AttachmentTrigger } from '@/components/ui/attachment';
import { DialogTrigger } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { imageErrorKey } from '@/lib/ai/image-error';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useResolvedModel } from '@/lib/ai/provider-contract';
import { invokeAgentImagePreview } from '@/lib/ipc/tauri';
import { cn } from '@/lib/utils';
import type { AiProviderConfig } from '@/types/ai';
import type { AgentImageRef } from '@/types/agent-image';
import type { useImageDraft } from './use-image-draft';
import { AiImageDraftRail, UnifiedAttachmentContext } from './ai-image-draft-rail';
import { AiImagePreview, AiImagePreviewGroup } from './ai-image-preview';

export function AiImageDraftControls({ state, selection }: { state: ReturnType<typeof useImageDraft>; selection?: AiProviderConfig }) {
  const { t } = useI18n();
  const unified = useContext(UnifiedAttachmentContext);
  const provider = useAiSettingsStore(s => s.providers.find(p => p.id === s.defaultProviderId));
  const resolution = useResolvedModel(selection ?? provider);
  const supported = resolution.status === 'ready' && resolution.model.imageInput === 'supported';
  const previouslySupported = useRef(supported);
  useEffect(() => {
    if (!previouslySupported.current && supported && state.error?.includes('IMAGE_MODEL_UNSUPPORTED')) state.reportError(null);
    previouslySupported.current = supported;
  }, [supported, state.error, state.reportError]);
  if (!state.draft?.images.length && !state.pendingFiles.length) return null;
  const content = <>
    <AiImageDraftRail key={state.owner} images={state.draft?.images ?? []} pendingFiles={state.pendingFiles} busy={state.busy} locked={state.locked} error={Boolean(state.error)} onRemove={index => void state.remove(index)} onCancel={state.busy || state.locked ? () => void state.cancel() : undefined} />
    <span className="sr-only" role="status">{state.pendingFiles.length ? t('ai.workspace.images.processing', { count: state.pendingFiles.length }) : t(state.locked ? 'ai.workspace.images.unconfirmed' : 'ai.workspace.images.draft')}</span>
  </>;
  return unified ? content : <div className="flex min-w-0 flex-col gap-2" data-testid="image-draft" onClick={e => e.stopPropagation()}>{content}</div>;
}

function CommittedImage({ sessionId, image, compact, onRemove }: {
  sessionId: string; image: AgentImageRef; compact?: boolean; onRemove?: () => void;
}) {
  const { t } = useI18n();
  const attachment = useRef<HTMLDivElement>(null);
  const [needed, setNeeded] = useState(!compact);
  useEffect(() => {
    if (!compact || needed || !attachment.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setNeeded(true);
    });
    observer.observe(attachment.current);
    return () => observer.disconnect();
  }, [compact, needed]);
  const [result, setResult] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!needed) return;
    let alive = true; setResult({});
    void invokeAgentImagePreview({ sessionId, sha256: image.sha256 }).then(
      url => { if (alive) setResult({ url }); }, error => { if (alive) setResult({ error: String(error) }); },
    );
    return () => { alive = false; };
  }, [sessionId, image.sha256, needed]);
  const card = <Attachment ref={attachment} orientation="vertical" size={compact ? 'xs' : undefined}
    className={cn('has-data-[slot=attachment-media]:p-0', compact ? 'size-6' : 'ai-image-thumbnail', onRemove && 'isolate')}
    state={result.error ? 'error' : result.url ? 'done' : 'processing'}>
    <AttachmentMedia variant="image" className={compact ? 'size-full! rounded-[inherit]' : 'ai-image-thumbnail-media'}>
      {result.url ? <img src={result.url} alt={compact ? '' : image.name} />
        : compact ? <ImageIcon aria-hidden="true" />
        : result.error ? <span role="status" className="p-1 text-center text-xs">{t(imageErrorKey(result.error))}</span>
        : <Spinner className="motion-reduce:animate-none" />}
    </AttachmentMedia>
    {!compact && result.url && <DialogTrigger render={<AttachmentTrigger className={cn('ai-image-thumbnail-open', onRemove && 'cursor-zoom-in')}
      aria-label={`${t('ai.workspace.images.preview')} ${image.name}`} />} />}
    {onRemove && <AttachmentActions className="ai-image-thumbnail-actions">
      <AttachmentAction type="button" variant="secondary" className="ai-image-thumbnail-remove size-5"
        aria-label={`${t('ai.workspace.images.remove')} ${image.name}`} onClick={onRemove}><XIcon /></AttachmentAction>
    </AttachmentActions>}
  </Attachment>;
  return compact ? card : <AiImagePreview source={result.url} name={image.name}>{card}</AiImagePreview>;
}
export function AiCommittedImages({ sessionId, images, compact, onRemove }: {
  sessionId: string; images?: readonly AgentImageRef[]; compact?: boolean; onRemove?: (index: number) => void;
}) {
  const unified = useContext(UnifiedAttachmentContext);
  const cards = images?.map((image, i) => <CommittedImage key={`${sessionId}:${image.sha256}:${i}`}
    sessionId={sessionId} image={image} compact={compact} onRemove={onRemove && (() => onRemove(i))} />);
  if (compact) return <div className="flex shrink-0 gap-1" aria-hidden="true">{cards}</div>;
  return images?.length ? <AiImagePreviewGroup key={sessionId}>{unified ? cards : <AttachmentGroup className="max-w-[82%] gap-1.5">{cards}</AttachmentGroup>}</AiImagePreviewGroup> : null;
}
