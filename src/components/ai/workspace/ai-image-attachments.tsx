import { useEffect, useRef, useState } from 'react';
import { ImagePlusIcon, XIcon } from 'lucide-react';
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentContent, AttachmentActions, AttachmentAction, AttachmentDescription } from '@/components/ui/attachment';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { visionCapability } from '@/lib/vision-contract';
import { invokeAgentImagePreview } from '@/lib/tauri';
import type { AgentImageRef } from '@/types/agent-image';
import type { useImageDraft } from './use-image-draft';

function imageErrorKey(error: string): LocaleKey {
  if (error.includes('IMAGE_MODEL_UNSUPPORTED')) return 'ai.workspace.images.error.model';
  if (/IMAGE_(SOURCE|BATCH|COUNT|PIXEL|BASE64|REFERENCE).*LIMIT|IMAGE_SOURCE_LIMIT/.test(error)) return 'ai.workspace.images.error.limit';
  if (error.includes('IMAGE_COLOR_PROFILE')) return 'ai.workspace.images.error.color';
  if (error.includes('IMAGE_ANIMATION')) return 'ai.workspace.images.error.animation';
  if (/IMAGE_(REQUEST|TOKEN)_BUDGET/.test(error)) return 'ai.workspace.images.error.budget';
  if (error.includes('IMAGE_ALREADY_COMMITTED')) return 'ai.workspace.images.error.committed';
  if (error.includes('IMAGE_CANCELLED')) return 'ai.workspace.images.error.cancelled';
  if (/IMAGE_(BLOB|REFERENCE_NOT_IN_SESSION)/.test(error)) return 'ai.workspace.images.error.blob';
  if (/IMAGE_(INVALID|MIME|CONTAINER|NAME)/.test(error)) return 'ai.workspace.images.error.invalid';
  return 'ai.workspace.images.error.retry';
}

export function AiImageDraftControls({ state, disabled }: { state: ReturnType<typeof useImageDraft>; disabled?: boolean }) {
  const { t } = useI18n();
  const picker = useRef<HTMLInputElement>(null);
  const supported = useAiSettingsStore(s => Boolean(visionCapability(s.getProviderConfig())));
  const previouslySupported = useRef(supported);
  useEffect(() => {
    if (!previouslySupported.current && supported && state.error?.includes('IMAGE_MODEL_UNSUPPORTED')) state.reportError(null);
    previouslySupported.current = supported;
  }, [supported, state.error, state.reportError]);
  const pickerDisabled = disabled || state.busy || state.locked;
  return <div className="flex min-w-0 flex-col gap-2" data-testid="image-draft" onClick={e => e.stopPropagation()}>
    <Button type="button" variant="ghost" size="sm" className="self-start" disabled={pickerDisabled} onClick={() => picker.current?.click()}>
      <ImagePlusIcon data-icon="inline-start" />{t('ai.workspace.images.add')}
    </Button>
    <input ref={picker} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" aria-label={t('ai.workspace.images.add')}
      disabled={pickerDisabled}
      onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void state.add(files); }} />
    {!!state.draft?.images.length && <AttachmentGroup>
      {state.draft.images.map((image, index) => <Attachment key={index} size="sm" state={state.busy ? 'uploading' : state.error ? 'error' : 'idle'}>
        <AttachmentMedia variant="image"><img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name} /></AttachmentMedia>
        <AttachmentContent><AttachmentTitle>{image.name}</AttachmentTitle><AttachmentDescription>{t(state.locked ? 'ai.workspace.images.unconfirmed' : 'ai.workspace.images.draft')}</AttachmentDescription></AttachmentContent>
        <AttachmentActions><AttachmentAction aria-label={`${t('ai.workspace.images.remove')} ${image.name}`} disabled={state.busy || state.locked} onClick={() => void state.remove(index)}><XIcon /></AttachmentAction></AttachmentActions>
      </Attachment>)}
    </AttachmentGroup>}
    {state.error && <Alert variant="destructive"><AlertDescription>{t(imageErrorKey(state.error))}</AlertDescription></Alert>}
    {(state.busy || state.locked) && <Button variant="outline" size="sm" onClick={() => void state.cancel()}>{t('common.cancel')}</Button>}
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
