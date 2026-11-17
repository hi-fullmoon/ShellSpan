import { useEffect, useState } from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useI18n } from '@/hooks/useI18n';
import type { RemoteGlibcMismatch } from '@/lib/terminal/terminal-surface-semantics';
import { cn } from '@/lib/utils';
import { AI_NOTICE_ACTION_ROW_CLASS, AI_NOTICE_COPY_CLASS, AI_NOTICE_COPY_WITH_ACTION_CLASS } from './workspace/ai-style-classes';
import { AiNoticeAction } from './workspace/ai-notice-action';

interface AgentTerminalBusyNoticeProps {
  readonly disabled: boolean;
  readonly state?: 'busy' | 'initializing' | 'unavailable';
  readonly focusMode?: boolean;
  readonly glibcMismatch?: RemoteGlibcMismatch | null;
  /** A new runtime rejection during this busy period, rather than a historical failure. */
  readonly blockedAttempt?: string | null;
  /** Changes on navigation, but stays stable when submitting creates a session. */
  readonly context?: object;
  readonly onSwitchDirect?: () => void | Promise<void>;
}

const descriptions = {
  busy: {
    terminal: 'agent.executionSurface.v1.busyComposerHint',
    focus: 'focus.terminalBusy',
  },
  initializing: {
    terminal: 'agent.executionSurface.v1.initializationTimeoutDescription',
    focus: 'focus.terminalInitializationTimeout',
  },
  unavailable: {
    terminal: 'agent.executionSurface.v1.unavailableDescription',
    focus: 'focus.terminalCommandsUnavailable',
  },
} as const;

export function AgentTerminalBusyNotice(props: AgentTerminalBusyNoticeProps): React.ReactNode {
  const [owner, setOwner] = useState({ context: props.context, revision: 0 });
  if (owner.context !== props.context) {
    setOwner({ context: props.context, revision: owner.revision + 1 });
  }
  return <TerminalBusyFeedback key={`${props.state ?? 'busy'}:${owner.revision}`} {...props} />;
}

function TerminalBusyFeedback({ disabled, onSwitchDirect, state = 'busy', focusMode = false, blockedAttempt = null, glibcMismatch }: AgentTerminalBusyNoticeProps): React.ReactNode {
  const { t } = useI18n();
  const [initialBlockedAttempt] = useState(blockedAttempt);
  const [initializationTimedOut, setInitializationTimedOut] = useState(false);
  useEffect(() => {
    if (state !== 'initializing') return;
    const timer = window.setTimeout(() => setInitializationTimedOut(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const blocked = blockedAttempt !== null && blockedAttempt !== initialBlockedAttempt;
  if (state === 'initializing' && !initializationTimedOut) return null;
  if (state === 'busy' && !blocked) return null;

  return (
    <Alert variant="warning" size="sm" role="status" data-slot="terminal-busy-notice"
      className={onSwitchDirect ? '[--alert-icon-inset:--spacing(1)]' : undefined}>
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className={AI_NOTICE_ACTION_ROW_CLASS}>
        <span className={cn(AI_NOTICE_COPY_CLASS, onSwitchDirect && AI_NOTICE_COPY_WITH_ACTION_CLASS)}>{glibcMismatch
          ? t('agent.executionSurface.v1.remoteGlibcTooOld', { ...glibcMismatch })
          : t(descriptions[state][focusMode ? 'focus' : 'terminal'])}</span>
        {onSwitchDirect && <AiNoticeAction disabled={disabled} onClick={onSwitchDirect}>
          {t('agent.executionSurface.v1.switchDirect')}
        </AiNoticeAction>}
      </AlertDescription>
    </Alert>
  );
}
