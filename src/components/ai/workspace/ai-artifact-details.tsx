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
            className="ai-detail-copy"
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
      <div className="ai-artifact-image-surface">
        <img
          src={`data:${artifact.metadata.mediaType};base64,${artifact.bodyBase64}`}
          alt={artifact.metadata.title}
        />
      </div>
    );
  }
  return (
    <div className="ai-detail-code-wrap">
      <pre className="ai-detail-code">{text || t('ai.workspace.details.emptyArtifact')}</pre>
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

  useEffect(() => {
    let active = true;
    if (!node) {
      setState({ kind: 'error', message: t('ai.workspace.details.notInWindow') });
      return () => { active = false; };
    }
    setState({ kind: 'loading' });
    void load(sessionId, node.artifactId, ARTIFACT_PREVIEW_BYTES).then(
      (artifact) => { if (active) setState({ kind: 'loaded', artifact }); },
      (error: unknown) => {
        if (active) setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => { active = false; };
  }, [load, node, sessionId, t]);

  return (
    <div className="ai-details-root" data-slot="ai-artifact-details">
      <AiRouteHeader
        title={node?.title ?? t('ai.workspace.details.artifactTitle')}
        description={t('ai.workspace.details.artifactDescription')}
        onBack={onBack}
        onClose={onClose}
      />
      <ScrollArea className="min-h-0 min-w-0 flex-1" aria-label={t('ai.workspace.details.artifactTitle')}>
        {/* Override Base UI's inline fit-content minimum so long payloads stay inside the viewport. */}
        <ScrollAreaContent className="ai-details-body" style={{ minWidth: 0 }}>
          {state.kind === 'loading' && (
            <div className="ai-artifact-loading" role="status" aria-label={t('common.loading')}>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
          {state.kind === 'error' && <p className="ai-detail-error" role="alert">{state.message}</p>}
          {state.kind === 'loaded' && (
            <>
              <div className="ai-artifact-summary">
                <FileOutputIcon aria-hidden="true" />
                <span>{state.artifact.metadata.kind}</span>
                <small>{state.artifact.metadata.mediaType}</small>
                <small>{state.artifact.metadata.sizeBytes} B</small>
                {state.artifact.truncated && <small>{t('ai.workspace.details.truncated')}</small>}
              </div>
              <ArtifactBody artifact={state.artifact} />
              <dl className="ai-artifact-metadata">
                <dt>SHA-256</dt>
                <dd>{state.artifact.metadata.sha256}</dd>
                <dt>{t('ai.workspace.details.sensitivity')}</dt>
                <dd>{state.artifact.metadata.sensitivity}</dd>
              </dl>
            </>
          )}
        </ScrollAreaContent>
      </ScrollArea>
    </div>
  );
}
