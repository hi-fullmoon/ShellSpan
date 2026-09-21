import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MessageScroller } from '../chat-primitives';
import { AssistantMessageContent } from '../assistant-message-content';
import { initI18n } from '@/locales';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
let revision = 0;
await initI18n('en-US');

// Render repository documents through production Markdown and scrolling code.
// Layout, scroll events and observers all run natively in the browser.
Object.assign(window, {
  renderScrollDocuments(documents: { name: string; text: string }[]) {
    revision += 1;
    flushSync(() => root.render(
      <main className="ai-panel-shell h-dvh w-full min-w-0" data-ai-scope="workbench">
        <MessageScroller key={revision} followKey="documents"
          initialAnchor={{ nodeKey: documents[0]?.name ?? '', atBottom: false, offset: 0, scrollTop: 0 }}>
          {documents.map(({ name, text }) => (
            <div key={name} data-ai-node-key={name}>
              <AssistantMessageContent blocks={[{ type: 'text', text }]} streaming={false} />
            </div>
          ))}
        </MessageScroller>
      </main>,
    ));
  },
});
