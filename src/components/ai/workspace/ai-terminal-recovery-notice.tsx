import { TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type { TerminalExecutionRecovery } from '@/lib/ai/terminal-execution-recovery';

export function AiTerminalRecoveryNotice({ id, recovery, stopping, reconnecting, onStop, onReconnect }: {
  readonly id?: string;
  readonly recovery: TerminalExecutionRecovery;
  readonly stopping: boolean;
  readonly reconnecting: boolean;
  readonly onStop?: () => void;
  readonly onReconnect?: () => void;
}) {
  const { t } = useI18n();
  return <Alert id={id} variant="warning" size="sm" role="status" aria-label={t('ai.workspace.terminalRecovery.title')}
    data-terminal-recovery-notice="">
    <TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{t('ai.workspace.terminalRecovery.title')}</AlertTitle>
    <AlertDescription className="flex min-w-0 flex-col gap-1">
      <span>{t(recovery.reasonKey)}</span>
      <span>{t(reconnecting ? 'ai.workspace.terminalRecovery.reconnectingInstructions'
        : recovery.needsStop || stopping ? 'ai.workspace.terminalRecovery.instructions'
          : 'ai.workspace.terminalRecovery.stoppedInstructions')}</span>
      <div className="flex flex-wrap items-center gap-1">
        {(recovery.needsStop || stopping) && onStop && <Button type="button" variant="outline" size="xs"
          disabled={stopping || reconnecting} aria-busy={stopping || undefined} onClick={onStop}>
          {stopping && <Spinner aria-hidden="true" />}
          {t(stopping ? 'ai.workspace.terminalRecovery.stopping' : 'ai.workspace.terminalRecovery.stop')}
        </Button>}
        {onReconnect && <Button type="button" variant="outline" size="xs"
          disabled={recovery.needsStop || stopping || reconnecting} aria-busy={reconnecting || undefined} onClick={onReconnect}>
          {reconnecting && <Spinner aria-hidden="true" />}
          {t(reconnecting ? 'ai.workspace.terminalRecovery.reconnecting' : 'ai.workspace.terminalRecovery.reconnect')}
        </Button>}
      </div>
    </AlertDescription>
  </Alert>;
}
