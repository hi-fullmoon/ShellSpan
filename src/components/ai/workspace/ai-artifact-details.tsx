import { useEffect, useMemo, useState } from 'react';
import { CheckIcon, CopyIcon, FileOutputIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { AgentArtifactResponse } from '@/types/agent-session';
import { AiRouteHeader } from './ai-route-header';

const ARTIFACT_PREVIEW_BYTES = 256 * 1024;

function decodeBody(bodyBase64: string): string {
  const binary = atob(bodyBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function displayBody(artifact: AgentArtifactResponse): string {
  const decoded = decodeBody(artifact.bodyBase64);
  if (!artifact.metadata.mediaType.toLowerCase().includes('json')) return decoded;
  try {
    return JSON.stringify(JSON.parse(decoded), null, 2);
  } catch {
    return decoded;
  }
}

function ArtifactCopy({ text }: { readonly text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="plain"
            size="icon"
            className="ai-detail-copy absolute top-1.5 right-1.5 size-7"
            aria-label={copied ? t('common.copied') : t('common.copy')}
            onClick={() => {
              if (!navigator.clipboard || copied) return;
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_000);
              }).catch(() => undefined);
            }}
          />
        )}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipContent>{copied ? t('common.copied') : t('common.copy')}</TooltipContent>
    </Tooltip>
  );
}

function ArtifactBody({ artifact }: { readonly artifact: AgentArtifactResponse }) {
  const { t } = useI18n();
  const text = useMemo(() => displayBody(artifact), [artifact]);
  const image = artifact.metadata.mediaType.toLowerCase().startsWith('image/');
  if (image) {
    return (
      <div className="ai-artifact-image-surface grid max-w-full place-items-center overflow-hidden p-3">
        <img
          className="block max-h-[440px] max-w-full object-contain"
          src={`data:${artifact.metadata.mediaType};base64,${artifact.bodyBase64}`}
          alt={artifact.metadata.title}
        />
      </div>
    );
  }
  return (
    <div className="ai-detail-code-wrap relative min-w-0 max-w-full">
      <pre className="ai-detail-code m-0 min-w-0 max-w-full overflow-x-auto p-4 whitespace-pre-wrap break-words">{text || t('ai.workspace.details.emptyArtifact')}</pre>
      {text && <ArtifactCopy text={text} />}
    </div>
  );
}

export function AiArtifactDetails({
  sessionId,
  node,
  load,
  onBack,
  onClose,
}: {
  readonly sessionId: string;
  readonly node: AiConversationNodeOf<'artifact'> | null;
  readonly load: (sessionId: string, artifactId: string, maxBytes: number) => Promise<AgentArtifactResponse>;
  readonly onBack: () => void;
  readonly onClose?: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'loaded'; readonly artifact: AgentArtifactResponse }
    | { readonly kind: 'error'; readonly message: string }
  >({ kind: 'loading' });
  const artifactId = node?.artifactId;
  const artifactSha256 = node?.sha256;

  // Streaming rebuilds conversation nodes; reload only when the artifact or its
  // content revision changes so an already visible preview stays mounted.
  useEffect(() => {
    let active = true;
    if (artifactId === undefined) {
      setState({ kind: 'error', message: t('ai.workspace.details.notInWindow') });
      return () => { active = false; };
    }
    setState({ kind: 'loading' });
    void load(sessionId, artifactId, ARTIFACT_PREVIEW_BYTES).then(
      (artifact) => { if (active) setState({ kind: 'loaded', artifact }); },
      (error: unknown) => {
        if (active) setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => { active = false; };
  }, [load, artifactId, artifactSha256, sessionId, t]);

  return (
    <div className="ai-details-root flex size-full min-h-0 min-w-0 flex-col" data-slot="ai-artifact-details">
      <AiRouteHeader
        title={node?.title ?? t('ai.workspace.details.artifactTitle')}
        description={t('ai.workspace.details.artifactDescription')}
        onBack={onBack}
        onClose={onClose}
      />
      <ScrollArea className="min-h-0 min-w-0 flex-1" aria-label={t('ai.workspace.details.artifactTitle')}>
        {/* Override Base UI's inline fit-content minimum so long payloads stay inside the viewport. */}
        <ScrollAreaContent className="ai-details-body flex min-w-0 flex-col p-3" style={{ minWidth: 0 }}>
          {state.kind === 'loading' && (
            <div className="ai-artifact-loading flex flex-col gap-2" role="status" aria-label={t('common.loading')}>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
          {state.kind === 'error' && <p className="ai-detail-error m-0 py-2 [overflow-wrap:anywhere]" role="alert">{state.message}</p>}
          {state.kind === 'loaded' && (
            <>
              <div className="ai-artifact-summary mb-4 flex min-w-0 items-center gap-2">
                <FileOutputIcon aria-hidden="true" />
                <span className="min-w-0 truncate">{state.artifact.metadata.kind}</span>
                <small className="shrink-0">{state.artifact.metadata.mediaType}</small>
                <small className="shrink-0">{state.artifact.metadata.sizeBytes} B</small>
                {state.artifact.truncated && <small className="shrink-0">{t('ai.workspace.details.truncated')}</small>}
              </div>
              <ArtifactBody artifact={state.artifact} />
              <dl className="ai-artifact-metadata mt-4 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt>SHA-256</dt>
                <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{state.artifact.metadata.sha256}</dd>
                <dt>{t('ai.workspace.details.sensitivity')}</dt>
                <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{state.artifact.metadata.sensitivity}</dd>
              </dl>
            </>
          )}
        </ScrollAreaContent>
      </ScrollArea>
    </div>
  );
}
