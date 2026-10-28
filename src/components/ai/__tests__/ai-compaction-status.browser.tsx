import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiConversation } from '../workspace/ai-conversation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { Locale } from '@/types';
import capture from '@/test/fixtures/compaction-progress.json';
import '@/styles/base.css';
import '../styles/styles.css';

const traces = capture as unknown as Record<'completed' | 'failed' | 'cancelled', readonly AgentSessionEvent[]>;
export async function mount(host: HTMLElement, locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const root = createRoot(host);
  return (stage: 'running' | 'completed' | 'failed' | 'cancelled') => {
    const events = traces[stage === 'running' ? 'completed' : stage];
    const start = events.findIndex(event => event.type === 'compaction/start');
    // Replay the real progress window without a turn/start or running marker,
    // as happens while the next turn is still being prepared.
    const visibleEvents = stage === 'running' ? events.slice(start, start + 1) : events.slice(start);
    const nodes = projectAgentChatNodes(visibleEvents)
      .filter(node => node.kind !== 'userMessage' && node.kind !== 'systemPrompt');
    flushSync(() => root.render(<AiConversation nodes={nodes} status={projectAgentActivity(visibleEvents).status} throughSeq={null} />));
  };
}
