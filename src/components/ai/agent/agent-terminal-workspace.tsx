import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BotIcon,
  CircleAlertIcon,
  HandIcon,
  PauseIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SquareIcon,
  SquareTerminalIcon,
  UserIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import {
  AGENT_TERMINAL_PRODUCTION_ADMITTED_V1,
  type AgentTerminalSnapshotV1,
  type TerminalActionSnapshotV1,
  type TerminalApprovalSnapshotV1,
} from '@/lib/agent-terminal-control';
import {
  AgentTerminalXtermV1,
  type AgentTerminalXtermHandleV1,
} from './agent-terminal-xterm';
import {
  canDisplayPendingApprovalV1,
  canReturnAgentTerminalControlV1,
  requiresUserHandoffV1,
  useAgentTerminalV1,
  type AgentTerminalTransportV1,
} from './use-agent-terminal';

function ownerBadgeVariant(owner: AgentTerminalSnapshotV1['leaseOwner']) {
  if (owner === 'agent') return 'default' as const;
  if (owner === 'user') return 'secondary' as const;
  return 'outline' as const;
}

function riskBadgeVariant(action?: TerminalActionSnapshotV1) {
  if (action?.risk?.severity === 'critical') return 'destructive' as const;
  if (action?.risk?.severity === 'medium') return 'secondary' as const;
  return 'outline' as const;
}

function latestAction(snapshot: AgentTerminalSnapshotV1): TerminalActionSnapshotV1 | undefined {
  return snapshot.actions[snapshot.actions.length - 1];
}

function latestUnknownEffect(snapshot: AgentTerminalSnapshotV1): TerminalActionSnapshotV1 | undefined {
  return [...snapshot.actions].reverse().find((action) => action.state === 'unknownEffect');
}

function formatRemainingTtl(expiresAtMs: number, nowMs: number): string {
  return String(Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000)));
}

function SnapshotDetails({
  snapshot,
  action,
}: {
  snapshot: AgentTerminalSnapshotV1;
  action?: TerminalActionSnapshotV1;
}): React.JSX.Element {
  const { t } = useI18n();
  const verification = action?.verification;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('ai.agentTerminal.statusTitle')}</CardTitle>
        <CardDescription className="truncate" title={snapshot.sessionId}>
          {t('ai.agentTerminal.boundSession', { session: snapshot.sessionId })}
        </CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1">
          <Badge variant={ownerBadgeVariant(snapshot.leaseOwner)}>
            {snapshot.leaseOwner === 'agent' ? <BotIcon /> : <UserIcon />}
            {t(`ai.agentTerminal.owner.${snapshot.leaseOwner}` as Parameters<typeof t>[0])}
          </Badge>
          <Badge variant="outline">
            {t('ai.agentTerminal.preview')}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">{t('ai.agentTerminal.controlState')}</dt>
          <dd className="text-right font-medium">
            {t(`ai.agentTerminal.control.${snapshot.controlState}` as Parameters<typeof t>[0])}
          </dd>
          <dt className="text-muted-foreground">{t('ai.agentTerminal.leaseAuthority')}</dt>
          <dd className="text-right font-mono">
            {t(`ai.agentTerminal.lease.${snapshot.leaseState}` as Parameters<typeof t>[0])}
            {' · '}{snapshot.leaseEpoch}/{snapshot.leaseRevision}
          </dd>
          <dt className="text-muted-foreground">{t('ai.agentTerminal.captureEpoch')}</dt>
          <dd className="text-right font-mono">{snapshot.captureEpoch}</dd>
          <dt className="text-muted-foreground">{t('ai.agentTerminal.currentAction')}</dt>
          <dd className="max-w-48 truncate text-right" title={action?.actionKind}>
            {action?.actionKind ?? t('ai.agentTerminal.noAction')}
          </dd>
          {action && (
            <>
              <dt className="text-muted-foreground">{t('ai.agentTerminal.actionState')}</dt>
              <dd className="text-right">
                <Badge variant="outline">
                  {t(`ai.agentTerminal.action.${action.state}` as Parameters<typeof t>[0])}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">{t('ai.agentTerminal.risk')}</dt>
              <dd className="text-right">
                {action.risk ? (
                  <Badge variant={riskBadgeVariant(action)}>
                    {t(`ai.agentTerminal.risk.${action.risk.severity}` as Parameters<typeof t>[0])}
                  </Badge>
                ) : t('ai.agentTerminal.riskPending')}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">{t('ai.agentTerminal.verification')}</dt>
          <dd className="max-w-48 text-right">
            {verification
              ? t('ai.agentTerminal.verificationState', {
                state: t(`ai.agentTerminal.verification.${verification.state}` as Parameters<typeof t>[0]),
                independent: verification.independent
                  ? t('ai.agentTerminal.independent')
                  : t('ai.agentTerminal.notIndependent'),
              })
              : t('ai.agentTerminal.noVerification')}
          </dd>
        </dl>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        {t('ai.agentTerminal.leaseDisplayOnly')}
      </CardFooter>
    </Card>
  );
}

