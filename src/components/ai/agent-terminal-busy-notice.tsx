import { useEffect, useState } from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useI18n } from '@/hooks/useI18n';
import type { RemoteGlibcMismatch, WindowsPowerShell7Unavailable } from '@/lib/terminal/terminal-surface-semantics';
import { cn } from '@/lib/utils';
import { AI_NOTICE_ACTION_ROW_CLASS, AI_NOTICE_COPY_CLASS, AI_NOTICE_COPY_WITH_ACTION_CLASS } from './workspace/ai-style-classes';
import { AiNoticeAction } from './workspace/ai-notice-action';

interface AgentTerminalBusyNoticeProps {
  readonly disabled: boolean;
  readonly state?: 'busy' | 'initializing' | 'unavailable' | 'recoveryRequired';
  readonly focusMode?: boolean;
  readonly glibcMismatch?: RemoteGlibcMismatch | null;
  readonly windowsPowerShell7Fallback?: WindowsPowerShell7Unavailable | null;
  /** A new runtime rejection during this busy period, rather than a historical failure. */
  readonly blockedAttempt?: string | null;
  /** Changes on navigation, but stays stable when submitting creates a session. */
  readonly context?: object;
  readonly switchDirectLockedByUncertain?: boolean;
  readonly reconnectDisabled?: boolean;
  readonly onSwitchDirect?: () => void | Promise<void>;
  readonly onReconnectTerminal?: () => void | Promise<void>;
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
  recoveryRequired: {
    terminal: 'agent.executionSurface.v1.recoveryRequiredDescription',
    focus: 'agent.executionSurface.v1.recoveryRequiredDescription',
  },
} as const;

export function AgentTerminalBusyNotice(props: AgentTerminalBusyNoticeProps): React.ReactNode {
  const [owner, setOwner] = useState({ context: props.context, revision: 0 });
  if (owner.context !== props.context) {
    setOwner({ context: props.context, revision: owner.revision + 1 });
  }
  return <TerminalBusyFeedback key={`${props.state ?? 'busy'}:${owner.revision}`} {...props} />;
}

function TerminalBusyFeedback({
  disabled,
  onSwitchDirect,
  onReconnectTerminal,
  reconnectDisabled,
  switchDirectLockedByUncertain = false,
  state = 'busy',
  focusMode = false,
  blockedAttempt = null,
  glibcMismatch,
  windowsPowerShell7Fallback,
}: AgentTerminalBusyNoticeProps): React.ReactNode {
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

  const unavailableLocked = state === 'unavailable' && !glibcMismatch && !windowsPowerShell7Fallback && !focusMode && switchDirectLockedByUncertain;
  const action = state === 'recoveryRequired' || unavailableLocked
    ? (onReconnectTerminal
      ? { label: t('ai.workspace.status.reconnect'), disabled: reconnectDisabled ?? disabled, onClick: onReconnectTerminal }
      : null)
    : (onSwitchDirect
      ? { label: t('agent.executionSurface.v1.switchDirect'), disabled, onClick: onSwitchDirect }
      : null);
  const windowsPowerShell7Message = windowsPowerShell7Fallback
    ? windowsPowerShell7Fallback.kind === 'missing'
      ? t('agent.executionSurface.v1.windowsPowerShell7Missing', { minimum: windowsPowerShell7Fallback.minimum })
      : windowsPowerShell7Fallback.kind === 'tooOld'
        ? t('agent.executionSurface.v1.windowsPowerShell7TooOld', {
          actual: windowsPowerShell7Fallback.actual,
          minimum: windowsPowerShell7Fallback.minimum,
        })
        : t('agent.executionSurface.v1.windowsPowerShell7Untrusted')
    : null;
  const message = glibcMismatch
    ? t('agent.executionSurface.v1.remoteGlibcTooOld', { ...glibcMismatch })
    : windowsPowerShell7Message
      ? windowsPowerShell7Message
      : unavailableLocked
        ? t('agent.executionSurface.v1.unavailableLockedDescription')
        : t(descriptions[state][focusMode ? 'focus' : 'terminal']);

  return (
    <Alert variant="warning" size="sm" role="status" data-slot="terminal-busy-notice"
      className={action ? '[--alert-icon-inset:--spacing(1)]' : undefined}>
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className={AI_NOTICE_ACTION_ROW_CLASS}>
        <span className={cn(AI_NOTICE_COPY_CLASS, action && AI_NOTICE_COPY_WITH_ACTION_CLASS)}>{message}</span>
        {action && <AiNoticeAction disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </AiNoticeAction>}
      </AlertDescription>
    </Alert>
  );
}
