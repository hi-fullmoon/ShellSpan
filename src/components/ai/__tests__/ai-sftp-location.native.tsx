import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { AiMarkdownTargetContext, AssistantMessageContent } from '@/components/ai/assistant-message-content';
import Sftp from '@/components/sftp';
import Workbench from '@/components/workbench';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  buildSessionCreateRequest,
  invokeAddProfile,
  invokeCloseSession,
  invokeCreateSession,
  invokeInspectRemotePath,
  invokePreviewRemoteFile,
  invokeUpdateProfile,
  isTauriRuntime,
} from '@/lib/ipc/tauri';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { ConnectionProfile, SessionSummary } from '@/types';
import '@/styles/base.css';

interface Fixture {
  password: string;
  targetHost: string;
  fileName: string;
  firstRouteFileName: string;
  localFile: string;
  routes: [{ port: number; hostname: string }, { port: number; hostname: string }];
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function until<T>(get: () => T | undefined | false, message: string): Promise<T> {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const value = get();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function activeSftpConnection(): SftpConnection | undefined {
  const { activeConnectionId, connections } = useSftpStore.getState();
  return connections.find(connection => connection.id === activeConnectionId);
}

async function verify() {
  assert(isTauriRuntime(), 'Expected a native WebView');
  const fixture: Fixture = await fetch(`${location.pathname}/config`).then(response => response.json());
  const { password, targetHost, fileName, firstRouteFileName, localFile, routes: [first, second] } = fixture;
  await initI18n('zh-CN');
  useAppStore.setState({ locale: 'zh-CN', sftpShowHiddenFiles: false, restoreWorkspace: false });

  const profileId = crypto.randomUUID();
  const createdAt = Date.now();
  const username = 'shellspan';
  const home = `/home/${username}`;
  const directory = `${home}/upload`;
  const file = `${directory}/${fileName}`;
  const firstRouteFile = `${directory}/${firstRouteFileName}`;
  const missingLocalFile = `${localFile}.${profileId}`;
  const container = document.getElementById('root');
  assert(container, 'No WebView mount');
  const root = createRoot(container);
  const terminalIds: string[] = [];

  const connect = async (jumpPort: number): Promise<SessionSummary> => {
    const jumpHost = { host: '127.0.0.1', port: jumpPort, username, authMethod: 'password' as const };
    const row = {
      id: profileId, name: 'Isolated OpenSSH', host: targetHost, port: 22, username,
      authMethod: 'password' as const, createdAt, updatedAt: Date.now(),
      jumpHostConfig: JSON.stringify(jumpHost),
    };
    if (terminalIds.length === 0) await invokeAddProfile(row);
    else await invokeUpdateProfile(profileId, row);
    const profile: ConnectionProfile = { ...row, password, jumpHost: { ...jumpHost, password } };
    // The disposable passwords stay in memory and are only used by this run.
    useProfileStore.setState({ profiles: [profile], initialized: true });
    const summary = await invokeCreateSession(buildSessionCreateRequest(profile, 120, 30), null);
    terminalIds.push(summary.sessionId);
    useTerminalStore.getState().addSession(summary, profileId);
    return summary;
  };

  const showAgentReply = (terminal: SessionSummary) => {
    const { sessionId, host, port, username: login } = terminal;
    flushSync(() => root.render(<TooltipProvider>
      <div hidden><Workbench /></div>
      <AssistantMessageContent blocks={[{ type: 'text', text: `\`${localFile}\`\n\n\`${missingLocalFile}\`` }]} streaming={false} />
      <AiMarkdownTargetContext.Provider value={{ kind: 'remote', sessionId, targetId: `terminal-${sessionId}`, profileId, host, port, username: login }}>
        <AssistantMessageContent blocks={[{ type: 'text', text: `\`${directory}\`\n\n\`${firstRouteFile}\`\n\n[主机名](${file})` }]} streaming={false} />
      </AiMarkdownTargetContext.Provider>
      <div style={{ height: '85vh' }}><Sftp /></div>
    </TooltipProvider>));
  };

  const revealFile = () => {
    const link = [...document.querySelectorAll<HTMLElement>('[role="link"]')].find(element => element.textContent === '主机名');
    assert(link, 'Remote file link is missing');
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  const showInlineMenu = (path: string) => {
    const code = [...document.querySelectorAll<HTMLElement>('code[aria-haspopup="menu"]')]
      .find(element => element.textContent === path);
    assert(code, `Inline path is missing: ${path}`);
    code.focus();
    code.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  };

  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const waitForAction = (label: string) => until(
    () => menuItems().find(item => item.textContent === label && !item.hasAttribute('data-disabled')),
    `Menu action is missing: ${label}`,
  );
  const dismissMenu = async () => {
    const menu = document.querySelector('[role="menu"]');
    assert(menu, 'File menu is missing');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => !menu.isConnected, 'File menu stayed open');
  };

  const verifySelection = async (expected: Fixture['routes'][number]): Promise<SftpConnection> => {
    const connection = await until(() => {
      const current = activeSftpConnection();
      return current?.connection.jumpHost?.port === expected.port
        && current.remotePane.selectedPaths.includes(file) && !current.remotePane.locationRequest ? current : undefined;
    }, `No selected ${fileName} row on jump port ${expected.port}`);
    assert(connection.remotePath === directory, 'SFTP opened the wrong directory');
    await until(() => [...document.querySelectorAll('[data-sftp-pane="remote"] [aria-selected="true"]')]
      .find(row => row.textContent?.includes(fileName)), 'Selected hidden file is not visible');
    const preview = await invokePreviewRemoteFile({ ...connection.connection, path: file, operationId: crypto.randomUUID() });
    assert(preview.content.trim() === expected.hostname, 'SFTP read the file from a different physical host');
    return connection;
  };

  try {
    const terminalA = await connect(first.port);
    showAgentReply(terminalA);
    showInlineMenu(localFile);
    await waitForAction('打开文件');
    await waitForAction('复制文件内容');
    await dismissMenu();

    showInlineMenu(missingLocalFile);
    await waitForAction('复制路径');
    assert(menuItems().length === 1, 'A missing local file offered file actions');
    await dismissMenu();

    showInlineMenu(directory);
    const revealDirectory = await waitForAction('在 SFTP 中定位');
    revealDirectory.click();
    const tabA = await until(() => {
      const connection = activeSftpConnection();
      return connection?.remotePane.selectedPaths.includes(directory) ? connection : undefined;
    }, 'The directory was not selected on the first server');
    assert(tabA.remotePath === home && tabA.connection.jumpHost?.port === first.port, 'Directory was located on the wrong route');

    const oldPane = document.querySelector('[data-sftp-pane="remote"]');
    assert(oldPane, 'Original SFTP pane is missing');
    const paused = await fetch(`${location.pathname}/pause`, { method: 'POST' });
    assert(paused.ok, 'Could not pause the isolated SSH server');
    try {
      revealFile();
      await until(() => activeSftpConnection()?.remoteLoading, 'SFTP did not begin the uncached directory request');
      flushSync(() => useSftpStore.getState().addLocalConnection());
      assert(!oldPane.isConnected, 'Switching tabs did not unmount the pane');
      flushSync(() => useSftpStore.getState().setActiveConnection(tabA.id));
      assert(document.querySelector('[data-sftp-pane="remote"]') !== oldPane, 'Returning did not remount the pane');
    } finally {
      const resumed = await fetch(`${location.pathname}/resume`, { method: 'POST' });
      assert(resumed.ok, 'Could not resume the isolated SSH server');
    }
    assert((await verifySelection(first)).id === tabA.id, 'Switching tabs replaced the original connection');

    const terminalB = await connect(second.port);
    showAgentReply(terminalB);
    revealFile();
    const tabB = await verifySelection(second);
    assert(tabB.id !== tabA.id, 'The new SSH route reused the old SFTP connection');
    showInlineMenu(firstRouteFile);
    await waitForAction('复制路径');
    assert(await invokeInspectRemotePath(terminalB.sessionId, tabB.connection, firstRouteFile) === null,
      'The first route file was found through the second route');
    assert(await invokeInspectRemotePath(terminalB.sessionId, tabA.connection, firstRouteFile) === null,
      'The second terminal accepted a path check over the first jump route');
    assert(menuItems().length === 1, 'A missing remote file offered file actions');
    await dismissMenu();

    showAgentReply(terminalA);
    showInlineMenu(firstRouteFile);
    await waitForAction('在 SFTP 中定位');
    await dismissMenu();
    revealFile();
    assert((await verifySelection(first)).id === tabA.id, 'Editing the saved profile redirected the original SSH session');
  } finally {
    root.unmount();
    await Promise.all(terminalIds.map(sessionId => invokeCloseSession(sessionId)));
  }
}

verify().then(
  () => fetch(`${location.pathname}/result`, { method: 'POST', body: 'PASS' }),
  (error: unknown) => fetch(`${location.pathname}/result`, { method: 'POST', body: String(error) }),
);
