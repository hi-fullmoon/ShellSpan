import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { MarkdownContent } from '../assistant-message-content';
import { AiSessionRecordsDialog } from '../ai-session-records-dialog';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
export function showRecords() {
  flushSync(() => root.render(<AiSessionRecordsDialog onOpenChange={() => {}} />));
}
export async function show(locale: Locale, draft: string) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  flushSync(() => root.render(
    <main className="ai-panel-shell @container/ai-workspace min-w-0 p-3">
      <MarkdownContent copiedLabel="Copied" copyLabel="Copy" showCodeBlockActions={false}>{'![](image.png)'}</MarkdownContent>
      <AiComposerSeat key={`${locale}:${draft.length}`} phase="active" status="idle" defaultDraft={draft} />
    </main>,
  ));
}
