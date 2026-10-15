import { SquareTerminalIcon, TargetIcon } from 'lucide-react';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useI18n } from '@/hooks/useI18n';
import { terminalLoginLabel } from '@/lib/ai/terminal-login-scope';
import { AiHeaderIconButton } from '@/components/ai/workspace/ai-header-icon-button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FocusControls } from './focus-controls';

export function FocusTerminalHeader(): React.ReactNode {
  const { t } = useI18n();
  const { enabled, targetSessionId, busy, setTarget } = useFocusStore();
  const viewing = useTerminalStore(state => state.sessions.find(s => s.sessionId === state.activeSessionId));
  if (!enabled) return null;
  const currentTarget = Boolean(viewing && viewing.sessionId === targetSessionId);
  const identity = viewing ? viewing.port === 0 ? t('ai.workspace.localTarget') : terminalLoginLabel(viewing) ?? viewing.host : t('terminal.empty');
  const context = viewing ? `${identity} · ${t(`terminal.status.${viewing.status}`)}` : identity;
  return <header data-slot="focus-terminal-header" className="flex h-10 min-h-10 min-w-0 shrink-0 items-center gap-2 border-b border-app-border/50 bg-card px-2.5">
    <SquareTerminalIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1">
        <h2 className="truncate text-sm font-medium leading-5 text-foreground" title={viewing?.title}>{viewing?.title ?? t('section.terminal')}</h2>
        {currentTarget && <Badge variant="secondary" size="sm" className="shrink-0" title={busy ? t('focus.targetLocked') : undefined}>{t('focus.agentTarget')}</Badge>}
      </div>
      <p className="truncate text-[11px] leading-[15px] text-muted-foreground" title={context}>{context}</p>
    </div>
    {!currentTarget && viewing && <Tooltip>
        <TooltipTrigger render={<AiHeaderIconButton type="button" aria-label={t('focus.setTarget')}
          disabled={busy || viewing.status !== 'connected'} onClick={() => setTarget(viewing.sessionId)} />}><TargetIcon /></TooltipTrigger>
        <TooltipContent>{t(busy ? 'focus.targetLocked' : 'focus.setTarget')}</TooltipContent>
      </Tooltip>}
    <FocusControls />
  </header>;
}
