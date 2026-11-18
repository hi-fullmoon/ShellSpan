import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { TooltipProvider } from '../tooltip';
import { IconActionButton } from '@/components/workbench/icon-action-button';
import { initI18n, t } from '@/locales';
import { applyTheme } from '@/lib/theme';
import type { Locale } from '@/types';
import '@/styles/base.css';

const root = createRoot(document.getElementById('root')!);

export async function show(locale: Locale) {
  await initI18n(locale);
  applyTheme('light');
  const label = t('workbench.keychain.forgetPassword');
  flushSync(() => root.render(
    <main className="flex h-full items-center justify-center">
      <TooltipProvider>
        <IconActionButton aria-label={label} tooltip={label}>
          <Trash2 />
        </IconActionButton>
      </TooltipProvider>
    </main>,
  ));
  await document.fonts.ready;
  return label;
}
