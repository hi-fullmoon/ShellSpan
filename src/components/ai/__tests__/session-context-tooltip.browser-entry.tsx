import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiSessionHeader } from '../workspace/ai-session-header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initI18n, t } from '@/locales';
import { applyTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);

export async function show(locale: Locale, theme: 'light' | 'dark') {
  useAppStore.setState({ locale });
  await initI18n(locale);
  applyTheme(theme);
  const context = t('ai.terminal.disconnectedContext', { target: 'root@8.216.9.10:22' });
  flushSync(() => root.render(
    <main className="ai-panel-shell pt-16">
      <TooltipProvider>
        <AiSessionHeader title={t('ai.newConversation')} context={context} status="idle" />
      </TooltipProvider>
    </main>,
  ));
  await document.fonts.ready;
  return context;
}
