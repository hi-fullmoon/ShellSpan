import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FocusNoTarget } from '../focus-no-target';
import { AiComposerSeat } from '@/components/ai/workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import { applyTheme } from '@/lib/theme';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

const root = createRoot(document.getElementById('root')!);

export async function show(locale: Locale, theme: 'light' | 'dark' = 'light') {
  applyTheme(theme);
  useAppStore.setState({ locale });
  await initI18n(locale);
  flushSync(() => root.render(
    <main className="ai-panel-shell ai-workspace-root @container/ai-workspace flex h-dvh min-h-0 min-w-0 flex-col" data-ai-scope="terminal">
      <div className="min-h-0 flex-1" />
      <AiComposerSeat phase="active" status="idle" onSubmit={() => {}}
        executionSurfaceNotice={<FocusNoTarget />} />
    </main>,
  ));
}
