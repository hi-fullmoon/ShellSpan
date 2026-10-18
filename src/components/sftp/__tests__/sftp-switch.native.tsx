import React from 'react';
import { flushSync } from 'react-dom';
import type { Root } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SftpContent } from '../index';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSftpStore, getSftpPaneConnectionKey, type SftpConnection } from '@/stores/sftpStore';
import { useTransferStore, type TransferOperation } from '@/stores/transferStore';
import { useAppStore } from '@/stores/appStore';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useSftpPaneActions } from '@/hooks/useSftpPaneActions';
import { useTransferListeners } from '@/hooks/useTransferListeners';
import { invokeCheckHostKey, invokeTrustHost, invokeRemoveKnownHost, invokeDisconnectSftp } from '@/lib/ipc/tauri';
import type { SftpCancellationConfig } from './sftp-cancellation.contract';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

// Exercise the production component, real Tauri drop events and two real SSH
// servers. Only user input and navigation are automated; no transport doubles.
export async function verifySftpSwitch(root: Root, original: SftpConnection, config: SftpCancellationConfig, isInterrupted: () => boolean) {
  let hooks: ReturnType<typeof useSftpConnection> | undefined;
  let actions: ReturnType<typeof useSftpPaneActions> | undefined;
  const target = '/home/shellspan/switch-target';
  const elsewhere = '/home/shellspan/elsewhere';
  const remoteB = { ...original.connection, port: config.switchPort };
  let trusted = false;
  // Completed rows dismiss after two seconds; retain observed terminal states
  // while the real UI checks run so dismissal cannot hide transfer completion.
  const statuses = new Map<string, TransferOperation['status']>();
  const unsubscribe = useTransferStore.subscribe((state) => {
    for (const operation of state.operations) statuses.set(operation.operationId, operation.status);
  });
  const until = async (check: () => boolean, message: string, timeout = 180_000) => {
    const deadline = performance.now() + timeout;
    while (!check()) {
      assert(!isInterrupted(), 'Switch regression interrupted');
      assert(performance.now() < deadline, message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const current = () => useSftpStore.getState().connections.find((item) => item.id === original.id)!;
  function Surface() {
    const connection = useSftpStore((state) => state.connections.find((item) => item.id === original.id));
    assert(connection, 'Missing switch regression connection');
    hooks = useSftpConnection(connection);
    actions = useSftpPaneActions(connection, 'remote', false);
    useTransferListeners();
    return <TooltipProvider><div id="switch-surface" style={{ height: '100vh' }}><SftpContent
      connection={connection} newConnectionMenuOpen={false} setNewConnectionMenuOpen={() => {}}
      tabContextMenu={null} setTabContextMenu={() => {}}
      openSftpConnection={async () => {}} verifyHostKey={async () => {}}
    /></div></TooltipProvider>;
  }
  const drop = async (path: string) => {
    await getCurrentWindow().emit('tauri://drag-drop', {
      paths: [path], position: { x: innerWidth * 0.75, y: innerHeight * 0.5 },
    });
  };
  const stage = async (name: string) => {
    const token = new URLSearchParams(location.search).get('token');
    const response = await fetch(`/__sftp-stage/${token}`, { method: 'POST', body: JSON.stringify(name) });
    assert(response.ok, 'Test stage acknowledgement failed');
  };
  try {
    await stage('switch-active');
    useAppStore.setState({ sftpConflictPolicy: 'ask' });
    const key = await invokeCheckHostKey(remoteB.host, remoteB.port);
    assert(key.status === 'notFound' && key.fingerprint === config.switchFingerprint, 'Unexpected second SSH identity');
    await invokeTrustHost(remoteB.host, remoteB.port, config.switchFingerprint);
    trusted = true;
    flushSync(() => {
      useTransferStore.setState({ operations: [] });
      useSftpStore.getState().setPath(original.id, 'local', config.inputDirectory);
      root.render(<Surface />);
    });
    assert(hooks, 'Production hooks not mounted');
    await hooks.loadRemoteDirectory(target);
    await hooks.uploadLocalPaths([config.smallC], target, 'seed-switch-conflict', ['fail']);
    await hooks.loadRemoteDirectory(target);
    useTransferStore.setState({ operations: [] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await drop(config.largeA);
    await until(() => useTransferStore.getState().operations.some((item) => item.status === 'running' && item.processedBytes > 0), 'Upload did not start through production drop handler');
    const large = useTransferStore.getState().operations.find((item) => item.status === 'running')!;
    await drop(config.smallB);
    await until(() => useTransferStore.getState().operations.some((item) => item.status === 'pending'), 'Second drop was not queued');
    const queued = useTransferStore.getState().operations.find((item) => item.status === 'pending')!;
    await hooks.loadRemoteDirectory(elsewhere);
    assert(useTransferStore.getState().operations.find((item) => item.operationId === large.operationId)?.status === 'running', 'Upload finished before host switch could be exercised');
    flushSync(() => useSftpStore.getState().attachRemoteConnection(original.id, 'remote', {
      sessionId: 'switch-b-active', title: 'Server B', host: remoteB.host, port: remoteB.port, username: remoteB.username,
    }, remoteB));
    await hooks.loadRemoteDirectory(elsewhere);
    useSftpStore.getState().setPaneState(original.id, 'remote', { selectedPaths: [elsewhere] });
    const widths: number[] = [];
    await stage('switch-tooltip');
    const surface = document.getElementById('switch-surface')!;
    for (const width of [1200, 720]) {
      surface.style.width = `${width}px`;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const trigger = document.querySelector<HTMLElement>('[data-slot="transfer-task-row"] span[tabindex="0"]');
      assert(trigger, 'Transfer route has no keyboard-accessible tooltip trigger');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      trigger.focus();
      assert(document.activeElement === trigger, 'Transfer route cannot receive keyboard focus');
      trigger.dispatchEvent(new MouseEvent('mouseenter'));
      trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      await until(() => Boolean(document.querySelector('[data-slot="tooltip-content"][data-open]')), 'Transfer route tooltip did not open', 5000);
      const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-content"][data-open]')!;
      assert(tooltip.textContent?.includes(target) && tooltip.textContent.includes(String(config.port)), 'Route tooltip lost original host/directory');
      const bounds = tooltip.getBoundingClientRect();
      assert(bounds.left >= 0 && bounds.right <= innerWidth + 1, 'Route tooltip clipped at window edge');
      widths.push(surface.clientWidth);
      await stage(width === 1200 ? 'capture-wide' : 'capture-narrow');
      trigger.blur();
      trigger.dispatchEvent(new MouseEvent('mouseleave'));
    }
    surface.style.width = '100%';
    await until(() => statuses.get(queued.operationId) === 'completed', 'Queued upload did not complete after directory switch');
    assert(current().remotePath === elsewhere, 'Completed upload navigated back to old directory');
    assert(current().remotePane.selectedPaths.includes(elsewhere), 'Completed upload cleared current selection');
    assert(statuses.get(large.operationId) === 'completed', 'Active upload failed after directory switch');

    await stage('switch-conflict');
    flushSync(() => useSftpStore.getState().attachRemoteConnection(original.id, 'remote', {
      sessionId: 'switch-a-conflict', title: 'Server A', host: original.connection.host, port: original.connection.port, username: original.connection.username,
    }, original.connection));
    await hooks.loadRemoteDirectory(target);
    await drop(config.smallC);
    await until(() => Boolean(document.querySelector('[role="dialog"]')), 'Expected original destination conflict');
    flushSync(() => useSftpStore.getState().attachRemoteConnection(original.id, 'remote', {
      sessionId: 'switch-b', title: 'Server B', host: remoteB.host, port: remoteB.port, username: remoteB.username,
    }, remoteB));
    await hooks.loadRemoteDirectory(elsewhere);
    useSftpStore.getState().setPaneState(original.id, 'remote', { selectedPaths: [elsewhere] });
    const overwrite = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '覆盖');
    assert(overwrite, 'Missing production conflict action');
    overwrite.click();
    await until(() => !document.querySelector('[role="dialog"]') && !useTransferStore.getState().operations.some((item) => item.status === 'running' || item.status === 'pending'), 'Conflict batch did not settle after host switch');
    assert(!useTransferStore.getState().operations.some((item) => item.status === 'failed'), 'A switch transfer failed');
    assert(current().connection.port === config.switchPort && current().remotePath === elsewhere, 'Original task changed new host/directory');
    assert(current().remotePane.selectedPaths.includes(elsewhere), 'Original task cleared new host selection');

    await stage('switch-download');
    flushSync(() => useSftpStore.getState().attachRemoteConnection(original.id, 'remote', {
      sessionId: 'download-a', title: 'Server A', ...original.connection,
    }, original.connection));
    await hooks.loadRemoteDirectory(target);
    const downloadId = 'switch-download';
    const download = hooks.downloadRemotePaths([`${target}/cancel-a.bin`], config.downloadDirectory, downloadId, ['fail']);
    await until(() => (useTransferStore.getState().operations.find((item) => item.operationId === downloadId)?.processedBytes ?? 0) > 0, 'Download did not transfer bytes before host switch');
    flushSync(() => useSftpStore.getState().attachRemoteConnection(original.id, 'remote', {
      sessionId: 'download-b', title: 'Server B', ...remoteB,
    }, remoteB));
    await hooks.loadRemoteDirectory(elsewhere);
    await download;
    assert(statuses.get(downloadId) === 'completed', 'Download failed after source host switch');
    assert(current().connection.port === config.switchPort && current().remotePath === elsewhere, 'Download completion changed current host/directory');

    await stage('switch-copy');
    flushSync(() => {
      useSftpStore.getState().attachRemoteConnection(original.id, 'local', {
        sessionId: 'copy-source-a', title: 'Server A', ...original.connection,
      }, original.connection);
      useSftpStore.getState().setRemoteClipboard(original.id, {
        sourcePath: `${target}/cancel-a.bin`, sourceName: 'cancel-a.bin', kind: 'file', sourceSide: 'local',
        sourceConnection: original.connection, sourceConnectionKey: getSftpPaneConnectionKey(original, 'remote'),
      });
    });
    await hooks.loadRemoteDirectory(target);
    assert(actions, 'Production paste action not mounted');
    const copy = actions.onPaste();
    await until(() => useTransferStore.getState().operations.some((item) => item.kind === 'remote-copy' && item.status === 'running' && item.processedBytes > 0), 'Cross-host copy did not transfer bytes before switch');
    const copyId = useTransferStore.getState().operations.find((item) => item.kind === 'remote-copy' && item.status === 'running')!.operationId;
    flushSync(() => useSftpStore.getState().attachRemoteConnection(original.id, 'remote', {
      sessionId: 'copy-destination-a', title: 'Server A', ...original.connection,
    }, original.connection));
    await hooks.loadRemoteDirectory(elsewhere);
    useSftpStore.getState().setPaneState(original.id, 'remote', { selectedPaths: [elsewhere] });
    await copy;
    assert(statuses.get(copyId) === 'completed', 'Cross-host copy failed after destination switch');
    assert(current().connection.port === original.connection.port && current().remotePath === elsewhere, 'Copy completion changed current host/directory');
    assert(current().remotePane.selectedPaths.includes(elsewhere), 'Copy completion cleared current selection');
    await stage('switch-complete');
    return { activeAndQueuedHostAndDirectorySwitch: true, conflictHostSwitch: true, downloadHostSwitch: true, crossHostCopySwitch: true, currentSelectionPreserved: true, tooltipWidths: widths };
  } finally {
    unsubscribe();
    useAppStore.setState({ sftpConflictPolicy: 'ask' });
    await invokeDisconnectSftp(remoteB);
    if (trusted) await invokeRemoveKnownHost(remoteB.host, remoteB.port);
  }
}
