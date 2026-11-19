import { TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { StableContent } from '@/components/ui/stable-content';
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
  const needsStop = recovery.needsStop || stopping;
  return <Alert id={id} variant="warning" size="sm" role="status" aria-label={t('ai.workspace.terminalRecovery.title')}
    data-terminal-recovery-notice="">
    <TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{t('ai.workspace.terminalRecovery.title')}</AlertTitle>
    <AlertDescription className="flex min-w-0 flex-col gap-1">
      <span>{t(recovery.reasonKey)}</span>
      {needsStop && !reconnecting ? <span>{t('ai.workspace.terminalRecovery.instructions')}</span> : (
        <StableContent active={reconnecting ? 1 : 0} variants={[
          t('ai.workspace.terminalRecovery.stoppedInstructions'),
          t('ai.workspace.terminalRecovery.reconnectingInstructions'),
        ]} />
      )}
      <div className="flex flex-wrap items-center gap-1">
        {needsStop && onStop && <AiNoticeAction
          disabled={stopping || reconnecting} aria-busy={stopping || undefined} onClick={onStop}>
          <StableContent className="justify-items-start" active={stopping ? 1 : 0} variants={[
            t('ai.workspace.terminalRecovery.stop'), t('ai.workspace.terminalRecovery.stopping'),
          ]} />
        </AiNoticeAction>}
        {onReconnect && <AiNoticeAction
          disabled={needsStop || reconnecting} aria-busy={reconnecting || undefined} onClick={onReconnect}>
          <StableContent className="justify-items-start" active={reconnecting ? 1 : 0} variants={[
            t('ai.workspace.terminalRecovery.reconnect'), t('ai.workspace.terminalRecovery.reconnecting'),
          ]} />
        </AiNoticeAction>}
      </div>
    </AlertDescription>
  </Alert>;
}
