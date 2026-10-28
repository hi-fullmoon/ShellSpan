import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';
import '@/styles/base.css';
import '../styles/styles.css';

const locale = new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
useAppStore.setState({ locale });
await initI18n(locale);
const recording: { events: readonly AgentSessionEvent[]; snapshot: AgentSessionSnapshot } = await fetch('/child-recovery-recording').then(response => response.json());
const view = agentSessionView({ ...recording, lastCommittedSeq: recording.events[recording.events.length - 1].seq, hasTerminalEvent: true });

function Review() {
  const [busy, setBusy] = useState(false);
  return <div className="ai-panel-shell" style={{ height: '100dvh' }}>
    <AiWorkspaceRoot view={view} mode="agent" scope="workbench" canStartAgent readOnlySession
      retryingModel={busy} onRetryModel={turn => { document.body.dataset.recoveryTurn = turn; setBusy(true); }} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<Review />);
