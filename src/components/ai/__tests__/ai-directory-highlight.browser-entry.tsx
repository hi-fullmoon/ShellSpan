import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { activeFileToken, insertFileMention } from '@/lib/ai/file-reference-grammar';
import '@/styles/base.css';
import '../styles/styles.css';

await initI18n('zh-CN');
const draft = '/system-status @nvm';
const selected = insertFileMention(draft, activeFileToken(draft, draft.length)!, { path: 'zhengbiwen/.nvm', kind: 'directory' })!;
createRoot(document.getElementById('root')!).render(
  <main className="ai-panel-shell p-3">
    <AiComposerSeat phase="active" status="idle" defaultDraft={selected.text} />
  </main>,
);
