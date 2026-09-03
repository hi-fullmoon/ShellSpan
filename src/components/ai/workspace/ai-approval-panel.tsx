import { useEffect, useRef } from 'react';
import { EyeIcon, ShieldAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';

export interface AiApprovalPanelProps {
  readonly approval: AiPendingApproval;
  readonly decision: 'approve' | 'reject' | null;
  readonly error: string | null;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onOpenDetails: () => void;
}

function targetLabel(approval: AiPendingApproval): string {
  const target = approval.target;
  if (!target) return approval.callId;
  return target.label ?? target.targetId;
}

export function AiApprovalPanel({
  approval,
  decision,
  error,
  onApprove,
  onReject,
  onOpenDetails,
}: AiApprovalPanelProps): React.ReactNode {
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pending = decision !== null;

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [approval.approvalId]);

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-xs"
      role="group"
      aria-labelledby="ai-approval-title"
      aria-describedby="ai-approval-description"
      data-slot="ai-approval-panel"
      data-approval-id={approval.approvalId}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center text-warning" aria-hidden="true">
          <ShieldAlertIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="ai-approval-title" ref={headingRef} tabIndex={-1} className="font-medium outline-none">
            {t('ai.workspace.approval.title', { tool: approval.toolName })}
          </h3>
          <p id="ai-approval-description" className="text-sm text-muted-foreground">
            {approval.reason ?? approval.prompt ?? t('ai.workspace.approval.description')}
          </p>
        </div>
        <Badge variant="outline">{approval.effect}</Badge>
      </div>

      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('ai.workspace.approval.target')}</dt>
        <dd className="min-w-0 break-words">{targetLabel(approval)}</dd>
        <dt className="text-muted-foreground">{t('ai.workspace.approval.intent')}</dt>
        <dd className="min-w-0 break-words">{approval.prompt ?? approval.reason ?? approval.toolName}</dd>
        <dt className="text-muted-foreground">{t('ai.workspace.approval.risk')}</dt>
        <dd className="min-w-0 break-words">{approval.risk}</dd>
      </dl>

      <Button variant="ghost" size="sm" className="self-start" onClick={onOpenDetails}>
        <EyeIcon data-icon="inline-start" />
        {t('ai.workspace.approval.fullParameters')}
      </Button>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" disabled={pending} onClick={onReject} aria-label={t('ai.workspace.approval.reject')}>
          {decision === 'reject' && <Spinner data-icon="inline-start" />}
          {t('ai.workspace.approval.reject')}
        </Button>
        <Button variant="warning" disabled={pending} onClick={onApprove} aria-label={t('ai.workspace.approval.approveOnce')}>
          {decision === 'approve' && <Spinner data-icon="inline-start" />}
          {t('ai.workspace.approval.approveOnce')}
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">
        {pending ? t('ai.workspace.approval.pending') : error}
      </span>
    </section>
  );
}
