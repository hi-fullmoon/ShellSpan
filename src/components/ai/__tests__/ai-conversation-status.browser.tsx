import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiConversation } from '../workspace/ai-conversation';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { terminalRecoveryView } from '@/test/fixtures/terminal-execution-recovery';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { Locale } from '@/types';
import capture from '@/test/fixtures/agent-skills-runtime.json';
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
    recovery(stage: 'waiting' | 'stopping' | 'stopped' | 'reconnecting' | 'cleared' | 'history') {
      const view = terminalRecoveryView(stage === 'stopped' || stage === 'reconnecting' || stage === 'cleared' ? 'idle' : 'waiting');
      flushSync(() => root.render(<AiWorkspaceRoot scope="terminal" canStartAgent
        view={stage === 'cleared' ? { ...view, recovery: { status: 'none' } } : view}
        composerState={stage === 'stopping' ? createAiComposerState({ phase: 'stopping' }) : undefined}
        terminalReconnecting={stage === 'reconnecting'} readOnlySession={stage === 'history'}
        historicalTargetUnavailable={stage === 'history'}
        onStop={() => { recoveryActions.push('stop'); }}
        onReconnectTerminal={() => { recoveryActions.push('reconnect'); }} />));
    },
    recoveryActions: () => [...recoveryActions],
  };
}
