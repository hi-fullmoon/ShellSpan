import { useEffect, useEffectEvent, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
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
import { sshRouteKey } from '@/lib/connections/ssh-route';
import { findSftpPaneForLocation, openHostPath } from '@/lib/host/host-quick-actions';
import {
  buildRemoteConnectionRequest,
  invokeInspectLocalPath,
  invokeInspectRemotePath,
  invokeListLocalFileApps,
  invokeOpenLocalFileWith,
  invokeOpenPath,
  invokeReadLocalFileText,
  invokeRevealPath,
  invokeSaveLocalFileAs,
  isTauriRuntime,
  type ExistingPathKind,
  type LocalFileApp,
} from '@/lib/ipc/tauri';
import { getPlatform } from '@/lib/platform';
import { parentPosixPath, parsePosixPath } from '@/lib/path-utils';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import { useProfileStore } from '@/stores/profileStore';
import { getSftpPaneConnection, useSftpStore } from '@/stores/sftpStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { RemoteConnectionRequest } from '@/types';
import type { AgentSessionTarget } from '@/types/agent-session';

const appOptions = {
  vsCode: { label: 'ai.path.app.vsCode', Icon: Code },
  terminal: { label: 'ai.path.app.terminal', Icon: SquareTerminal },
  iterm: { label: 'ai.path.app.iterm', Icon: SquareTerminal },
  xcode: { label: 'ai.path.app.xcode', Icon: Code },
  androidStudio: { label: 'ai.path.app.androidStudio', Icon: Code },
  systemPicker: { label: 'ai.path.chooseApp', Icon: AppWindow },
} satisfies Record<LocalFileApp, { label: LocaleKey; Icon: typeof AppWindow }>;

type PathInspection = { path: string; sessionId?: string } & (
  | { kind: 'local' }
  | { kind: 'remote'; sessionId: string; connection: RemoteConnectionRequest }
);

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
  const paneConnection = useSftpStore(state => {
    if (!inlineCode || !remoteProfile || !routeKey) return;
    const pane = findSftpPaneForLocation(state.connections, remoteProfile.id, routeKey);
    if (pane) return getSftpPaneConnection(pane.connection, pane.side);
  });
  const platform = getPlatform();
  const mac = platform === 'macos';
  const desktop = isTauriRuntime();
  const [open, setOpen] = useState(false);
  const [verification, setVerification] = useState<{ inspection: PathInspection; kind: ExistingPathKind }>();
  const [directActivation, setDirectActivation] = useState<PathInspection>();
  const [apps, setApps] = useState<LocalFileApp[]>([]);
  const sessionId = target?.sessionId;
  const inspection = useMemo<PathInspection | undefined>(() => {
    if (!inlineCode || !desktop) return;
    if (!remote) return { kind: 'local', path, sessionId };
    if (!sessionId || !remoteProfile || !routeKey) return;
    const connection = paneConnection ?? (sshRouteKey(remoteProfile) === routeKey ? buildRemoteConnectionRequest(remoteProfile) : undefined);
    if (connection) return { kind: 'remote', path, sessionId, connection };
  }, [desktop, inlineCode, paneConnection, path, remote, remoteProfile, routeKey, sessionId]);
  const confirmedKind = verification?.inspection === inspection ? verification?.kind : undefined;
  const localActions = !remote && (!inlineCode || confirmedKind !== undefined);
  const fileActions = !inlineCode || confirmedKind === 'file';
  useEffect(() => {
    if (!localActions || !open || (platform !== 'macos' && platform !== 'windows')) return;
    let current = true;
    void invokeListLocalFileApps().then(
      result => { if (current) setApps(result); },
      () => { if (current) setApps([]); },
    );
    return () => { current = false; };
  }, [localActions, open, platform]);

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
  const activateInspectedPath = useEffectEvent((checked: PathInspection) => {
    if (inspection === checked && !open) activatePath();
  });

  useEffect(() => {
    if (!inspection || (!open && directActivation !== inspection)) return;
    let current = true;
    const check = inspection.kind === 'remote'
      ? invokeInspectRemotePath(inspection.sessionId, inspection.connection, inspection.path)
      : invokeInspectLocalPath(inspection.path);
    void check.catch(() => null).then(kind => {
      if (!current) return;
      if (open) {
        if (kind) setVerification({ inspection, kind });
      } else {
        setDirectActivation(undefined);
        if (kind) activateInspectedPath(inspection);
      }
    });
    return () => { current = false; };
  }, [directActivation, inspection, open]);

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
    role: inlineCode ? 'button' : 'link',
    'aria-haspopup': inlineCode ? 'menu' : undefined,
    tabIndex: 0,
    className: cn(inlineCode && 'ai-markdown-inline-code', (!inlineCode || confirmedKind) && 'ai-markdown-local-path'),
    'aria-keyshortcuts': 'Shift+F10',
    'aria-description': inlineCode && confirmedKind && !remote ? t(mac ? 'ai.path.openWithCommand' : 'ai.path.openWithCtrl') : undefined,
    onClick: event => {
      if (!desktop) return;
      if (!inlineCode) activatePath();
      else if (inspection && (mac ? event.metaKey : event.ctrlKey)) setDirectActivation(inspection);
    },
    onKeyDown: event => {
      if (event.key === 'Enter' && desktop && !inlineCode) activatePath();
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
        || (inlineCode && (event.key === 'Enter' || event.key === ' '))) {
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
  const remoteAction = remote && (!inlineCode || confirmedKind) && (
    <ContextMenuItem onClick={revealRemotePath} disabled={!desktop || !remoteProfile || !routeKey}>
      <FolderOpen />{t('ai.path.revealSftp')}
    </ContextMenuItem>
  );

  return (
    <ContextMenu open={open} onOpenChange={nextOpen => {
      setVerification(undefined);
      setDirectActivation(undefined);
      setOpen(nextOpen);
    }}>
      <ContextMenuTrigger render={<Tag {...triggerProps}>{children}</Tag>} />
      <ContextMenuContent className={cn('file-action-menu', !remote && 'w-56 min-w-0')} aria-label={t('ai.path.menu')}>
        {inlineCode && <ContextMenuGroup>{copyPathItem}{remoteAction}</ContextMenuGroup>}
        {localActions && (
          <>
            {inlineCode && <ContextMenuSeparator />}
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
          </>
        )}
        {(!inlineCode || localActions) && <ContextMenuGroup>
          {localActions && fileActions && <ContextMenuItem onClick={saveAs} disabled={!desktop}><Save />{t('ai.path.saveAs')}</ContextMenuItem>}
          {!inlineCode && copyPathItem}
          {localActions && fileActions && <ContextMenuItem
            onClick={() => run(async () => copy(await invokeReadLocalFileText(path)), 'ai.path.copyContentsFailed')}
            disabled={!desktop}
          >
            <FileText />{t('ai.path.copyContents')}
          </ContextMenuItem>}
          {localActions && <ContextMenuItem onClick={revealPath} disabled={!desktop}><FolderOpen />{t(revealLabel)}</ContextMenuItem>}
          {!inlineCode && remoteAction}
        </ContextMenuGroup>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
