import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { AiRouteHeader } from './ai-route-header';
import {
  AiToolExpandedContent,
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

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
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
            aria-label={copied ? t('common.copied') : label}
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

function DetailSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="ai-detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function DetailCode({ value, label }: { readonly value: unknown; readonly label: string }) {
  const { t } = useI18n();
  const text = preview(value);
  return (
    <div className="ai-detail-code-wrap">
      <pre className="ai-detail-code">{text}</pre>
      <CopyButton text={text} label={t('ai.workspace.details.copy', { section: label })} />
    </div>
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
        <ScrollAreaContent className="ai-details-body">
          {!node ? (
            <p className="ai-details-empty">{t('ai.workspace.details.notInWindow')}</p>
          ) : (
            <>
              <div className="ai-detail-summary" data-state={node.state}>
                <ToolStateIcon node={node} />
                <span>{node.summary || node.name}</span>
                <small>{t(`ai.workspace.tool.${node.state}`)}</small>
                {node.durationMs !== null && <small>{node.durationMs} ms</small>}
              </div>
              <DetailSection title={t('ai.workspace.details.input')}>
                <DetailCode value={node.input} label={t('ai.workspace.details.input')} />
              </DetailSection>
              <DetailSection title={t('ai.workspace.details.output')}>
                {node.output === null && node.state !== 'running'
                  ? <p className="ai-details-empty">{t('ai.workspace.details.noOutput')}</p>
                  : <AiToolExpandedContent node={node} />}
                {node.error && <p className="ai-detail-error">{node.error}</p>}
              </DetailSection>
              <DetailSection title={t('ai.workspace.details.approval')}>
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
              </DetailSection>
            </>
          )}
        </ScrollAreaContent>
      </ScrollArea>
    </div>
  );
}
