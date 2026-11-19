import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiConversation } from '../workspace/ai-conversation';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { terminalRecoveryView } from '@/tests/fixtures/terminal-execution-recovery';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import { conversationFoldRecording } from '@/tests/fixtures/conversation-fold-runtime';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { Locale } from '@/types';
import capture from '@/tests/fixtures/agent-skills-runtime.json';
import '@/styles/base.css';
import '../styles/styles.css';

export async function mount(host: HTMLElement, locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const root = createRoot(host);
  const events = capture as AgentSessionEvent[];
  const end = events.findIndex(event => event.type === 'turn/end');
  const nodes = projectAgentChatNodes(events.slice(0, end)).filter(node => node.kind !== 'systemPrompt');
  const recoveryActions: string[] = [];
  return {
    render(status: AiSessionStatus, statusReason?: string) {
      flushSync(() => root.render(<AiConversation nodes={nodes} status={status} statusReason={statusReason} throughSeq={events[end - 1].seq} />));
    },
    recovery(stage: 'waiting' | 'stopping' | 'stopped' | 'reconnecting' | 'cleared' | 'history' | 'disconnected') {
      const recoveryCleared = stage === 'cleared' || stage === 'disconnected';
      const view = terminalRecoveryView(stage === 'stopped' || stage === 'reconnecting' || recoveryCleared ? 'idle' : 'waiting');
      flushSync(() => root.render(<AiWorkspaceRoot scope="terminal" canStartAgent
        view={recoveryCleared ? { ...view, recovery: { status: 'none' } } : view}
        agentUnavailableReason={stage === 'disconnected' ? t('agent.availability.needsTerminal') : null}
        composerState={stage === 'stopping' ? createAiComposerState({ phase: 'stopping' }) : undefined}
        terminalReconnecting={stage === 'reconnecting'} readOnlySession={stage === 'history'}
        historicalTargetUnavailable={stage === 'history'}
        onStop={() => { recoveryActions.push('stop'); }}
        onReconnectTerminal={() => { recoveryActions.push('reconnect'); }} />));
    },
    recoveryActions: () => [...recoveryActions],
    verifyContinuation(busy: boolean) {
      flushSync(() => root.render(<AiWorkspaceRoot scope="terminal" canStartAgent view={null}
        agentUnavailableReason={t(busy ? 'ai.workspace.reconnectChecking' : 'ai.workspace.reconnectAvailable')}
        terminalReconnectBusy={busy} onContinueOnReconnectedTerminal={() => { recoveryActions.push('verify'); }} />));
      return { ready: t('ai.workspace.continueOnReconnectedTerminal'), pending: t('ai.workspace.reconnectChecking') };
    },
    storageFault(mode: 'agent' | 'ask') {
      const recorded = conversationFoldRecording.direct.events;
      const firstText = recorded.findIndex(event => event.type === 'assistant/chunk' && event.data.textDelta?.trim());
      const events = recorded.slice(0, firstText + 1);
      const last = events[events.length - 1];
      if (last?.type !== 'assistant/chunk' || !last.data.textDelta) throw new Error('Recorded text required');
      const snapshot = terminalRecoveryView('idle').snapshot.value;
      const view = agentSessionView({
        snapshot: { ...snapshot, ended: false, header: { ...snapshot.header, sessionId: last.sessionId },
          recovery: { ...snapshot.recovery, status: 'none' } },
        events, lastCommittedSeq: last.seq, hasTerminalEvent: false, storageFaultAtSeq: last.seq,
      });
      flushSync(() => root.render(<AiWorkspaceRoot mode={mode} scope={mode === 'ask' ? 'workbench' : 'terminal'}
        view={view} canStartAgent submissionDisabled />));
      return last.data.textDelta.trim();
    },
  };
}
