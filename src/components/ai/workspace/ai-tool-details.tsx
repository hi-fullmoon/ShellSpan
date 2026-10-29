import { Clock3Icon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { AiRouteHeader } from './ai-route-header';
import {
  AiToolExpandedContent,
  AiToolCopyButton,
  ToolStateIcon,
  formatToolValue,
  toolOutputForCopy,
  toolDisplaySummary,
  toolErrorIsInOutput,
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
    <section className="ai-detail-section flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="ai-detail-section-header relative flex min-h-10 shrink-0 items-center justify-between gap-3 px-3 py-2 pr-12 [&>.ai-tool-copy-button]:right-3">
        <h3>{title}</h3>
        {actions}
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1" horizontal aria-label={title}>
        {/* Base UI's fit-content minimum must not widen long tool payloads. */}
        <ScrollAreaContent className="min-w-0" style={{ minWidth: 0 }}>
          {children}
        </ScrollAreaContent>
      </ScrollArea>
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
      <pre className="ai-detail-code m-0 min-w-0 max-w-full px-3.5 py-3 whitespace-pre-wrap break-words"><code>{text}</code></pre>
    </DetailSection>
  );
}

export function AiToolDetails({
  node,
  onBack,
  onClose,
}: {
  readonly node: AiConversationNodeOf<'tool'> | null;
  readonly onBack: () => void;
  readonly onClose?: () => void;
}): React.ReactNode {
  const { t } = useI18n();
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
              <ScrollArea className="min-h-0 min-w-0" aria-label={t('ai.workspace.details.summary')}>
                <ScrollAreaContent className="min-w-0" style={{ minWidth: 0 }}>
                  <p className="m-0 [overflow-wrap:anywhere]">{node.state === 'failed' || node.state === 'rejected' ? toolDisplaySummary(node, t) : node.summary || node.name}</p>
                </ScrollAreaContent>
              </ScrollArea>
            </div>
            <div className="ai-detail-sections grid min-h-0 min-w-0 flex-1 grid-rows-3 gap-2">
              <DetailCode value={node.input} label={t('ai.workspace.details.input')} />
              <DetailSection
                title={t('ai.workspace.details.output')}
                actions={toolOutputForCopy(node) ? (
                  <AiToolCopyButton
                    text={toolOutputForCopy(node)}
                    label={t('ai.workspace.details.copy', { section: t('ai.workspace.details.output') })}
                  />
                ) : undefined}
              >
                {node.output === null && !node.error && node.state !== 'failed' && node.state !== 'rejected' && node.state !== 'running'
                  ? <p className="ai-details-empty m-0 py-3 px-3.5 [overflow-wrap:anywhere]">{t('ai.workspace.details.noOutput')}</p>
                  : <AiToolExpandedContent node={node} showCopyActions={false} showGenericInput={false} />}
                {node.error && !toolErrorIsInOutput(node) && <p className="ai-detail-error m-0 py-3 px-3.5 [overflow-wrap:anywhere]">{node.error}</p>}
              </DetailSection>
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
