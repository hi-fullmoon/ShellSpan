import { useEffect, useRef, useState } from 'react';
import { XIcon } from 'lucide-react';
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentContent, AttachmentDescription } from '@/components/ui/attachment';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { imageErrorKey } from '@/lib/ai/image-error';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useResolvedModel } from '@/lib/provider-contract';
import { invokeAgentImagePreview } from '@/lib/tauri';
import type { AiProviderConfig } from '@/types/ai';
import type { AgentImageRef } from '@/types/agent-image';
import type { useImageDraft } from './use-image-draft';
import { AiImageDraftRail } from './ai-image-draft-rail';

export function AiImageDraftControls({ state, selection }: { state: ReturnType<typeof useImageDraft>; selection?: AiProviderConfig }) {
  const { t } = useI18n();
  const provider = useAiSettingsStore(s => s.providers.find(p => p.id === s.defaultProviderId));
  const resolution = useResolvedModel(selection ?? provider);
  const supported = resolution.status === 'ready' && resolution.model.imageInput === 'supported';
  const previouslySupported = useRef(supported);
  useEffect(() => {
    if (!previouslySupported.current && supported && state.error?.includes('IMAGE_MODEL_UNSUPPORTED')) state.reportError(null);
    previouslySupported.current = supported;
  }, [supported, state.error, state.reportError]);
  return <div className="flex min-w-0 flex-col gap-2" data-testid="image-draft" onClick={e => e.stopPropagation()}>
    {!!(state.draft?.images.length || state.pendingFiles.length) && <>
      <div className="flex min-w-0 items-center gap-2">
        <AiImageDraftRail key={state.owner} images={state.draft?.images ?? []} pendingFiles={state.pendingFiles} busy={state.busy} locked={state.locked} error={Boolean(state.error)} onRemove={index => void state.remove(index)} />
        {(state.busy || state.locked) && <Button variant="ghost" size="icon-xs" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={() => void state.cancel()}><XIcon /></Button>}
      </div>
      <span className="sr-only" role="status">{state.pendingFiles.length ? t('ai.workspace.images.processing', { count: state.pendingFiles.length }) : t(state.locked ? 'ai.workspace.images.unconfirmed' : 'ai.workspace.images.draft')}</span>
    </>}
  </div>;
}

function CommittedImage({ sessionId, image }: { sessionId: string; image: AgentImageRef }) {
  const { t } = useI18n();
  const [result, setResult] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let alive = true; setResult({});
    void invokeAgentImagePreview({ sessionId, sha256: image.sha256 }).then(
      url => { if (alive) setResult({ url }); }, error => { if (alive) setResult({ error: String(error) }); },
    );
    return () => { alive = false; };
  }, [sessionId, image.sha256]);
  return <Attachment size="sm" state={result.error ? 'error' : result.url ? 'done' : 'processing'}>
    <AttachmentMedia variant="image">{result.url && <img src={result.url} alt={image.name} />}</AttachmentMedia>
    <AttachmentContent><AttachmentTitle>{image.name}</AttachmentTitle><AttachmentDescription>{result.error ? t(imageErrorKey(result.error)) : `${image.width} × ${image.height}`}</AttachmentDescription></AttachmentContent>
  </Attachment>;
}
export function AiCommittedImages({ sessionId, images }: { sessionId: string; images?: readonly AgentImageRef[] }) {
  return images?.length ? <AttachmentGroup>{images.map((image, i) => <CommittedImage key={`${image.sha256}:${i}`} sessionId={sessionId} image={image} />)}</AttachmentGroup> : null;
}
