import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiApprovalPanel, type AiApprovalPanelProps } from '../workspace/ai-approval-panel';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { AgentTerminalBusyNotice } from '../agent-terminal-busy-notice';

const root = createRoot(document.getElementById('root')!);

export async function show(approval: AiApprovalPanelProps['approval'], locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const record = (action: string) => { document.body.dataset.action = action; };
  delete document.body.dataset.action;
  flushSync(() => root.render(
    <main className="ai-panel-shell @container/ai-workspace min-h-dvh min-w-0 p-3" data-ai-scope="workbench">
      <AiApprovalPanel approval={approval} decision={null} error={null}
        onApprove={() => record('approve')} onReject={() => record('reject')}
        onOpenDetails={() => record('details')} />
    </main>,
  ));
}

export async function showComposer(approval: AiApprovalPanelProps['approval']) {
  await initI18n('zh-CN');
  const record = (action: string) => { document.body.dataset.action = action; };
  delete document.body.dataset.action;
  flushSync(() => root.render(
    <main className="ai-panel-shell @container/ai-workspace flex h-dvh min-h-0 min-w-0 flex-col" data-ai-scope="terminal">
      <header className="h-14 shrink-0">Terminal Agent</header>
      <div className="min-h-0 flex-1" />
      <AiComposerSeat phase="active" status="waiting" pendingApproval={approval}
        executionSurfaceNotice={<AgentTerminalBusyNotice disabled onSwitchDirect={() => { throw new Error('Execution surface is locked during approval'); }} />}
        composerState={createAiComposerState({ phase: 'waitingApproval', runtimeStatus: 'waiting',
          waitingApproval: true, sessionId: approval.sessionId, draft: 'preserved draft' })}
        onApprove={() => record('approve')} onReject={() => record('reject')}
        onOpenApprovalDetails={() => record('details')} />
    </main>,
  ));
}
