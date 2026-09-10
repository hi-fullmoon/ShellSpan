import { useEffect, useRef } from 'react';
import { ChevronRightIcon, ShieldAlertIcon } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import type { AgentSessionEffect } from '@/types/agent-session';

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
  return target.label ?? target.host ?? target.targetId;
}

function argumentString(approval: AiPendingApproval, key: string): string | null {
  if (!approval.arguments || typeof approval.arguments !== 'object' || Array.isArray(approval.arguments)) return null;
  const value = (approval.arguments as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isMachinePrompt(value: string): boolean {
  return value.length > 240
    || value.includes('\n')
    || /Session task|Native effect:|Sensitive paths:|Network destinations:|TTL:/i.test(value);
}

function intentLabel(approval: AiPendingApproval): string | null {
  const explanation = argumentString(approval, 'explanation');
  if (explanation) return explanation;
  const prompt = approval.prompt?.trim();
  return prompt && !isMachinePrompt(prompt) ? prompt : null;
}

const APPROVAL_RISK_KEYS = {
  none: {
    label: 'ai.workspace.approval.risk.none',
    description: 'ai.workspace.approval.risk.none.description',
  },
  readOnly: {
    label: 'ai.workspace.approval.risk.readOnly',
    description: 'ai.workspace.approval.risk.readOnly.description',
  },
  sensitiveRead: {
    label: 'ai.workspace.approval.risk.sensitiveRead',
    description: 'ai.workspace.approval.risk.sensitiveRead.description',
  },
  stateChange: {
    label: 'ai.workspace.approval.risk.stateChange',
    description: 'ai.workspace.approval.risk.stateChange.description',
  },
  destructive: {
    label: 'ai.workspace.approval.risk.destructive',
    description: 'ai.workspace.approval.risk.destructive.description',
  },
  externalSideEffect: {
    label: 'ai.workspace.approval.risk.externalSideEffect',
    description: 'ai.workspace.approval.risk.externalSideEffect.description',
  },
  unknown: {
    label: 'ai.workspace.approval.risk.unknown',
    description: 'ai.workspace.approval.risk.unknown.description',
  },
} as const satisfies Record<AgentSessionEffect, { readonly label: LocaleKey; readonly description: LocaleKey }>;

function approvalTitleKey(approval: AiPendingApproval, command: string | null): LocaleKey {
  if (!command) return 'ai.workspace.approval.title';
  return approval.target?.kind === 'remote'
    ? 'ai.workspace.approval.commandTitle.remote'
    : 'ai.workspace.approval.commandTitle.local';
}

function approvalDescriptionKey(approval: AiPendingApproval, command: string | null): LocaleKey {
  if (!command) return 'ai.workspace.approval.description';
  return approval.target?.kind === 'remote'
    ? 'ai.workspace.approval.commandDescription.remote'
    : 'ai.workspace.approval.commandDescription.local';
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
  const command = argumentString(approval, 'command');
  const intent = intentLabel(approval);
  const titleKey = approvalTitleKey(approval, command);
  const descriptionKey = approvalDescriptionKey(approval, command);
  const riskKeys = APPROVAL_RISK_KEYS[approval.risk];
  const destructive = approval.risk === 'destructive';

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [approval.approvalId]);

  return (
    <Card
      className="min-w-0 gap-0 py-0"
      size="sm"
      variant="outline"
      role="group"
      aria-labelledby="ai-approval-title"
      aria-describedby="ai-approval-description"
      data-slot="ai-approval-panel"
      data-approval-id={approval.approvalId}
    >
      <CardHeader className="px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center text-warning" aria-hidden="true">
            <ShieldAlertIcon />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <CardTitle>
              <h3 id="ai-approval-title" ref={headingRef} tabIndex={-1} className="outline-none">
                {t(titleKey, { tool: approval.toolName })}
              </h3>
            </CardTitle>
            <CardDescription id="ai-approval-description">
              {t(descriptionKey, { target: targetLabel(approval) })}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={destructive ? 'destructive' : 'outline'}>{t(riskKeys.label)}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex min-w-0 flex-col gap-2 px-3 pb-2">
        {command && (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.command')}</p>
            <pre className="max-h-28 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground">
              <code>{command}</code>
            </pre>
          </div>
        )}

        {intent && (
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2">
            <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.intent')}</p>
            <p className="break-words text-sm">{intent}</p>
          </div>
        )}

        <Alert
          className="items-center [&>svg]:translate-y-0"
          variant={destructive ? 'destructive' : 'warning'}
          size="sm"
          role="note"
        >
          <ShieldAlertIcon />
          <AlertDescription className="flex flex-wrap items-center gap-x-1">
            <span className="font-medium">{t('ai.workspace.approval.impact')}</span>
            <span>{t(riskKeys.description)}</span>
          </AlertDescription>
        </Alert>

        <Button variant="ghost" size="xs" className="self-start" onClick={onOpenDetails}>
          {t('ai.workspace.approval.fullParameters')}
          <ChevronRightIcon data-icon="inline-end" />
        </Button>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>

      <CardFooter className="grid grid-cols-2 gap-2 px-3 py-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={onReject} aria-label={t('ai.workspace.approval.reject')}>
          {decision === 'reject' && <Spinner data-icon="inline-start" />}
          {t('ai.workspace.approval.reject')}
        </Button>
        <Button size="sm" variant="warning" disabled={pending} onClick={onApprove} aria-label={t('ai.workspace.approval.approveOnce')}>
          {decision === 'approve' && <Spinner data-icon="inline-start" />}
          {t('ai.workspace.approval.approveOnce')}
        </Button>
      </CardFooter>
      <span className="sr-only" aria-live="polite">
        {pending ? t('ai.workspace.approval.pending') : error}
      </span>
    </Card>
  );
}