function ApprovalCard({
  snapshot,
  approval,
  nowMs,
  pending,
  onDecision,
}: {
  snapshot: AgentTerminalSnapshotV1;
  approval: TerminalApprovalSnapshotV1;
  nowMs: number;
  pending: boolean;
  onDecision: (decision: 'approve' | 'reject') => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [decision, setDecision] = useState<'approve' | 'reject'>();
  const observation = snapshot.currentObservation;
  const action = snapshot.actions.find((candidate) => candidate.actionId === approval.actionId);
  return (
    <>
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t('ai.agentTerminal.approvalTitle')}</CardTitle>
          <CardDescription>
            {t('ai.agentTerminal.approvalTtl', {
              seconds: formatRemainingTtl(approval.expiresAtMs, nowMs),
            })}
          </CardDescription>
          <CardAction>
            <Badge variant={approval.risk.severity === 'critical' ? 'destructive' : 'secondary'}>
              {t(`ai.agentTerminal.risk.${approval.risk.severity}` as Parameters<typeof t>[0])}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t('ai.agentTerminal.approvalTarget')}</dt>
            <dd className="truncate font-mono" title={approval.targetDigest}>{approval.targetDigest}</dd>
            <dt className="text-muted-foreground">{t('ai.agentTerminal.approvalAction')}</dt>
            <dd className="truncate font-mono" title={`${action?.actionKind} · ${approval.actionId}`}>
              {action?.actionKind} · {approval.actionId}
            </dd>
            <dt className="text-muted-foreground">{t('ai.agentTerminal.actionDigest')}</dt>
            <dd className="truncate font-mono" title={approval.actionDigest}>{approval.actionDigest}</dd>
            <dt className="text-muted-foreground">{t('ai.agentTerminal.approvalDriver')}</dt>
            <dd className="truncate font-mono">{approval.driver}</dd>
            <dt className="text-muted-foreground">{t('ai.agentTerminal.approvalProgram')}</dt>
            <dd className="truncate font-mono">{approval.program}</dd>
            <dt className="text-muted-foreground">{t('ai.agentTerminal.approvalScenario')}</dt>
            <dd className="font-mono">{approval.scenario}</dd>
            <dt className="text-muted-foreground">{t('ai.agentTerminal.approvalRisk')}</dt>
            <dd className="truncate font-mono" title={approval.risk.riskDigest}>
              {approval.risk.severity} · {approval.risk.verdict} · {
                approval.risk.stateChange
                  ? t('ai.agentTerminal.stateChangeYes')
                  : t('ai.agentTerminal.stateChangeNo')
              }
            </dd>
            <dt className="text-muted-foreground">{t('ai.agentTerminal.riskDigest')}</dt>
            <dd className="truncate font-mono" title={approval.risk.riskDigest}>
              {approval.risk.riskDigest}
            </dd>
            <dt className="text-muted-foreground">{t('ai.agentTerminal.observationDigest')}</dt>
            <dd className="truncate font-mono" title={approval.observationDigest}>
              {approval.observationDigest}
            </dd>
          </dl>
          <Separator />
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium">{t('ai.agentTerminal.observationPreview')}</p>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
              {observation?.redactedTranscript}
            </pre>
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setDecision('reject')}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {t('ai.agentTerminal.reject')}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => setDecision('approve')}>
            {pending && <Spinner data-icon="inline-start" />}
            {t('ai.agentTerminal.approve')}
          </Button>
        </CardFooter>
      </Card>
      <AlertDialog open={decision !== undefined} onOpenChange={(open) => {
        if (!open) setDecision(undefined);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {decision === 'approve'
                ? t('ai.agentTerminal.approveConfirmTitle')
                : t('ai.agentTerminal.rejectConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('ai.agentTerminal.approvalConfirmDescription', {
                action: approval.actionId,
                target: approval.targetDigest,
                seconds: formatRemainingTtl(approval.expiresAtMs, nowMs),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant={decision === 'reject' ? 'destructive' : 'default'}
              onClick={() => {
                if (decision) onDecision(decision);
                setDecision(undefined);
              }}
            >
              {decision === 'approve'
                ? t('ai.agentTerminal.approve')
                : t('ai.agentTerminal.reject')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function AgentTerminalWorkspace({
  runId,
  transport,
}: {
  runId?: string;
  transport?: AgentTerminalTransportV1;
}): React.JSX.Element {
  const { t } = useI18n();
  const xtermRef = useRef<AgentTerminalXtermHandleV1>(null);
  const [takeoverDialogOpen, setTakeoverDialogOpen] = useState(false);
  const [returnDialogOpen, setReturnDialogOpen] = useState(false);
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [takeoverArmed, setTakeoverArmed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const onControlError = useCallback(() => {
    toast.error(t('ai.agentTerminal.controlFailed'));
  }, [t]);
  const {
    snapshot,
    status,
    projectionError,
    refreshHint,
    pendingAction,
    inputPending,
    resync,
    sendUserInput,
    resolveApproval,
    returnControl,
    pause,
    stop,
  } = useAgentTerminalV1({ runId, transport, onControlError });

  const action = snapshot ? latestAction(snapshot) : undefined;
  const unknownEffect = snapshot ? latestUnknownEffect(snapshot) : undefined;
  const handoffRequired = snapshot ? requiresUserHandoffV1(snapshot) : false;
  const effectiveNowMs = Math.max(nowMs, Date.now());
  const approvalVisible = snapshot
    ? status === 'ready'
      && !refreshHint
      && canDisplayPendingApprovalV1(snapshot, effectiveNowMs)
    : false;
  const authorityReady = status === 'ready' && !refreshHint;
  const canReturn = snapshot
    ? authorityReady && canReturnAgentTerminalControlV1(snapshot)
    : false;
  const inputDisabled = !snapshot
    || !authorityReady
    || ['stopped', 'disconnected', 'paused'].includes(snapshot.controlState)
    || (inputPending && snapshot.leaseOwner !== 'user');

  useEffect(() => {
    if (!snapshot?.pendingApproval) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot?.pendingApproval]);

  const expiredApprovalIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const approval = snapshot?.pendingApproval;
    if (!approval || nowMs < approval.expiresAtMs) return;
    if (expiredApprovalIdRef.current === approval.approvalId) return;
    expiredApprovalIdRef.current = approval.approvalId;
    void resync('approvalExpired');
  }, [nowMs, resync, snapshot?.pendingApproval]);

  const handleTerminalData = useCallback((data: string): void => {
    setTakeoverArmed(false);
    sendUserInput(data);
  }, [sendUserInput]);

  const handleTransportHint = useCallback((hint: string): void => {
    void resync(`transport:${hint}`);
  }, [resync]);

  const liveStatus = useMemo(() => {
    if (!snapshot) return t('ai.agentTerminal.unavailableTitle');
    if (inputPending) return t('ai.agentTerminal.inputPending');
    if (snapshot.controlState === 'user') return t('ai.agentTerminal.youControl');
    if (handoffRequired) return t('ai.agentTerminal.handoffTitle');
    return t(`ai.agentTerminal.control.${snapshot.controlState}` as Parameters<typeof t>[0]);
  }, [handoffRequired, inputPending, snapshot, t]);

  if (!runId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        <Alert>
          <SquareTerminalIcon />
          <AlertTitle>{t('ai.agentTerminal.previewTitle')}</AlertTitle>
          <AlertDescription>{t('ai.agentTerminal.noRunDescription')}</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>{t('ai.agentTerminal.gateClosedTitle')}</AlertTitle>
          <AlertDescription>{t('ai.agentTerminal.gateClosedDescription')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!snapshot && status === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="min-h-48 flex-1 w-full" />
        <span className="sr-only">{t('ai.agentTerminal.loading')}</span>
      </div>
    );
  }

  if (!snapshot || status === 'unavailable' || status === 'failed') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        <Alert variant={status === 'failed' ? 'destructive' : 'default'}>
          <CircleAlertIcon />
          <AlertTitle>{t('ai.agentTerminal.unavailableTitle')}</AlertTitle>
          <AlertDescription>
            {projectionError?.message ?? t('ai.agentTerminal.unavailableDescription')}
          </AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>{t('ai.agentTerminal.gateClosedTitle')}</AlertTitle>
          <AlertDescription>{t('ai.agentTerminal.gateClosedDescription')}</AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" onClick={() => void resync('manual')}>
          <RefreshCwIcon data-icon="inline-start" />
          {t('ai.agentTerminal.refresh')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      {!AGENT_TERMINAL_PRODUCTION_ADMITTED_V1 && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>{t('ai.agentTerminal.gateClosedTitle')}</AlertTitle>
          <AlertDescription>{t('ai.agentTerminal.gateClosedDescription')}</AlertDescription>
        </Alert>
      )}

      {unknownEffect && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{t('ai.agentTerminal.unknownEffectTitle')}</AlertTitle>
          <AlertDescription>
            {t('ai.agentTerminal.unknownEffectDescription', { action: unknownEffect.actionId })}
          </AlertDescription>
        </Alert>
      )}

      {handoffRequired && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>{t('ai.agentTerminal.handoffTitle')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            <p>{t('ai.agentTerminal.handoffDescription', {
              prompt: snapshot.currentObservation?.promptClass ?? 'unknown',
              surface: snapshot.currentObservation?.surface ?? 'unknown',
            })}</p>
            <p>{t('ai.agentTerminal.handoffPrivacy')}</p>
            <p>{t('ai.agentTerminal.handoffNoApproval')}</p>
          </AlertDescription>
        </Alert>
      )}

      {snapshot.controlState === 'user' && (
        <Alert>
          <UserIcon />
          <AlertTitle>{t('ai.agentTerminal.youControl')}</AlertTitle>
          <AlertDescription>{t('ai.agentTerminal.userOutputIsolated')}</AlertDescription>
        </Alert>
      )}

      {action?.actionKind === 'terminal.returnControl' && action.state === 'completed' && (
        <Alert>
          <RotateCcwIcon />
          <AlertTitle>{t('ai.agentTerminal.captureRotatedTitle')}</AlertTitle>
          <AlertDescription>{t('ai.agentTerminal.captureRotatedDescription', {
            epoch: snapshot.captureEpoch,
          })}</AlertDescription>
        </Alert>
      )}

      <SnapshotDetails snapshot={snapshot} action={action} />

      {snapshot.currentObservation && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t('ai.agentTerminal.observationTitle')}</CardTitle>
            <CardDescription>{t('ai.agentTerminal.observationUntrusted')}</CardDescription>
            <CardAction>
              <Badge variant="outline">{t('ai.agentTerminal.untrusted')}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              <Badge variant="outline">{snapshot.currentObservation.surface}</Badge>
              <Badge variant="outline">{snapshot.currentObservation.promptClass}</Badge>
              {snapshot.currentObservation.truncated && (
                <Badge variant="secondary">{t('ai.agentTerminal.truncated')}</Badge>
              )}
            </div>
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
              {snapshot.currentObservation.redactedTranscript}
            </pre>
          </CardContent>
          <CardFooter className="truncate font-mono text-xs text-muted-foreground">
            {snapshot.currentObservation.transcriptDigest}
          </CardFooter>
        </Card>
      )}

      {snapshot.pendingApproval && !approvalVisible && !handoffRequired && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{t('ai.agentTerminal.approvalUnavailableTitle')}</AlertTitle>
          <AlertDescription>{t('ai.agentTerminal.approvalUnavailableDescription')}</AlertDescription>
        </Alert>
      )}

      {approvalVisible && snapshot.pendingApproval && (
        <ApprovalCard
          snapshot={snapshot}
          approval={snapshot.pendingApproval}
          nowMs={effectiveNowMs}
          pending={pendingAction === 'approval'}
          onDecision={(decision) => void resolveApproval(
            snapshot.pendingApproval!.approvalId,
            decision,
          )}
        />
      )}

      <Card size="sm" className="min-h-64 flex-1">
        <CardHeader>
          <CardTitle>{t('ai.agentTerminal.terminalTitle')}</CardTitle>
          <CardDescription>
            {snapshot.leaseOwner === 'agent'
              ? t('ai.agentTerminal.typeToTakeover')
              : t('ai.agentTerminal.localInputOnly')}
          </CardDescription>
          <CardAction className="flex flex-wrap justify-end gap-1">
            <Badge variant={ownerBadgeVariant(snapshot.leaseOwner)}>
              {t(`ai.agentTerminal.owner.${snapshot.leaseOwner}` as Parameters<typeof t>[0])}
            </Badge>
            {refreshHint && <Badge variant="outline">{t('ai.agentTerminal.resyncing')}</Badge>}
          </CardAction>
        </CardHeader>
        <CardContent className="min-h-48 flex-1">
          <AgentTerminalXtermV1
            ref={xtermRef}
            sessionId={snapshot.sessionId}
            disabled={inputDisabled}
            ariaLabel={t('ai.agentTerminal.terminalAriaLabel')}
            onData={handleTerminalData}
            onTransportHint={handleTransportHint}
          />
        </CardContent>
        <CardFooter className="flex flex-wrap justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {takeoverArmed
              ? t('ai.agentTerminal.takeoverArmed')
              : t('ai.agentTerminal.noGenericWrite')}
          </div>
          <div className="flex flex-wrap gap-2">
            {snapshot.leaseOwner !== 'user' && !inputDisabled && (
              <Button
                variant="secondary"
                size="sm"
                disabled={inputPending}
                onClick={() => setTakeoverDialogOpen(true)}
              >
                {inputPending ? <Spinner data-icon="inline-start" /> : <HandIcon data-icon="inline-start" />}
                {t('ai.agentTerminal.takeoverNow')}
              </Button>
            )}
            {snapshot.leaseOwner === 'user' && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canReturn || pendingAction !== undefined || inputPending}
                onClick={() => setReturnDialogOpen(true)}
              >
                <RotateCcwIcon data-icon="inline-start" />
                {t('ai.agentTerminal.returnControl')}
              </Button>
            )}
          </div>
        </CardFooter>
      </Card>

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => void resync('manual')}>
          <RefreshCwIcon data-icon="inline-start" />
          {t('ai.agentTerminal.refresh')}
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={
              !authorityReady
              || pendingAction !== undefined
              || ['stopped', 'disconnected'].includes(snapshot.controlState)
            }
            onClick={() => void pause()}
          >
            {pendingAction === 'pause'
              ? <Spinner data-icon="inline-start" />
              : <PauseIcon data-icon="inline-start" />}
            {t('ai.agentTerminal.pause')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!authorityReady || pendingAction !== undefined || snapshot.controlState === 'stopped'}
            onClick={() => setStopDialogOpen(true)}
          >
            <SquareIcon data-icon="inline-start" />
            {t('ai.agentTerminal.stop')}
          </Button>
        </div>
      </div>

      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveStatus}
      </span>

      <AlertDialog open={takeoverDialogOpen} onOpenChange={setTakeoverDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ai.agentTerminal.takeoverConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('ai.agentTerminal.takeoverConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setTakeoverDialogOpen(false);
              setTakeoverArmed(true);
              window.setTimeout(() => xtermRef.current?.focus(), 0);
            }}>
              {t('ai.agentTerminal.takeoverAndFocus')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={returnDialogOpen} onOpenChange={setReturnDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ai.agentTerminal.returnConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('ai.agentTerminal.returnConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={!canReturn} onClick={() => {
              setReturnDialogOpen(false);
              void returnControl();
            }}>
              {t('ai.agentTerminal.returnControl')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={stopDialogOpen} onOpenChange={setStopDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ai.agentTerminal.stopConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('ai.agentTerminal.stopConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              setStopDialogOpen(false);
              void stop();
            }}>
              {pendingAction === 'stop' && <Spinner data-icon="inline-start" />}
              {t('ai.agentTerminal.stop')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
