import { PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react';
import { useFocusStore } from '@/stores/focusStore';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';

export function FocusControls(): React.ReactNode {
  const { t } = useI18n();
  const { enabled, terminalOpen, setTerminalOpen } = useFocusStore();
  if (!enabled) return null;
  return <div data-slot="focus-controls" className="flex min-w-0 items-center gap-2">
    <Button size="icon-sm" variant="ghost" aria-label={t(terminalOpen ? 'focus.collapseTerminal' : 'focus.expandTerminal')}
      aria-expanded={terminalOpen} onClick={() => setTerminalOpen(!terminalOpen)}>
      {terminalOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
    </Button>
  </div>;
}
