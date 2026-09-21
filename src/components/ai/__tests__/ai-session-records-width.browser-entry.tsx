import { createRoot } from 'react-dom/client';
import { AiConversation } from '../workspace/ai-conversation';
import { AiSessionRecordLoading, AiSessionRecordsDialog } from '../ai-session-records-dialog';
import { initI18n, t } from '@/locales';
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
