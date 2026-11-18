import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { AppWindow, Code, Copy, FileText, FolderOpen, Save, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useI18n } from '@/hooks/useI18n';
import type { AiLocalFileReference } from '@/lib/ai/file-reference';
import { terminalLoginScopeKey } from '@/lib/ai/terminal-login-scope';
import { writeClipboardText } from '@/lib/clipboard';
import { openHostPath } from '@/lib/host/host-quick-actions';
import {
  invokeListLocalFileApps,
  invokeOpenLocalFileWith,
  invokeOpenPath,
  invokeReadLocalFileText,
  invokeRevealPath,
  invokeSaveLocalFileAs,
  isTauriRuntime,
  type LocalFileApp,
} from '@/lib/ipc/tauri';
import { getPlatform } from '@/lib/platform';
import { parentPosixPath, parsePosixPath } from '@/lib/path-utils';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentSessionTarget } from '@/types/agent-session';

const appOptions = {
  vsCode: { label: 'ai.path.app.vsCode', Icon: Code },
  terminal: { label: 'ai.path.app.terminal', Icon: SquareTerminal },
  iterm: { label: 'ai.path.app.iterm', Icon: SquareTerminal },
  xcode: { label: 'ai.path.app.xcode', Icon: Code },
  androidStudio: { label: 'ai.path.app.androidStudio', Icon: Code },
  systemPicker: { label: 'ai.path.chooseApp', Icon: AppWindow },
} satisfies Record<LocalFileApp, { label: LocaleKey; Icon: typeof AppWindow }>;

