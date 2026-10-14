import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';

export function AgentTerminalBusyNotice({ disabled, onSwitchDirect, state = 'busy' }: {
  readonly disabled: boolean;
  readonly state?: 'busy' | 'initializing' | 'unavailable';
  readonly onSwitchDirect: () => void | Promise<void>;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <Alert variant="warning" size="sm" role="status" data-slot="terminal-busy-notice">
      <AlertDescription className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="min-w-0 flex-1 basis-48">{t(state === 'busy'
          ? 'agent.executionSurface.v1.busyComposerHint'
          : state === 'initializing' ? 'agent.executionSurface.v1.initializingDescription'
            : 'agent.executionSurface.v1.unavailableDescription')}</span>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onSwitchDirect}>
          {t('agent.executionSurface.v1.switchDirect')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
