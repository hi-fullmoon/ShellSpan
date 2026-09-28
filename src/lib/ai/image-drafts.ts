import type { AgentImageUpload } from '@/types/agent-image';
import type { AiCreateSessionInput, AiSubmissionMode } from './session-adapter';

export interface ImageDraft {
  readonly originOwner?: string;
  readonly owner: string;
  readonly revision: number;
  readonly text: string;
  readonly images: readonly AgentImageUpload[];
  readonly operation?: {
    readonly id: string;
    readonly createdAtUnixMs?: number;
    readonly targetTurnId?: string;
    readonly sessionId: string;
    readonly mode: AiSubmissionMode;
    readonly create?: Extract<AiCreateSessionInput, { kind: 'agent' }>;
  };
}

const DATABASE_NAME = 'shellspan-image-drafts-v1';
const DRAFT_STORE = 'drafts';
const SESSION_INDEX = 'session';
const activeDetachedOperations = new Map<string, Set<symbol>>();

/** A live submission owns its recovery exclusion. Failure or cancellation
 * releases it; merely writing a detached draft never hides it indefinitely. */
export function holdDetachedImageDraft(operationId: string): () => void {
  const token = Symbol(operationId);
  const owners = activeDetachedOperations.get(operationId) ?? new Set<symbol>();
  owners.add(token);
  activeDetachedOperations.set(operationId, owners);
  return () => {
    owners.delete(token);
    if (!owners.size && activeDetachedOperations.get(operationId) === owners) activeDetachedOperations.delete(operationId);
  };
}

function ensureSchema(request: IDBOpenDBRequest): void {
  const store = request.result.objectStoreNames.contains(DRAFT_STORE)
    ? request.transaction!.objectStore(DRAFT_STORE)
    : request.result.createObjectStore(DRAFT_STORE, { keyPath: 'owner' });
  if (!store.indexNames.contains(SESSION_INDEX)) {
    store.createIndex(SESSION_INDEX, 'operation.sessionId');
  }
}

function requestDatabase(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined
      ? indexedDB.open(DATABASE_NAME)
      : indexedDB.open(DATABASE_NAME, version);
    request.onupgradeneeded = () => ensureSchema(request);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function hasCurrentSchema(db: IDBDatabase): boolean {
  if (!db.objectStoreNames.contains(DRAFT_STORE)) return false;
  return db.transaction(DRAFT_STORE).objectStore(DRAFT_STORE).indexNames.contains(SESSION_INDEX);
}

async function open(): Promise<IDBDatabase> {
  const db = await requestDatabase();
  if (hasCurrentSchema(db)) return db;
  const migrationVersion = db.version + 1;
  db.close();
  return requestDatabase(migrationVersion);
}
export async function readImageDraft(owner: string, exact = false): Promise<ImageDraft | null> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(DRAFT_STORE).objectStore(DRAFT_STORE);
      const request = store.get(owner);
      request.onsuccess = () => {
        if (exact || request.result?.images.length) { resolve(request.result ?? null); return; }
        const bound = owner.startsWith('agent:') ? store.index(SESSION_INDEX).getAll(owner.slice('agent:'.length)) : store.getAll();
        bound.onsuccess = () => resolve((bound.result as ImageDraft[])
          .filter(value => owner.startsWith('agent:') || value.originOwner === owner)
          .sort((a, b) => (a.operation?.createdAtUnixMs ?? 0) - (b.operation?.createdAtUnixMs ?? 0))
          .find(value => value.images.length
          && (!value.operation || !activeDetachedOperations.has(value.operation.id))) ?? request.result ?? null);
        bound.onerror = () => reject(bound.error);
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
/** One transaction for all selected images and text. CAS also isolates two desktop windows. */
export async function writeImageDraft(next: ImageDraft, expectedRevision: number): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(DRAFT_STORE);
      let conflict = false;
      const request = store.get(next.owner);
      request.onsuccess = () => {
        if ((request.result?.revision ?? 0) !== expectedRevision) { conflict = true; tx.abort(); return; }
        store.put(next);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error(conflict ? 'IMAGE_DRAFT_CONFLICT: reopen this conversation' : 'IMAGE_DRAFT_WRITE_FAILED'));
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

/** Move a bound message out of the editor in one transaction. The detached
 * record remains recoverable until native admission has been acknowledged. */
export async function detachImageDraft(value: ImageDraft, signal?: AbortSignal): Promise<ImageDraft> {
  if (!value.operation) throw new Error('IMAGE_OPERATION_REQUIRED');
  const detached = { ...value, originOwner: value.originOwner ?? value.owner, owner: `submission:${value.operation.id}`, revision: 1 };
  const db = await open();
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      const abort = (): void => {
        try { tx.abort(); }
        catch (error) { if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error; }
      };
      signal?.addEventListener('abort', abort, { once: true });
      const store = tx.objectStore(DRAFT_STORE);
      const request = store.get(value.owner);
      request.onsuccess = () => {
        if ((request.result?.revision ?? 0) !== value.revision) { tx.abort(); return; }
        if (value.owner !== detached.owner) {
          store.put(detached);
          store.put({ owner: value.owner, revision: value.revision + 1, text: '', images: [] });
        }
      };
      tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(); };
      tx.onabort = () => { signal?.removeEventListener('abort', abort); reject(signal?.aborted ? signal.reason : new Error('IMAGE_DRAFT_CONFLICT')); };
      tx.onerror = () => reject(tx.error);
    });
    return value.owner === detached.owner ? value : detached;
  } finally { db.close(); }
}

export async function acknowledgeDetachedImageDraft(operationId: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      tx.objectStore(DRAFT_STORE).delete(`submission:${operationId}`);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

/** Return a cancelled preparation without touching a newer draft. A retry keeps
 * the original identity because an earlier attempt may already be committed. */
export async function restoreCancelledImageDraft(value: ImageDraft,
  options: { editorOwner?: string; keepOperation?: boolean } = {},
): Promise<ImageDraft | null> {
  if (!value.operation) return null;
  const editorOwner = options.editorOwner ?? value.originOwner ?? value.owner;
  const detachedOwner = `submission:${value.operation.id}`;
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(DRAFT_STORE);
      const editorRequest = store.get(editorOwner);
      const originalRequest = store.get(value.owner);
      const detachedRequest = store.get(detachedOwner);
      let restored: ImageDraft | null = null;
      detachedRequest.onsuccess = () => {
        const editor = editorRequest.result as ImageDraft | undefined;
        const detached = detachedRequest.result as ImageDraft | undefined;
        const source = detached?.operation?.id === value.operation!.id ? detached : originalRequest.result as ImageDraft | undefined;
        if (source?.operation?.id !== value.operation!.id) return;
        const expectedRevision = source.owner === value.owner ? value.revision : 1;
        if (source.revision !== expectedRevision) return;
        if (editor && editor.operation?.id !== value.operation!.id && (editor.images.length || editor.text)) return;
        restored = { ...source, owner: editorOwner, revision: (editor?.revision ?? 0) + 1,
          operation: options.keepOperation ? source.operation : undefined };
        store.put(restored);
        if (detachedOwner !== editorOwner) store.delete(detachedOwner);
        if (source.owner !== editorOwner && source.owner !== detachedOwner) store.delete(source.owner);
      };
      tx.oncomplete = () => resolve(restored);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
