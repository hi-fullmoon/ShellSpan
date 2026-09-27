import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { inboxTimelineEvidence, inboxTimelineView } from '@/test/fixtures/agent-inbox-timeline';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';

export async function mount(host: HTMLElement, locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const root = createRoot(host);
  const { events } = inboxTimelineEvidence;
  const accepted = (id: string) => events.findIndex(event => event.type === 'user/message' && event.data.message.messageId === id);
  const firstCorrection = accepted('correction');
  const end = events.findIndex(event => event.type === 'turn/end');
  const show = (length: number) => flushSync(() => root.render(
    <AiWorkspaceRoot scope="workbench" view={inboxTimelineView(length)} />,
  ));
  return {
    waiting: () => show(firstCorrection),
    steering: () => show(firstCorrection + 1),
    completed: () => show(end + 1),
    nextTurn: () => show(events.length),
  };
}
