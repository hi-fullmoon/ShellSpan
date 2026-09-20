import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

// Replay committed snapshots produced by the Rust store/resume integration test.
// This surface exercises the real UI; it does not simulate a model or transport.
const root = createRoot(document.getElementById('root')!);
Object.assign(window, {
  taskBudgetCheck: {
    async show(locale: 'en-US' | 'zh-CN', continued = false) {
      useAppStore.setState({ locale });
      await initI18n(locale);
      flushSync(() => root.render(
        <main className="ai-panel-shell h-dvh w-full min-w-0" data-ai-scope="workbench">
          <AiWorkspaceRoot scope="workbench" mode="ask" view={taskTokenBudgetView(continued)} canStartAgent />
        </main>,
      ));
    },
  },
});
