import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiApprovalPanel, type AiApprovalPanelProps } from '../workspace/ai-approval-panel';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);

export async function show(approval: AiApprovalPanelProps['approval'], locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const record = (action: string) => { document.body.dataset.action = action; };
  delete document.body.dataset.action;
  flushSync(() => root.render(
    <main className="ai-panel-shell @container/ai-workspace min-h-dvh min-w-0 p-3" data-ai-scope="workbench">
      <AiApprovalPanel approval={approval} decision={null} error={null}
        onApprove={() => record('approve')} onReject={() => record('reject')}
        onOpenDetails={() => record('details')} />
    </main>,
  ));
}
