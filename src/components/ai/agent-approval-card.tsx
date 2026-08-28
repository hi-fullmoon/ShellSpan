import { useState } from 'react';
import { ShieldAlertIcon } from 'lucide-react';
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
}

export function AgentApprovalDialog({
  open,
  snapshot,
  onOpenChange,
  onApprove,
  onReject,
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
}

export function AgentApprovalCard({
  snapshot,
  onApprove,
  onReject,
}: AgentApprovalCardProps): React.ReactNode {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { approval, riskAssessment, status, toolCall } = snapshot;
  const awaitingApproval = status === 'awaitingApproval' && approval !== undefined;

  return (
    <>
      <Card size="sm" data-slot="agent-approval-card">
        <CardHeader>
          <CardTitle>{t('agent.approval.title')}</CardTitle>
          <CardDescription>{targetLabel(toolCall.target)}</CardDescription>
          <CardAction>
            <Badge variant={statusVariant(status)}>
              {t(`agent.status.${status}` as LocaleKey)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('agent.approval.intent')}
            </span>
            <span>{toolCall.explanation}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('agent.approval.command')}
            </span>
            <code className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 select-text">
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
        </CardContent>
        {awaitingApproval && (
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onReject(approval)}>
              {t('agent.approval.reject')}
            </Button>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              {t('agent.approval.approve')}
            </Button>
          </CardFooter>
        )}
      </Card>
      <AgentApprovalDialog
        open={dialogOpen}
        snapshot={snapshot}
        onOpenChange={setDialogOpen}
        onApprove={onApprove}
        onReject={onReject}
      />
    </>
  );
}
