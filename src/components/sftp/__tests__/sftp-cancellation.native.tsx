import React from 'react';
import Ajv from 'ajv';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useTransferListeners } from '@/hooks/useTransferListeners';
import { TransferProgress } from '@/components/sftp/transfer-progress';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useSftpStore, getSftpPaneConnectionKey, type SftpConnection } from '@/stores/sftpStore';
import { runPathOperation, cancelQueuedPathOperation, useTransferStore } from '@/stores/transferStore';
import {
  invokeCheckHostKey, invokeTrustHost, invokeRemoveKnownHost, invokeListKnownHosts,
  invokeDisconnectSftp, invokeTrashLocalPaths, isTauriRuntime,
} from '@/lib/ipc/tauri';
import { configSchema, type SftpCancellationConfig } from './sftp-cancellation.contract';
import '@/styles/base.css';
import { verifySftpSwitch } from './sftp-switch.native';

interface Observation {
  started: number;
  settled?: number;
  status?: string;
  processedBytes?: number;
  totalBytes?: number;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function verify(): Promise<void> {
  const token = new URLSearchParams(location.search).get('token');
  assert(token, 'Missing runner token');
  const observations: Record<string, Observation> = {};
  const tasks: Promise<void | undefined>[] = [];
  const cancellations: string[] = [];
  const cleanupErrors: string[] = [];
  let config: SftpCancellationConfig | undefined;
  let remote: SftpConnection['connection'] | undefined;
  let connection: SftpConnection | undefined;
  let hooks: ReturnType<typeof useSftpConnection> | undefined;
  let trusted = false;
  let interrupted = false;
  let controlTimer: ReturnType<typeof setTimeout> | undefined;
  let resultPosted = false;
  const root = createRoot(document.getElementById('root')!);
  const outcome: Record<string, unknown> = { ok: false, observations, cancellations };

  const operation = (id: string) => useTransferStore.getState().operations.find((item) => item.operationId === id);
  const until = async (check: () => boolean, diagnostic: string) => {
    const deadline = performance.now() + 120_000;
    while (!check()) {
      assert(!interrupted, 'Runner interrupted the native test');
      assert(performance.now() < deadline, diagnostic);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };
  const stopTasks = async () => {
    if (!connection) return;
    const owned = useTransferStore.getState().operations.filter((op) => op.ownerId === connection?.id);
    for (const op of owned.filter((item) => item.status === 'pending')) {
      useTransferStore.getState().removeOperation(op.operationId);
    }
    await Promise.all(owned.filter((op) => op.status === 'running' && op.cancel)
      .map((op) => useTransferStore.getState().cancelOperation(op.operationId)));
  };
  const pollControl = async () => {
    try {
      const response = await fetch(`/__sftp-control/${token}`);
      const command: unknown = await response.json();
      if (command && typeof command === 'object' && 'abort' in command && command.abort === true) {
        interrupted = true;
        await stopTasks();
      }
    } catch {
      interrupted = true;
      await stopTasks();
    }
    if (!resultPosted) controlTimer = setTimeout(() => void pollControl(), 500);
  };
  function Surface() {
    assert(connection, 'Missing live SFTP connection');
    hooks = useSftpConnection(connection);
    useTransferListeners();
    return <TooltipProvider><TransferProgress /></TooltipProvider>;
  }

  try {
    assert(isTauriRuntime(), 'This regression requires a native Tauri window');
    const response = await fetch(`/__sftp-config/${token}`);
    assert(response.ok, 'Runner configuration request failed');
    const candidate: unknown = await response.json();
    const validate = new Ajv().compile(configSchema);
    assert(validate(candidate), 'Invalid runner configuration');
    config = candidate;
    remote = { host: '127.0.0.1', port: config.port, username: 'shellspan', authMethod: 'password', password: config.password };
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN', sftpRetryCount: 0, sftpCompletionNotification: false });
    const key = await invokeCheckHostKey(remote.host, remote.port);
    assert(key.status === 'notFound', 'Test port already has a saved host identity; refusing to change it');
    assert(key.fingerprint === config.fingerprint, 'Host fingerprint differs from ssh-keygen on the isolated server');
    await invokeTrustHost(remote.host, remote.port, config.fingerprint);
    trusted = true;
    useSftpStore.getState().addConnection({
      sessionId: crypto.randomUUID(), title: 'Isolated SSH cancellation regression',
      host: remote.host, port: remote.port, username: remote.username,
    }, remote);
    const connections = useSftpStore.getState().connections;
    connection = connections[connections.length - 1];
    assert(connection, 'SFTP connection was not created');
    flushSync(() => root.render(<Surface />));
    assert(hooks, 'SFTP hook was not mounted');
    await hooks.loadRemoteDirectory('/home/shellspan/upload');
    void pollControl();
    const scopes = [{ connectionId: getSftpPaneConnectionKey(connection, 'remote'), paths: ['/home/shellspan/upload'] }];
    const currentConnection = connection;
    const currentHooks = hooks;
    const currentConfig = config;
    const enqueue = (id: string, path: string, kind: 'upload' | 'download') => {
      const task = runPathOperation(scopes, async () => {
        observations[id] = { started: performance.now() };
        if (kind === 'upload') await currentHooks.uploadLocalPaths([path], '/home/shellspan/upload', id, ['fail']);
        else await currentHooks.downloadRemotePaths([path], currentConfig.downloadDirectory, id, ['fail']);
        const op = operation(id);
        assert(op, `Missing transfer record: ${id}`);
        observations[id] = {
          ...observations[id], settled: performance.now(), status: op.status,
          processedBytes: op.processedBytes, totalBytes: op.totalBytes,
        };
      }, {
        queueKey: id, ownerId: currentConnection.id,
        onQueued: () => useTransferStore.getState().addOperation({
          operationId: id, kind, ownerId: currentConnection.id, currentPath: path, status: 'pending',
          totalBytes: 0, processedBytes: 0, totalSteps: 1, completedSteps: 0,
          cancel: async () => {
            cancelQueuedPathOperation(id);
            useTransferStore.getState().removeOperation(id);
          },
        }),
      });
      // Retain every task for failure cleanup without letting early rejection go unhandled.
      void task.catch(() => {});
      tasks.push(task);
      return task;
    };
    const cancelCurrent = (id: string) => {
      assert(operation(id)?.status === 'running', `${id} is not running`);
      const row = document.querySelector('[data-slot="transfer-task-row"]');
      const cancel = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((button) => button.textContent === '取消');
      assert(cancel, `Missing real cancel button: ${id}`);
      cancellations.push(id);
      cancel.click();
    };
    const checkQueue = (prefix: string) => {
      const cancelled = observations[`${prefix}-cancel`];
      const next = observations[`${prefix}-next`];
      const tail = observations[`${prefix}-tail`];
      assert(cancelled?.status === 'cancelled', `${prefix} did not reach cancelled`);
      assert(cancelled.processedBytes! > 0 && cancelled.processedBytes! < cancelled.totalBytes!, `${prefix} did not cancel during byte transfer`);
      assert(next?.status === 'completed' && tail?.status === 'completed', `${prefix} queue did not continue`);
      assert(next.started >= cancelled.settled! && tail.started >= next.settled!, `${prefix} queue advanced before its previous worker exited`);
    };

    const uploads = [
      enqueue('upload-cancel', config.largeA, 'upload'),
      enqueue('upload-next', config.smallB, 'upload'),
      enqueue('upload-tail', config.smallC, 'upload'),
    ];
    await until(() => (operation('upload-cancel')?.processedBytes ?? 0) > 0 && !!document.querySelector('[data-slot="progress"]'), 'No upload progress');
    assert(operation('upload-next')?.status === 'pending' && operation('upload-tail')?.status === 'pending', 'Uploads were not actually queued');
    cancelCurrent('upload-cancel');
    await Promise.all(uploads);
    checkQueue('upload');
    flushSync(() => useTransferStore.setState({ operations: [] }));

    const raceFirst = enqueue('race-first', config.raceA, 'upload');
    const raceNext = enqueue('race-next', config.raceB, 'upload');
    await until(() => (operation('race-first')?.processedBytes ?? 0) > 0, 'No SSH race upload progress');
    const oldCancel = [...document.querySelector('[data-slot="transfer-task-row"]')!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '取消');
    assert(oldCancel, 'Missing original cancel control');
    await raceFirst;
    await until(() => (operation('race-next')?.processedBytes ?? 0) > 0 && !oldCancel.isConnected, 'Old task control was not detached before next SSH task started');
    oldCancel.click();
    assert(operation('race-next')?.status === 'running', 'Stale control cancelled the next task');
    await raceNext;
    assert(observations['race-next'].status === 'completed', 'Next SSH task did not finish');
    outcome.staleControlDetached = !oldCancel.isConnected;
    flushSync(() => useTransferStore.setState({ operations: [] }));

    const downloads = [
      enqueue('download-cancel', '/home/shellspan/upload/race-a.bin', 'download'),
      enqueue('download-next', '/home/shellspan/upload/queue-next.json', 'download'),
      enqueue('download-tail', '/home/shellspan/upload/queue-tail.lock', 'download'),
    ];
    await until(() => (operation('download-cancel')?.processedBytes ?? 0) > 0 && !!document.querySelector('[data-slot="progress"]'), 'No download progress');
    assert(operation('download-next')?.status === 'pending' && operation('download-tail')?.status === 'pending', 'Downloads were not actually queued');
    cancelCurrent('download-cancel');
    await Promise.all(downloads);
    checkQueue('download');
    outcome.switching = await verifySftpSwitch(root, connection, config, () => interrupted);
    outcome.ok = true;
  } catch (error) {
    outcome.error = message(error);
  } finally {
    resultPosted = true;
    clearTimeout(controlTimer);
    try { await stopTasks(); await Promise.allSettled(tasks); } catch (error) { cleanupErrors.push(message(error)); }
    if (remote) {
      try { await invokeDisconnectSftp(remote); } catch (error) { cleanupErrors.push(message(error)); }
      if (trusted) {
        try {
          await invokeRemoveKnownHost(remote.host, remote.port);
          assert(!(await invokeListKnownHosts()).some((host) => host.host === remote!.host && host.port === remote!.port), 'Temporary host trust was not removed');
        } catch (error) { cleanupErrors.push(message(error)); }
      }
    }
    root.unmount();
    outcome.cleanupErrors = cleanupErrors;
    outcome.nativeCleanupComplete = cleanupErrors.length === 0;
    if (cleanupErrors.length) outcome.ok = false;
    const response = await fetch(`/__sftp-result/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(outcome),
    });
    assert(response.ok, 'Runner result acknowledgement failed');
    const cleanup: unknown = await response.json();
    let filesCleaned = false;
    if (config && cleanup && typeof cleanup === 'object' && 'trashInputs' in cleanup && cleanup.trashInputs === true) {
      await invokeTrashLocalPaths([config.inputDirectory, config.downloadDirectory]);
      filesCleaned = true;
    }
    await fetch(`/__sftp-cleanup/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, filesCleaned }),
    });
    await getCurrentWindow().close();
  }
}

void verify().catch((error: unknown) => {
  const token = new URLSearchParams(location.search).get('token');
  void fetch(`/__sftp-cleanup/${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: message(error) }),
  });
});
