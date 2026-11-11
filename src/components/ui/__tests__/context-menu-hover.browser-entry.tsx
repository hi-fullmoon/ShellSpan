import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuGroup, ContextMenuItem,
} from '../context-menu';
import { SftpFileContextMenu } from '@/components/sftp/sftp-file-context-menu';
import { SftpBlankContextMenu } from '@/components/sftp/sftp-blank-context-menu';
import { SftpBookmarkMenu } from '@/components/sftp/sftp-bookmark-menu';
import { initI18n, t } from '@/locales';
import { applyTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import type { LocalFileEntry, Locale } from '@/types';
import '@/styles/base.css';

type MenuKind = 'shared' | 'file' | 'blank' | 'bookmark';
const root = createRoot(document.getElementById('root')!);

function Preview({ kind, entry, directory }: {
  kind: MenuKind;
  entry: LocalFileEntry;
  directory: string;
}) {
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  if (kind === 'shared') return <ContextMenu>
    <ContextMenuTrigger data-testid="context-trigger">{entry.name}</ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuGroup>
        <ContextMenuItem onClick={close}>{t('common.copy')}</ContextMenuItem>
        <ContextMenuItem disabled>{t('terminal.menu.paste')}</ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  </ContextMenu>;
  if (kind === 'file') return <SftpFileContextMenu open={open} x={16} y={16}
    side="local" selectedEntries={[entry]}
    isBookmarked={false} batchMode={false} onClose={close} onAction={close} />;
  if (kind === 'blank') return <SftpBlankContextMenu open={open} x={16} y={16}
    side="local" currentPath={directory} hasClipboard={false}
    isBookmarked={false} batchMode={false} onClose={close} onAction={close} />;
  return <SftpBookmarkMenu open={open} x={16} y={16}
    bookmarks={[directory]} onClose={close} onNavigate={close} />;
}

let sequence = 0;
export async function show({ kind, theme, locale, entry, directory }: {
  kind: MenuKind;
  theme: 'light' | 'dark';
  locale: Locale;
  entry: LocalFileEntry;
  directory: string;
}) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  applyTheme(theme);
  flushSync(() => root.render(<Preview key={++sequence}
    kind={kind} entry={entry} directory={directory} />));
  return {
    copy: t('common.copy'),
    remove: t('common.delete'),
    paste: t('sftp.contextMenu.paste'),
    refresh: t('common.refresh'),
  };
}
