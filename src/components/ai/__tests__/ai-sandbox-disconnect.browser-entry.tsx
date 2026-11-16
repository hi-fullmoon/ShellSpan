import { createRoot } from 'react-dom/client';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';
import '@/styles/base.css';
import '../styles/styles.css';

useAppStore.setState({ locale: 'zh-CN' });
await initI18n('zh-CN');
const { events, snapshot }: { events: AgentSessionEvent[]; snapshot: AgentSessionSnapshot } =
  await fetch('/sandbox-disconnect-recording').then(response => response.json());
const view = agentSessionView({ snapshot, events, lastCommittedSeq: events[events.length - 1].seq, hasTerminalEvent: false });
createRoot(document.getElementById('root')!).render(
  <AiWorkspaceRoot view={view} mode="agent" scope="terminal" canStartAgent
    onRetryModel={() => { throw new Error('Unexpected command retry action'); }} />,
);
