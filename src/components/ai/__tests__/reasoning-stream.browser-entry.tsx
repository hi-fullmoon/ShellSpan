import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiConversation } from '../workspace/ai-conversation';
import { aiAskConversationNodeRenderers } from '../workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import '@/styles/base.css';
import '../styles/styles.css';

await initI18n('en-US');
const root = createRoot(document.getElementById('root')!);
export function replay(events: AgentSessionEvent[]) {
  const nodes = projectAgentChatNodes(events).flatMap<AiConversationNode>(node => node.kind === 'turnProcess' ? node.children : [node]);
  flushSync(() => root.render(
    <main className="ai-panel-shell h-dvh w-full min-w-0" data-ai-scope="workbench">
      <AiConversation nodes={nodes} renderers={aiAskConversationNodeRenderers}
        runningIndicator="ask" status="running" throughSeq={events[events.length - 1]?.seq ?? null} />
    </main>,
  ));
}
