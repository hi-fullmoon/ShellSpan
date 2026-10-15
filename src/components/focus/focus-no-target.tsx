import { InfoIcon, PlusIcon, SquareTerminalIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore } from '@/stores/terminalStore';

export function FocusNoTarget(): React.ReactNode {
  const { t } = useI18n();
  const candidate = useTerminalStore(state => state.sessions.find(s => s.sessionId === state.activeSessionId && s.status === 'connected')
    ?? state.sessions.find(s => s.status === 'connected'));
  const busy = useFocusStore(state => state.busy);
  return <Alert variant="info" size="sm" role="status" data-slot="focus-start-notice" className="[&:has(button)>svg]:translate-y-1">
    <InfoIcon aria-hidden="true" />
    <AlertDescription className="flex min-w-0 flex-wrap items-start gap-1 break-words [&:has(>button)>span]:py-1">
    <span className="min-w-0 flex-1 basis-48">{candidate
      ? t('focus.useTerminalHint', { terminal: candidate.title }) : t('focus.connectFirst')}</span>
    <Button type="button" size="xs" variant="ghost" className="shrink-0 text-[11px]" disabled={busy} onClick={() => {
      const focus = useFocusStore.getState();
      if (candidate) focus.setTarget(candidate.sessionId);
      else {
        focus.setTerminalOpen(true);
        document.dispatchEvent(new Event('shellspan:new-terminal-tab'));
      }
    }}>{candidate ? <SquareTerminalIcon data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
      {t(candidate ? 'focus.useTerminal' : 'focus.connect')}
    </Button>
  </AlertDescription></Alert>;
}
