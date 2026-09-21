import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { chatReferenceFile } from '@/lib/ai/chat-reference';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';
import { initI18n } from '@/locales';
import '@/styles/base.css';
import '../styles/styles.css';

await initI18n('zh-CN');
const summary = {
  id: agentSessionEventFixture[0].sessionId, kind: 'agent' as const, title: 'Check nginx now.',
  updatedAt: new Date(agentSessionEventFixture[0].timeUnixMs).toISOString(),
  status: 'idle' as const, scopeKey: 'terminal-fixture', archived: false,
};
createRoot(document.getElementById('root')!).render(
  <main className="ai-panel-shell p-3">
    <AiComposerSeat phase="active" status="idle" sessions={[summary]}
      onReadSession={async () => chatReferenceFile(summary, projectAgentChatNodes(agentSessionEventFixture))} />
  </main>,
);
