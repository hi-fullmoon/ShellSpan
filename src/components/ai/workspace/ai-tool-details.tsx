import { useMemo } from 'react';
import { Clock3Icon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { cn } from '@/lib/utils';
import { AiRouteHeader } from './ai-route-header';
import { AiContentTitle } from './ai-content-title';
import { AI_CONTENT_CODE_CLASS, AI_CONTENT_HEADER_CLASS } from './ai-style-classes';
import {
  AiToolExpandedContent,
  AiToolCopyButton,
  ToolStateIcon,
  formatToolValue,
  toolOutputForCopy,
  toolDisplaySummary,
  toolErrorIsInOutput,
  toolDiffPreview,
  toolExecutionDetails,
} from './ai-tool-presentation';

const DETAIL_PREVIEW_LIMIT = 64 * 1024;

function preview(value: unknown): string {
  const text = formatToolValue(value);
  return text.length > DETAIL_PREVIEW_LIMIT
    ? `${text.slice(0, DETAIL_PREVIEW_LIMIT)}\n…`
    : text;
}

function DetailSection({
  title,
  actions,
  children,
}: {
  readonly title: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="ai-detail-section flex max-h-fit min-h-0 min-w-0 flex-1 flex-col">
      <div className={cn(AI_CONTENT_HEADER_CLASS, 'ai-detail-section-header justify-between')}>
        <h3 className="min-w-0 flex-1"><AiContentTitle>{title}</AiContentTitle></h3>
      </div>
      <div className="ai-tool-content-region relative flex min-h-0 min-w-0 flex-col overflow-hidden" data-ai-copy-region>
        <ScrollArea className="flex max-h-65 min-h-0 min-w-0 flex-col" viewportRender={<div className="h-auto min-h-0 flex-1" />} horizontal aria-label={title}>
          {/* Base UI's fit-content minimum must not widen long tool payloads. */}
          <ScrollAreaContent className="min-w-0" style={{ minWidth: 0 }}>
            {children}
          </ScrollAreaContent>
        </ScrollArea>
        {actions}
      </div>
    </section>
  );
}

function DetailCode({ value, label }: { readonly value: unknown; readonly label: string }) {
  const { t } = useI18n();
  const text = preview(value);
  return (
    <DetailSection
      title={label}
      actions={<AiToolCopyButton text={text} label={t('ai.workspace.details.copy', { section: label })} />}
    >
      <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-detail-code whitespace-pre-wrap break-words')}><code>{text}</code></pre>
    </DetailSection>
  );
}

export function AiToolDetails({
  node,
  onOpenStoredOutput,
  onBack,
  onClose,
}: {
  readonly node: AiConversationNodeOf<'tool'> | null;
  readonly onOpenStoredOutput?: () => void;
  readonly onBack: () => void;
  readonly onClose?: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const outputDiff = useMemo(() => node ? toolDiffPreview(node) : null, [node]);
  const outputText = node ? toolOutputForCopy(node) : '';
  const executionDetails = node ? toolExecutionDetails(node) : null;
  const outputCopyAction = outputText ? (
    <AiToolCopyButton text={outputText} label={t('ai.workspace.details.copy', { section: t('ai.workspace.details.output') })} />
  ) : undefined;
  return (
    <div className="ai-details-root flex size-full min-h-0 min-w-0 flex-col" data-slot="ai-tool-details">
      <AiRouteHeader
        title={node?.name ?? t('ai.workspace.details.toolTitle')}
        description={t('ai.workspace.details.toolDescription')}
        onBack={onBack}
        onClose={onClose}
      />
      <div className="ai-details-body flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden p-3">
        {!node ? (
          <p className="ai-details-empty m-0 py-2 [overflow-wrap:anywhere]">{t('ai.workspace.details.notInWindow')}</p>
        ) : (
          <>
            <div className="ai-detail-summary mb-1 flex max-h-[30%] min-h-0 min-w-0 shrink-0 flex-col items-stretch gap-2.5" data-state={node.state}>
              <div className="ai-detail-summary-meta flex min-w-0 shrink-0 items-center justify-between gap-3">
                <Badge variant={!node.recoveredByToolKey && (node.state === 'failed' || node.state === 'rejected') ? 'destructive' : 'secondary'}>
                  {!node.recoveredByToolKey && <ToolStateIcon node={node} />}
                  {t(node.recoveredByToolKey ? 'ai.workspace.tool.recovered' : `ai.workspace.tool.${node.state}`)}
                </Badge>
                {node.durationMs !== null && (
                  <small className="ai-detail-duration inline-flex shrink-0 items-center gap-1"><Clock3Icon aria-hidden="true" />{node.durationMs} ms</small>
                )}
              </div>
              <AiContentTitle>{node.state === 'failed' || node.state === 'rejected' ? toolDisplaySummary(node, t) : node.summary || node.name}</AiContentTitle>
            </div>
            <div className="ai-detail-sections flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden">
              <DetailCode value={node.input} label={t('ai.workspace.details.input')} />
              <DetailSection
                title={t('ai.workspace.details.output')}
                actions={outputDiff ? undefined : outputCopyAction}
              >
                {node.output === null && !node.error && node.state !== 'failed' && node.state !== 'rejected' && node.state !== 'running'
                  ? <p className="ai-details-empty m-0 py-3 px-3.5 [overflow-wrap:anywhere]">{t('ai.workspace.details.noOutput')}</p>
                  : <AiToolExpandedContent node={node} showCopyActions={false} showInput={false} scrollable={false} diffModel={outputDiff ?? undefined} diffCopyAction={outputDiff ? outputCopyAction : undefined} />}
                {node.error && !toolErrorIsInOutput(node) && <p className="ai-detail-error m-0 py-3 px-3.5 [overflow-wrap:anywhere]">{node.error}</p>}
              </DetailSection>
              {onOpenStoredOutput && (
                <Button type="button" size="xs" variant="outline" className="shrink-0 self-start" onClick={onOpenStoredOutput}>
                  {t('ai.workspace.details.openStoredOutput')}
                </Button>
              )}
              {executionDetails && <DetailCode value={executionDetails} label={t('ai.workspace.details.execution')} />}
              <DetailCode
                value={{
                  effect: node.effect,
                  idempotency: node.idempotency,
                  target: node.target,
                  approval: node.approval,
                  evidenceRefs: node.evidenceRefs,
                }}
                label={t('ai.workspace.details.approval')}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
