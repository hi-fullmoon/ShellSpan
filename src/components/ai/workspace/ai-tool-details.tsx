import { CopyIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { AiRouteHeader } from './ai-route-header';

const DETAIL_PREVIEW_LIMIT = 64 * 1024;

function formatted(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function preview(value: unknown): string {
  const text = formatted(value);
  return text.length > DETAIL_PREVIEW_LIMIT
    ? `${text.slice(0, DETAIL_PREVIEW_LIMIT)}\n…`
    : text;
}

function DetailSection({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function CodeSurface({ value, label }: { readonly value: unknown; readonly label: string }) {
  const { t } = useI18n();
  const text = preview(value);
  return (
    <div className="relative min-w-0 rounded-md border border-border bg-muted/40 p-3">
      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words text-xs">{text}</pre>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 size-8"
              aria-label={t('ai.workspace.details.copy', { section: label })}
              onClick={() => { void navigator.clipboard?.writeText(text); }}
            />
          )}
        >
          <CopyIcon />
        </TooltipTrigger>
        <TooltipContent>{t('common.copy')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function AiToolDetails({
  node,
  onBack,
}: {
  readonly node: AiConversationNodeOf<'tool'> | null;
  readonly onBack: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex size-full min-h-0 min-w-0 flex-col" data-slot="ai-tool-details">
      <AiRouteHeader
        title={node?.name ?? t('ai.workspace.details.toolTitle')}
        description={t('ai.workspace.details.toolDescription')}
        onBack={onBack}
      />
      <ScrollArea className="min-h-0 min-w-0 flex-1" aria-label={t('ai.workspace.details.toolTitle')}>
        <ScrollAreaContent className="flex min-w-0 flex-col gap-4 p-3 @min-[400px]/ai-workspace:p-4 @min-[560px]/ai-workspace:p-5">
          {!node ? (
            <p className="text-sm text-muted-foreground">{t('ai.workspace.details.notInWindow')}</p>
          ) : (
            <>
              <DetailSection title={t('ai.workspace.details.summary')}>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">{node.state}</Badge>
                  <Badge variant="outline">{node.effect}</Badge>
                  {node.durationMs !== null && <Badge variant="outline">{node.durationMs} ms</Badge>}
                </div>
                <p className="break-words text-sm">{node.summary || node.name}</p>
              </DetailSection>
              <Separator />
              <DetailSection title={t('ai.workspace.details.input')}>
                <CodeSurface value={node.input} label={t('ai.workspace.details.input')} />
              </DetailSection>
              <DetailSection title={t('ai.workspace.details.target')}>
                <CodeSurface value={node.target} label={t('ai.workspace.details.target')} />
              </DetailSection>
              <Separator />
              <DetailSection title={t('ai.workspace.details.output')}>
                {node.output === null
                  ? <p className="text-sm text-muted-foreground">{t('ai.workspace.details.noOutput')}</p>
                  : <CodeSurface value={node.output} label={t('ai.workspace.details.output')} />}
                {node.error && <p className="break-words text-sm text-destructive">{node.error}</p>}
              </DetailSection>
              <DetailSection title={t('ai.workspace.details.evidence')}>
                {node.evidenceRefs.length === 0
                  ? <p className="text-sm text-muted-foreground">{t('ai.workspace.details.noEvidence')}</p>
                  : <CodeSurface value={node.evidenceRefs} label={t('ai.workspace.details.evidence')} />}
              </DetailSection>
              <Separator />
              <DetailSection title={t('ai.workspace.details.approval')}>
                <CodeSurface
                  value={{
                    effect: node.effect,
                    idempotency: node.idempotency,
                    approval: node.approval,
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
