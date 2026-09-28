import { useMemo, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import { ArrowDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { getTerminalScrollState } from '@/components/terminal/terminal-scroll-state';

export function TerminalScrollButton({ terminal }: { terminal: Terminal }) {
  const { t } = useI18n();
  const state = useMemo(() => getTerminalScrollState(terminal), [terminal]);
  const { history, unread } = useSyncExternalStore(state.subscribe, state.getSnapshot);
  if (!history) return null;
  return (
    <Button
      variant="secondary"
      size="xs"
      className="absolute bottom-4 right-4 z-20 max-w-[calc(100%-2rem)] rounded-full text-[11px] shadow-sm"
      onClick={() => { terminal.scrollToBottom(); terminal.focus(); }}
    >
      <ArrowDownIcon data-icon="inline-start" />
      {t(unread ? 'terminal.scroll.newOutput' : 'terminal.scroll.latest')}
    </Button>
  );
}
