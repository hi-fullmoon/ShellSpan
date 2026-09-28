import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiConversationNodeList } from '../workspace/ai-conversation-node-seat';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
await initI18n('zh-CN');
Object.assign(window, {
  renderSendingMessage(content: string, delivery: AiConversationNodeOf<'userMessage'>['delivery']) {
    flushSync(() => root.render(
      <main className="ai-panel-shell h-dvh w-full min-w-0 p-6" data-ai-scope="workbench">
        <AiConversationNodeList nodes={[{
          kind: 'userMessage', key: 'readme', sourceKind: 'agent', sessionId: 'readme',
          turnId: null, stepId: null, firstSeq: 0, lastSeq: 0,
          timestamp: new Date().toISOString(), messageId: 'readme', content, delivery,
        }]} />
      </main>,
    ));
  },
});
