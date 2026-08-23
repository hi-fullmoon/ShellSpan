import {
  invokeClearSftpWorkspace,
  invokeSaveSftpWorkspace,
} from '@/lib/tauri';

let pendingSnapshot: string | null = null;
let operationQueue: Promise<void> = Promise.resolve();

function enqueue(operation: () => Promise<void>): Promise<void> {
  const next = operationQueue.catch(() => {}).then(operation);
  operationQueue = next;
  return next;
}

export function stageSftpWorkspace(snapshot: string): void {
  pendingSnapshot = snapshot;
}

export function flushSftpWorkspace(): Promise<void> {
  if (pendingSnapshot === null) return operationQueue;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  return enqueue(() => invokeSaveSftpWorkspace(snapshot));
}

export function clearSftpWorkspace(): Promise<void> {
  pendingSnapshot = null;
  return enqueue(invokeClearSftpWorkspace);
}