export function AiFileReferenceMenu({
  reference,
  target,
  inlineCode = false,
  children,
}: {
  reference: AiLocalFileReference;
  target?: AgentSessionTarget;
  inlineCode?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { path } = reference;
  const remote = target?.kind === 'remote';
  const remoteProfile = useProfileStore(state => {
    if (!remote || !path.startsWith('/') || !target.profileId) return;
    const profile = state.getProfile(target.profileId);
    const login = terminalLoginScopeKey(target);
    if (login && profile && login === terminalLoginScopeKey(profile)) return profile;
  });
  const routeKey = useTerminalStore(state => {
    if (!remote) return;
    const terminal = state.sessions.find(session => session.sessionId === target.sessionId);
    if (terminal && terminal.profileId === target.profileId
      && terminalLoginScopeKey(terminal) === terminalLoginScopeKey(target)) return terminal.sshRouteKey;
  });
  const platform = getPlatform();
  const mac = platform === 'macos';
  const desktop = isTauriRuntime();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<LocalFileApp[]>([]);
  useEffect(() => {
    if (remote || !open || (platform !== 'macos' && platform !== 'windows')) return;
    let current = true;
    void invokeListLocalFileApps().then(
      result => { if (current) setApps(result); },
      () => { if (current) setApps([]); },
    );
    return () => { current = false; };
  }, [open, platform, remote]);

  const run = (action: () => Promise<void>, error: LocaleKey) => {
    void action().catch(() => toast.error(t(error)));
  };
  const openPath = () => run(() => invokeOpenPath(path), 'ai.path.openFailed');
  const openWith = (app: LocalFileApp) =>
    run(() => invokeOpenLocalFileWith(reference, app), 'ai.path.openFailed');
  const revealPath = () => run(() => invokeRevealPath(path), 'ai.path.revealFailed');
  const revealRemotePath = () => {
    if (!desktop || !remoteProfile || !routeKey) return;
    const { segments } = parsePosixPath(path);
    const name = segments[segments.length - 1]?.name;
    const entryName = name && name !== '.' && name !== '..' ? name : undefined;
    const directory = entryName ? parentPosixPath(path) : path;
    if (!openHostPath(remoteProfile, directory, 'sftp', 'remote', { path: directory, entryName, routeKey })) {
      toast.error(t('ai.path.sftpRouteUnavailable'));
    }
  };
  const activatePath = remote ? revealRemotePath : openPath;
  const copy = async (value: string) => {
    await writeClipboardText(value);
    toast.success(t('common.copied'));
  };
  const saveAs = () => run(async () => {
    if (await invokeSaveLocalFileAs(path, t('ai.path.saveAs'))) toast.success(t('ai.path.saved'));
  }, 'ai.path.saveFailed');
  const revealLabel = mac ? 'ai.path.revealFinder'
    : platform === 'windows' ? 'ai.path.revealExplorer' : 'ai.path.revealFileManager';
  const Tag = inlineCode ? 'code' : 'a';
  const triggerProps: ComponentProps<'a'> = {
    role: 'link',
    tabIndex: 0,
    className: cn(inlineCode && 'ai-markdown-inline-code', 'ai-markdown-local-path'),
    'aria-keyshortcuts': 'Shift+F10',
    'aria-description': inlineCode && !remote ? t(mac ? 'ai.path.openWithCommand' : 'ai.path.openWithCtrl') : undefined,
    onClick: event => {
      if (desktop && (!inlineCode || (mac ? event.metaKey : event.ctrlKey))) activatePath();
    },
    onKeyDown: event => {
      if (event.key === 'Enter' && desktop) activatePath();
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const { left, bottom } = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: left,
          clientY: bottom,
          button: 2,
        }));
      }
    },
  };
  const copyPathItem = (
    <ContextMenuItem onClick={() => run(() => copy(path), 'ai.path.copyFailed')}><Copy />{t('ai.path.copy')}</ContextMenuItem>
  );

  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger render={<Tag {...triggerProps}>{children}</Tag>} />
      <ContextMenuContent className={cn('file-action-menu', !remote && 'w-56 min-w-0')} aria-label={t('ai.path.menu')}>
        {remote ? (
          <ContextMenuGroup>
            {copyPathItem}
            <ContextMenuItem onClick={revealRemotePath} disabled={!desktop || !remoteProfile || !routeKey}>
              <FolderOpen />{t('ai.path.revealSftp')}
            </ContextMenuItem>
          </ContextMenuGroup>
        ) : (
          <>
            <ContextMenuGroup>
              <ContextMenuItem onClick={openPath} disabled={!desktop}><FolderOpen />{t('ai.path.open')}</ContextMenuItem>
              {apps.includes('vsCode') && (
                <ContextMenuItem onClick={() => openWith('vsCode')}><Code />{t('ai.path.openInVsCode')}</ContextMenuItem>
              )}
              <ContextMenuSub>
                <ContextMenuSubTrigger><AppWindow />{t('ai.path.openWith')}</ContextMenuSubTrigger>
                <ContextMenuSubContent className="file-action-menu" aria-label={t('ai.path.openWith')}>
                  <ContextMenuGroup>
                    <ContextMenuItem onClick={openPath} disabled={!desktop}><AppWindow />{t('ai.path.defaultApp')}</ContextMenuItem>
                    {mac && <ContextMenuItem onClick={revealPath} disabled={!desktop}><FolderOpen />{t('ai.path.app.finder')}</ContextMenuItem>}
                    {apps.map(app => {
                      const { Icon, label } = appOptions[app];
                      return <ContextMenuItem key={app} onClick={() => openWith(app)}><Icon />{t(label)}</ContextMenuItem>;
                    })}
                  </ContextMenuGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={saveAs} disabled={!desktop}><Save />{t('ai.path.saveAs')}</ContextMenuItem>
              {copyPathItem}
              <ContextMenuItem
                onClick={() => run(async () => copy(await invokeReadLocalFileText(path)), 'ai.path.copyContentsFailed')}
                disabled={!desktop}
              >
                <FileText />{t('ai.path.copyContents')}
              </ContextMenuItem>
              <ContextMenuItem onClick={revealPath} disabled={!desktop}><FolderOpen />{t(revealLabel)}</ContextMenuItem>
            </ContextMenuGroup>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
