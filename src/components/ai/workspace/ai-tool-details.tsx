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
    <section className="ai-detail-section">
      <div className="ai-detail-section-header">
        <h3>{title}</h3>
        {actions}
      </div>
      {children}
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
      <pre className="ai-detail-code"><code>{text}</code></pre>
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
    <div className="ai-details-root" data-slot="ai-tool-details">
      <AiRouteHeader
        title={node?.name ?? t('ai.workspace.details.toolTitle')}
        description={t('ai.workspace.details.toolDescription')}
        onBack={onBack}
        onClose={onClose}
      />
      <ScrollArea className="min-h-0 min-w-0 flex-1" aria-label={t('ai.workspace.details.toolTitle')}>
        {/* Override Base UI's inline fit-content minimum so long payloads stay inside the viewport. */}
        <ScrollAreaContent className="ai-details-body" style={{ minWidth: 0 }}>
          {!node ? (
            <p className="ai-details-empty">{t('ai.workspace.details.notInWindow')}</p>
          ) : (
            <>
              <div className="ai-detail-summary" data-state={node.state}>
                <div className="ai-detail-summary-meta">
                  <Badge variant={node.state === 'failed' || node.state === 'rejected' ? 'destructive' : 'secondary'}>
                    <ToolStateIcon node={node} />
                    {t(`ai.workspace.tool.${node.state}`)}
                  </Badge>
                  {node.durationMs !== null && (
                    <small className="ai-detail-duration"><Clock3Icon aria-hidden="true" />{node.durationMs} ms</small>
                  )}
                </div>
                <p>{node.summary || node.name}</p>
              </div>
              <DetailCode value={node.input} label={t('ai.workspace.details.input')} />
              <DetailSection title={t('ai.workspace.details.output')}>
                {node.output === null && node.state !== 'running'
                  ? <p className="ai-details-empty">{t('ai.workspace.details.noOutput')}</p>
                  : <AiToolExpandedContent node={node} />}
                {node.error && <p className="ai-detail-error">{node.error}</p>}
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
            </>
          )}
        </ScrollAreaContent>
      </ScrollArea>
    </div>
  );
}
