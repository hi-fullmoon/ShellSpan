import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import { AgentTerminalBusyNotice } from '../agent-terminal-busy-notice';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
interface FeedbackState {
  terminal: string;
  generation: number;
  state: 'ready' | 'busy' | 'initializing' | 'unavailable';
  blockedAttempt?: string;
  locked?: boolean;
}

export async function initialize(locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  return {
    running: t('agent.executionSurface.v1.runningComposerHint'),
    blocked: t('agent.executionSurface.v1.busyComposerHint'),
    direct: t('agent.executionSurface.v1.switchDirect'),
    unavailable: t('agent.executionSurface.v1.unavailableDescription'),
  };
}

export function show(state: FeedbackState) {
  flushSync(() => root.render(
    <main className="ai-panel-shell ai-workspace-root @container/ai-workspace flex h-dvh min-h-0 min-w-0 flex-col" data-ai-scope="terminal">
      <div className="min-h-0 flex-1" />
      <AiComposerSeat phase="active" status="idle" defaultDraft="hello"
        onSubmit={() => { document.body.dataset.sent = 'true'; }}
        executionSurfaceNotice={state.state === 'ready' ? undefined : <AgentTerminalBusyNotice
          key={JSON.stringify([state.terminal, state.generation])}
          state={state.state} blockedAttempt={state.blockedAttempt} disabled={Boolean(state.locked)}
          onSwitchDirect={() => { document.body.dataset.switched = 'true'; }} />}
      />
    </main>,
  ));
}
