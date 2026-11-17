import { TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useI18n } from '@/hooks/useI18n';
import type { TerminalExecutionRecovery } from '@/lib/ai/terminal-execution-recovery';
import { AiNoticeAction } from './ai-notice-action';

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
        {(recovery.needsStop || stopping) && onStop && <AiNoticeAction
          disabled={stopping || reconnecting} aria-busy={stopping || undefined} onClick={onStop}>
          {t(stopping ? 'ai.workspace.terminalRecovery.stopping' : 'ai.workspace.terminalRecovery.stop')}
        </AiNoticeAction>}
        {onReconnect && <AiNoticeAction
          disabled={recovery.needsStop || stopping || reconnecting} aria-busy={reconnecting || undefined} onClick={onReconnect}>
          {t(reconnecting ? 'ai.workspace.terminalRecovery.reconnecting' : 'ai.workspace.terminalRecovery.reconnect')}
        </AiNoticeAction>}
      </div>
    </AlertDescription>
  </Alert>;
}
