import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import type {
  ConnectionPreflightResult,
  ConnectionPreflightStep,
  ConnectionPreflightStepStatus,
} from '@/types';

interface ConnectionPreflightDialogProps {
  open: boolean;
  result?: ConnectionPreflightResult;
  error?: string;
  checking: boolean;
  onClose: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onTrust: (host: string, port: number, fingerprint?: string) => void;
}

const STEP_LABELS = {
  dns: 'connection.preflight.step.dns',
  tcp: 'connection.preflight.step.tcp',
  jumpHostKey: 'connection.preflight.step.jumpHostKey',
  jumpAuthentication: 'connection.preflight.step.jumpAuthentication',
  jumpTunnel: 'connection.preflight.step.jumpTunnel',
  hostKey: 'connection.preflight.step.hostKey',
  authentication: 'connection.preflight.step.authentication',
} as const;

function StepIcon({ status }: { status: ConnectionPreflightStepStatus }): React.JSX.Element {
  if (status === 'passed') return <CheckCircle2Icon className="text-emerald-600" />;
  if (status === 'warning') return <AlertTriangleIcon className="text-amber-600" />;
  if (status === 'failed') return <XCircleIcon className="text-destructive" />;
  return <BanIcon className="text-muted-foreground" />;
}

function stepBadgeVariant(
  status: ConnectionPreflightStepStatus,
): 'secondary' | 'outline' | 'destructive' {
  if (status === 'failed') return 'destructive';
  if (status === 'passed') return 'secondary';
  return 'outline';
}

function PreflightStepRow({
  step,
  onTrust,
}: {
  step: ConnectionPreflightStep;
  onTrust: (host: string, port: number, fingerprint?: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const canTrust = step.trustable && step.host && step.port !== undefined;

  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-start gap-2 rounded-lg border border-app-border p-3">
      <StepIcon status={step.status} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t(STEP_LABELS[step.id])}</span>
          <Badge variant={stepBadgeVariant(step.status)}>
            {t(`connection.preflight.status.${step.status}`)}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>
        {step.host && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {step.host}:{step.port}
          </p>
        )}
        {step.fingerprint && (
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
            {step.fingerprint}
          </p>
        )}
      </div>
      {canTrust && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onTrust(step.host!, step.port!, step.fingerprint)}
      >
        <ShieldAlertIcon data-icon="inline-start" />
        {t('connection.preflight.trust')}
        </Button>
      )}
    </li>
  );
}

export function ConnectionPreflightDialog({
  open,
  result,
  error,
  checking,
  onClose,
  onCancel,
  onRetry,
  onTrust,
}: ConnectionPreflightDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const destructive = Boolean(error || result?.status === 'failed');

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <CompactDialogContent>
        <CompactDialogHeader
          title={t('connection.preflight.title')}
          description={t('connection.preflight.description')}
        />

        <CompactDialogBody className="flex flex-col gap-3">
          {checking ? (
            <Alert>
              <LoaderCircleIcon className="animate-spin" />
              <AlertTitle>{t('connection.preflight.checking')}</AlertTitle>
              <AlertDescription>{t('connection.preflight.checkingHint')}</AlertDescription>
            </Alert>
          ) : (
            <Alert variant={destructive ? 'destructive' : 'default'}>
              {destructive ? <XCircleIcon /> : result?.status === 'passed' ? <CheckCircle2Icon /> : <CircleDashedIcon />}
              <AlertTitle>
                {error
                  ? t('connection.preflight.failed')
                  : t(`connection.preflight.result.${result?.status ?? 'cancelled'}`)}
              </AlertTitle>
              <AlertDescription>
                {error ?? t(`connection.preflight.resultHint.${result?.status ?? 'cancelled'}`)}
              </AlertDescription>
            </Alert>
          )}

          {result && (
            <div className="min-h-0">
              <ol className="flex flex-col gap-2">
                {result.steps.map((step) => (
                  <PreflightStepRow key={step.id} step={step} onTrust={onTrust} />
                ))}
              </ol>
              <p className="mt-3 text-[11px] text-muted-foreground">
                {t('connection.preflight.operation')}: {result.operationId}
              </p>
            </div>
          )}
        </CompactDialogBody>

        <CompactDialogFooter>
          {checking ? (
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>
                <XCircleIcon data-icon="inline-start" />
                {t('common.close')}
              </Button>
              <Button size="sm" onClick={onRetry}>
                <RotateCcwIcon data-icon="inline-start" />
                {t('connection.preflight.retry')}
              </Button>
            </>
          )}
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
}
