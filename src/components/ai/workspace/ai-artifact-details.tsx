import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
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

export function AiArtifactDetails({
  sessionId,
  node,
  load,
  onBack,
}: {
  readonly sessionId: string;
  readonly node: AiConversationNodeOf<'artifact'> | null;
  readonly load: (sessionId: string, artifactId: string, maxBytes: number) => Promise<AgentArtifactResponse>;
  readonly onBack: () => void;
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
    <div className="flex size-full min-h-0 min-w-0 flex-col" data-slot="ai-artifact-details">
      <AiRouteHeader
        title={node?.title ?? t('ai.workspace.details.artifactTitle')}
        description={t('ai.workspace.details.artifactDescription')}
        onBack={onBack}
      />
      <ScrollArea className="min-h-0 min-w-0 flex-1" aria-label={t('ai.workspace.details.artifactTitle')}>
        <ScrollAreaContent className="flex min-w-0 flex-col gap-4 p-3 @min-[400px]/ai-workspace:p-4 @min-[560px]/ai-workspace:p-5">
          {state.kind === 'loading' && (
            <div className="flex flex-col gap-2" role="status" aria-label={t('common.loading')}>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
          {state.kind === 'error' && <p className="break-words text-sm text-destructive" role="alert">{state.message}</p>}
          {state.kind === 'loaded' && (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{state.artifact.metadata.kind}</Badge>
                <Badge variant="outline">{state.artifact.metadata.mediaType}</Badge>
                <Badge variant="outline">{state.artifact.metadata.sizeBytes} B</Badge>
                {state.artifact.truncated && <Badge variant="outline">{t('ai.workspace.details.truncated')}</Badge>}
              </div>
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">SHA-256</dt>
                <dd className="break-all font-mono text-xs">{state.artifact.metadata.sha256}</dd>
                <dt className="text-muted-foreground">{t('ai.workspace.details.sensitivity')}</dt>
                <dd>{state.artifact.metadata.sensitivity}</dd>
              </dl>
              <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 text-xs">
                {decodeBody(state.artifact.bodyBase64) || t('ai.workspace.details.emptyArtifact')}
              </pre>
            </>
          )}
        </ScrollAreaContent>
      </ScrollArea>
    </div>
  );
}
