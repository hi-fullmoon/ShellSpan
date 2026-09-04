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

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shellspan-image-drafts-v1', 2);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains('drafts')
        ? request.transaction!.objectStore('drafts') : request.result.createObjectStore('drafts', { keyPath: 'owner' });
      if (!store.indexNames.contains('session')) store.createIndex('session', 'operation.sessionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readImageDraft(owner: string): Promise<ImageDraft | null> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction('drafts').objectStore('drafts');
      const request = store.get(owner);
      request.onsuccess = () => {
        if (request.result?.images.length || !owner.startsWith('agent:')) { resolve(request.result ?? null); return; }
        const bound = store.index('session').get(owner.slice('agent:'.length));
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
      const tx = db.transaction('drafts', 'readwrite');
      const store = tx.objectStore('drafts');
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
