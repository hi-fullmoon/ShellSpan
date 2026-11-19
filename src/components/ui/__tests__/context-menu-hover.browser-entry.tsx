import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TerminalIcon } from 'lucide-react';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuGroup, ContextMenuItem,
} from '../context-menu';
import { TooltipProvider } from '../tooltip';
import { SftpFileContextMenu } from '@/components/sftp/sftp-file-context-menu';
import { SftpBlankContextMenu } from '@/components/sftp/sftp-blank-context-menu';
import { SftpBookmarkMenu } from '@/components/sftp/sftp-bookmark-menu';
import { AssistantMessageContent } from '@/components/ai/assistant-message-content';
import { TerminalContextMenu } from '@/components/terminal/terminal-context-menu';
import { TerminalTabBar } from '@/components/terminal/terminal-tab-bar';
import { ConnectionList } from '@/components/workbench/connection-list';
import { IconActionButton } from '@/components/workbench/icon-action-button';
import { LogPanel } from '@/components/workbench/log-panel';
import { WorkbenchSidebar } from '@/components/workbench/workbench-sidebar';
import { initI18n, t } from '@/locales';
import { applyTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { LocalFileEntry, Locale } from '@/types';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

type MenuKind = 'account' | 'icon' | 'connection-actions' | 'log-actions' | 'terminal' | 'shared' | 'file' | 'agent-path' | 'blank' | 'bookmark';
const root = createRoot(document.getElementById('root')!);

function TerminalPreview() {
  const [menu, setMenu] = useState<{ session: TerminalSession; x: number; y: number } | null>(null);
  return <>
    <TerminalTabBar forceVisible onTabContextMenu={(session, x, y) => setMenu({ session, x, y })} />
    {menu && <TerminalContextMenu open {...menu} onClose={() => setMenu(null)} />}
  </>;
}

function Preview({ kind, entry, fileUrl, directory }: {
  kind: MenuKind;
  entry: LocalFileEntry;
  fileUrl: string;
  directory: string;
}) {
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  if (kind === 'account') return <WorkbenchSidebar activeTab="connections" onTabChange={close}
    onOpenSettings={close} onCheckForUpdates={close} onOpenAbout={close} onRequestExit={close} />;
  if (kind === 'icon') {
    const label = t('workbench.connections.connectTerminal');
    return <div className="bg-card p-2">
      <IconActionButton aria-label={label} tooltip={label}><TerminalIcon /></IconActionButton>
    </div>;
  }
  if (kind === 'connection-actions') return <ConnectionList profiles={[]} initialized
    onAdd={close} onEdit={close} onDelete={close} onConnectTerminal={close} onConnectSftp={close}
    onDuplicate={close} onToggleFavorite={close} onImport={close} onExport={close} />;
  if (kind === 'log-actions') return <LogPanel />;
  if (kind === 'terminal') return <TerminalPreview />;
  if (kind === 'agent-path') return <AssistantMessageContent
    blocks={[{ type: 'text', text: `[${entry.name}](${fileUrl})` }]} streaming={false} />;
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
export async function show({ kind, theme, locale, entry, fileUrl, directory, username }: {
  kind: MenuKind;
  theme: 'light' | 'dark';
  locale: Locale;
  entry: LocalFileEntry;
  fileUrl: string;
  directory: string;
  username: string;
}) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  applyTheme(theme);
  if (kind === 'terminal' && useTerminalStore.getState().sessions.length === 0) {
    useTerminalStore.getState().addRestoredSessions([{
      sessionId: crypto.randomUUID(), title: 'localhost', host: 'localhost', port: 22, username,
    }]);
  }
  flushSync(() => root.render(<TooltipProvider>
    <Preview key={++sequence} kind={kind} entry={entry} fileUrl={fileUrl} directory={directory} />
  </TooltipProvider>));
  return {
    account: t('workbench.userMenu.open'),
    appearance: t('settings.appearance.title'),
    icon: t('workbench.connections.connectTerminal'),
    'connection-actions': t('workbench.connections.actions'),
    'log-actions': t('workbench.logs.actions'),
    template: t('terminal.title.template'),
    copy: t('common.copy'),
    copyPath: t('ai.path.copy'),
    openWith: t('ai.path.openWith'),
    defaultApp: t('ai.path.defaultApp'),
    openFile: t('sftp.contextMenu.open'),
    remove: t('common.delete'),
    paste: t('sftp.contextMenu.paste'),
    refresh: t('common.refresh'),
  };
}
