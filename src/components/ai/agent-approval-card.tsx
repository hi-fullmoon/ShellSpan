import { useState } from 'react';
import {
  CheckIcon,
  CopyIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SquareIcon,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import type {
  AgentApprovalReference,
  AgentRisk,
  AgentTargetSnapshot,
  AgentToolApprovalSnapshot,
  AgentToolApprovalStatus,
} from '@/types/agent';

function targetLabel(target: AgentTargetSnapshot): string {
  return `${target.username}@${target.host}:${target.port} · ${target.sessionId}`;
}

const OUTPUT_SUMMARY_LIMIT = 2_000;

export function summarizeAgentToolOutput(output: string): string {
  if (output.length <= OUTPUT_SUMMARY_LIMIT) return output;
  const half = Math.floor(OUTPUT_SUMMARY_LIMIT / 2);
  return `${output.slice(0, half)}\n[… output summary truncated …]\n${output.slice(-half)}`;
}

function riskVariant(risk: AgentRisk): 'secondary' | 'destructive' {
  return risk === 'destructive' ? 'destructive' : 'secondary';
}

function statusVariant(status: AgentToolApprovalStatus): 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed' || status === 'timedOut' || status === 'cancelled') return 'destructive';
  return status === 'completed' ? 'outline' : 'secondary';
}

export interface AgentApprovalDialogProps {
  readonly open: boolean;
  readonly snapshot: AgentToolApprovalSnapshot;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApprove: (reference: AgentApprovalReference) => void;
  readonly onReject: (reference: AgentApprovalReference) => void;
  readonly targetTitle?: string;
}

export function AgentApprovalDialog({
  open,
  snapshot,
  onOpenChange,
  onApprove,
  onReject,
  targetTitle,
}: AgentApprovalDialogProps): React.ReactNode {
  const { t } = useI18n();
  const { approval, riskAssessment, toolCall } = snapshot;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <ShieldAlertIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>{t('agent.approval.dialogTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('agent.approval.dialogDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('agent.approval.target')}
            </span>
            {targetTitle && <span className="text-foreground">{targetTitle}</span>}
            <code className="break-all text-foreground">{targetLabel(toolCall.target)}</code>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('agent.approval.command')}
            </span>
            <code className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-foreground select-text">
              {toolCall.command}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t('agent.approval.risk')}
            </span>
            <Badge variant={riskVariant(riskAssessment.risk)}>
              {t(`agent.risk.${riskAssessment.risk}` as LocaleKey)}
            </Badge>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              if (approval) onReject(approval);
            }}
          >
            {t('agent.approval.reject')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!approval}
            onClick={() => {
              if (approval) onApprove(approval);
              onOpenChange(false);
            }}
          >
            {t('agent.approval.approve')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface AgentApprovalCardProps {
  readonly snapshot: AgentToolApprovalSnapshot;
  readonly onApprove: (reference: AgentApprovalReference) => void;
  readonly onReject: (reference: AgentApprovalReference) => void;
  readonly targetTitle?: string;
  readonly onStop?: () => void;
  readonly onRetry?: () => void;
  readonly retryAllowed?: boolean;
}

export function AgentApprovalCard({
  snapshot,
  onApprove,
  onReject,
  targetTitle,
  onStop,
  onRetry,
  retryAllowed = false,
}: AgentApprovalCardProps): React.ReactNode {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { approval, result, riskAssessment, status, toolCall } = snapshot;
  const awaitingApproval = status === 'awaitingApproval' && approval !== undefined;
  const stoppable = status === 'pending' || status === 'awaitingApproval' || status === 'running';
  const retryable = retryAllowed && [
    'rejected',
    'failed',
    'timedOut',
    'cancelled',
  ].includes(status);
  const outputSummary = result ? summarizeAgentToolOutput(result.output) : undefined;

  const copyCommand = (): void => {
    void navigator.clipboard?.writeText(toolCall.command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => undefined);
  };

  return (
    <>
      <Card size="sm" data-slot="agent-approval-card">
        <CardHeader>
          <CardTitle>{t('agent.tool.title')}</CardTitle>
          {targetTitle && (
            <CardDescription className="truncate">{targetTitle}</CardDescription>
          )}
          <CardAction>
            <Badge variant={statusVariant(status)} role="status">
              {t(`agent.status.${status}` as LocaleKey)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <dl className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <dt className="text-xs font-medium text-muted-foreground">
                {t('agent.approval.target')}
              </dt>
              <dd className="flex min-w-0 flex-col gap-0.5">
                {targetTitle && <span>{targetTitle}</span>}
                <code className="break-all">{targetLabel(toolCall.target)}</code>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-muted-foreground">
              {t('agent.approval.intent')}
            </dt>
            <dd>{toolCall.explanation}</dd>
            </div>
            <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-muted-foreground">
              {t('agent.approval.command')}
            </dt>
            <dd className="flex min-w-0 flex-col gap-1.5">
              <code className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 select-text">
                {toolCall.command}
              </code>
              <Button
                variant="ghost"
                size="xs"
                className="self-start"
                onClick={copyCommand}
                aria-label={t('agent.tool.copyCommand')}
              >
                {copied
                  ? <CheckIcon data-icon="inline-start" />
                  : <CopyIcon data-icon="inline-start" />}
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
            </dd>
            </div>
            <div className="flex items-center gap-2">
            <dt className="text-xs font-medium text-muted-foreground">
              {t('agent.approval.risk')}
            </dt>
            <dd><Badge variant={riskVariant(riskAssessment.risk)}>
              {t(`agent.risk.${riskAssessment.risk}` as LocaleKey)}
            </Badge></dd>
            </div>
            {result && (
              <div className="flex flex-col gap-1">
                <dt className="text-xs font-medium text-muted-foreground">
                  {t('agent.tool.result')}
                </dt>
                <dd className="flex min-w-0 flex-col gap-1.5">
                  <span>
                    {t('agent.tool.exitCode')}: {result.exitCode ?? t('agent.tool.notAvailable')}
                  </span>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">
                    {outputSummary || t('agent.tool.noOutput')}
                  </pre>
                </dd>
              </div>
            )}
          </dl>
        </CardContent>
        {(awaitingApproval || (stoppable && onStop) || (retryable && onRetry)) && (
          <CardFooter className="justify-end gap-2">
            {awaitingApproval && (
              <>
                <Button variant="outline" size="sm" onClick={() => onReject(approval)}>
                  {t('agent.approval.reject')}
                </Button>
                <Button size="sm" onClick={() => setDialogOpen(true)}>
                  {t('agent.approval.approve')}
                </Button>
              </>
            )}
            {stoppable && onStop && (
              <Button variant="destructive" size="sm" onClick={onStop}>
                <SquareIcon data-icon="inline-start" />
                {t('agent.tool.stop')}
              </Button>
            )}
            {retryable && onRetry && (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                <RotateCcwIcon data-icon="inline-start" />
                {t('agent.tool.retryTask')}
              </Button>
            )}
          </CardFooter>
        )}
      </Card>
      <AgentApprovalDialog
        open={dialogOpen}
        snapshot={snapshot}
        onOpenChange={setDialogOpen}
        onApprove={onApprove}
        onReject={onReject}
        targetTitle={targetTitle}
      />
    </>
  );
}
