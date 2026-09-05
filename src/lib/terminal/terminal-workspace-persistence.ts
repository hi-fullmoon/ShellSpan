import {
  invokeClearTerminalWorkspace,
  invokeSaveTerminalWorkspace,
} from '@/lib/ipc/tauri';

let pendingSnapshot: string | null = null;
let operationQueue: Promise<void> = Promise.resolve();

function enqueue(operation: () => Promise<void>): Promise<void> {
  const next = operationQueue.catch(() => {}).then(operation);
  operationQueue = next;
  return next;
}

export function stageTerminalWorkspace(snapshot: string): void {
  pendingSnapshot = snapshot;
}

export function flushTerminalWorkspace(): Promise<void> {
  if (pendingSnapshot === null) return operationQueue;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  return enqueue(() => invokeSaveTerminalWorkspace(snapshot));
}

export function clearTerminalWorkspace(): Promise<void> {
  pendingSnapshot = null;
  return enqueue(invokeClearTerminalWorkspace);
}
