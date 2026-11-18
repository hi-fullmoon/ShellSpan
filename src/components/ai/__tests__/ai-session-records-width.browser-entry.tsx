import { createRoot } from 'react-dom/client';
import { AiConversation } from '../workspace/ai-conversation';
import { AiSessionBrowser } from '../workspace/ai-session-browser';
import { AiSessionHeader } from '../workspace/ai-session-header';
import { AiSessionRecordLoading, AiSessionRecordsDialog } from '../ai-session-records-dialog';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import type { AgentSessionEvent } from '@/types/agent-session';
import '@/styles/base.css';
import '../styles/styles.css';

await initI18n('zh-CN');
// Empty conversations exercise the real scroller's geometry without fabricating session data.
const root = createRoot(document.getElementById('root')!);
root.render(
  <>
    <div className="ai-panel-shell ai-workspace-root ai-session-records-detail flex h-80 min-h-0 flex-col">
      <AiConversation nodes={[]} status="idle" throughSeq={null} runningIndicator="none" />
    </div>
    <div className="ai-panel-shell ai-workspace-root flex h-80 min-h-0 flex-col">
      <AiConversation nodes={[]} status="idle" throughSeq={null} runningIndicator="none" />
    </div>
    <div data-testid="loading-body" className="ai-panel-shell ai-workspace-root ai-session-records-detail flex h-80 min-h-0 min-w-0 flex-col">
      <AiSessionRecordLoading label={t('common.loading')} />
    </div>
  </>,
);

// The browser has no Tauri backend: exercise the real dialog's load-error state.
export function showRecordsDialog() {
  root.render(<AiSessionRecordsDialog onOpenChange={(open) => { if (!open) root.render(null); }} />);
}

export async function showHistory(events: AgentSessionEvent[], locale: Locale) {
  const created = events.find((event) => event.type === 'session/created');
  if (!created || projectAgentActivity(events).status !== 'idle') {
    throw new Error('The history layout check needs an idle Agent session log');
  }
  const renamed = events.filter((event) => event.type === 'session/renamed').pop();
  const context = created.data.target?.targetId ?? created.sessionId;
  useAppStore.setState({ locale });
  await initI18n(locale);
  root.render(
    <main className="ai-panel-shell">
      <AiSessionHeader title={t('ai.newConversation')} context={context} status="idle" historyOpen historyContent={(
        <AiSessionBrowser
          compact sessions={[{
            id: created.sessionId, kind: 'agent', title: renamed?.data.title ?? created.data.goal,
            updatedAt: new Date(events[events.length - 1].timeUnixMs).toISOString(), status: 'idle', scopeKey: context, archived: false,
          }]}
          loading={false} error={null} archivingId={null}
          onBack={() => {}} onNew={() => {}} onOpen={() => {}} onArchive={() => {}}
        />
      )} />
    </main>,
  );
}
