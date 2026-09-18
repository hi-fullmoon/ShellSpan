import type { AgentImageUpload } from '@/types/agent-image';
import type { AiCreateSessionInput, AiSubmissionMode } from './session-adapter';

export interface ImageDraft {
  readonly owner: string;
  readonly revision: number;
  readonly text: string;
  readonly images: readonly AgentImageUpload[];
  readonly operation?: {
    readonly id: string;
    readonly sessionId: string;
    readonly mode: AiSubmissionMode;
    readonly create?: Extract<AiCreateSessionInput, { kind: 'agent' }>;
  };
}

const DATABASE_NAME = 'shellspan-image-drafts-v1';
const DRAFT_STORE = 'drafts';
const SESSION_INDEX = 'session';

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
export async function readImageDraft(owner: string): Promise<ImageDraft | null> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(DRAFT_STORE).objectStore(DRAFT_STORE);
      const request = store.get(owner);
      request.onsuccess = () => {
        if (request.result?.images.length || !owner.startsWith('agent:')) { resolve(request.result ?? null); return; }
        const bound = store.index(SESSION_INDEX).get(owner.slice('agent:'.length));
        bound.onsuccess = () => resolve(bound.result ?? request.result ?? null);
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
