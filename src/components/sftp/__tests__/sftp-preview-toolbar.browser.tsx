import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SftpPreviewDialog } from '../sftp-preview-dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { isTauri } from '@tauri-apps/api/core';
import { invokeGetFileOpenDefaultIcon, invokeListFileOpenApplications, invokePickPreviewSaveDestination, invokeRevealPath, invokeSaveLocalPreviewFile } from '@/lib/ipc/tauri';
import type { FileOpenApplication, Locale, ReadRemoteFileResponse } from '@/types';
import '@/styles/base.css';

export async function mountPreview(content: ReadRemoteFileResponse, locale: Locale, isRemote = false, desktopApplications?: FileOpenApplication[]) {
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
          fileActions={{
            isRemote,
            open: async ({ path }) => { window.open(`/@fs${path}`, '_blank'); },
            getDefaultApplicationIcon: async ({ name, path }) => {
              if (desktopApplications) return desktopApplications[0]?.icon ?? null;
              return isTauri() ? invokeGetFileOpenDefaultIcon(name, isRemote ? undefined : path) : null;
            },
            listApplications: async ({ name, path }) => {
              if (desktopApplications) return desktopApplications;
              if (!isTauri()) throw new Error('System applications require the desktop runtime');
              return invokeListFileOpenApplications(name, isRemote ? undefined : path);
            },
            reveal: ({ path }) => invokeRevealPath(path),
            saveAs: async ({ name, path }) => {
              const destination = await invokePickPreviewSaveDestination(name, 'Save as…', path);
              if (destination) await invokeSaveLocalPreviewFile(path, destination);
            },
          }}
        />
      </TooltipProvider>
    );
  }
  createRoot(document.getElementById('root')!).render(<Preview />);
}
