import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SftpPreviewDialog } from '../sftp-preview-dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale, ReadRemoteFileResponse } from '@/types';
import '@/styles/base.css';

export async function mountPreview(content: ReadRemoteFileResponse, locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  function Preview() {
    const [open, setOpen] = useState(true);
    return (
      <TooltipProvider>
        <SftpPreviewDialog
          content={content}
          open={open}
          onClose={() => setOpen(false)}
          onOpenExternally={(path) => { window.open(`/@fs${path}`, '_blank'); }}
        />
      </TooltipProvider>
    );
  }
  createRoot(document.getElementById('root')!).render(<Preview />);
}
