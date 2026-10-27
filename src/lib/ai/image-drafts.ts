import type { AgentImageUpload } from '@/types/agent-image';
import type { AiCreateSessionInput, AiSubmissionMode } from './session-adapter';
import { invokeReadImageDrafts, invokeCommitImageDrafts } from '@/lib/ipc/tauri';

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

const activeDetachedOperations = new Map<string, Set<symbol>>();

/** Active submissions stay hidden from draft recovery until their owner releases them. */
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

export async function readImageDraft(owner: string, exact = false): Promise<ImageDraft | null> {
  const records = await invokeReadImageDrafts({ keys: [owner], recoveryOwner: exact ? undefined : owner });
  const own = records.find(record => record.owner === owner) ?? null;
  if (exact || own?.images.length || own?.text) return own;
  return records.filter(record => record.owner !== owner)
    .sort((left, right) => (left.operation?.createdAtUnixMs ?? 0) - (right.operation?.createdAtUnixMs ?? 0))
    .find(record => record.images.length && (!record.operation || !activeDetachedOperations.has(record.operation.id))) ?? own;
}

/** The native SQLite transaction compares revisions before changing any records. */
export async function writeImageDraft(next: ImageDraft, expectedRevision: number): Promise<void> {
  await invokeCommitImageDrafts({ checks: [{ owner: next.owner, revision: expectedRevision }], writes: [next], deletes: [] });
}

export async function detachImageDraft(value: ImageDraft, signal?: AbortSignal): Promise<ImageDraft> {
  if (!value.operation) throw new Error('IMAGE_OPERATION_REQUIRED');
  signal?.throwIfAborted();
  const detached = { ...value, originOwner: value.originOwner ?? value.owner, owner: `submission:${value.operation.id}`, revision: 1 };
  if (value.owner === detached.owner) return value;
  await invokeCommitImageDrafts({
    checks: [{ owner: value.owner, revision: value.revision }, { owner: detached.owner, revision: 0 }],
    writes: [detached, { owner: value.owner, revision: value.revision + 1, text: '', images: [] }], deletes: [],
  });
  // The caller checks cancellation after this durable boundary and restores the
  // source with restoreCancelledImageDraft; an IPC commit is never advertised as aborted.
  return detached;
}

export async function acknowledgeDetachedImageDraft(operationId: string): Promise<void> {
  const owner = `submission:${operationId}`;
  const record = (await invokeReadImageDrafts({ keys: [owner] }))[0];
  if (!record) return;
  try {
    await invokeCommitImageDrafts({ checks: [{ owner, revision: record.revision }], writes: [], deletes: [owner] });
  } catch (error) {
    if (String(error).includes('IMAGE_DRAFT_CONFLICT') && !(await invokeReadImageDrafts({ keys: [owner] })).length) return;
    throw error;
  }
}

/** Restore only the same preparation, preserving any newer editor content. */
export async function restoreCancelledImageDraft(value: ImageDraft,
  options: { editorOwner?: string; keepOperation?: boolean } = {},
): Promise<ImageDraft | null> {
  if (!value.operation) return null;
  const editorOwner = options.editorOwner ?? value.originOwner ?? value.owner;
  const detachedOwner = `submission:${value.operation.id}`;
  const keys = [...new Set([editorOwner, value.owner, detachedOwner])];
  const records = await invokeReadImageDrafts({ keys });
  const byOwner = new Map(records.map(record => [record.owner, record]));
  const editor = byOwner.get(editorOwner);
  const detached = byOwner.get(detachedOwner);
  const source = detached?.operation?.id === value.operation.id ? detached : byOwner.get(value.owner);
  if (source?.operation?.id !== value.operation.id) return null;
  const expectedRevision = source.owner === value.owner ? value.revision : 1;
  if (source.revision !== expectedRevision) return null;
  if (editor && editor.operation?.id !== value.operation.id && (editor.images.length || editor.text)) return null;
  const restored = { ...source, owner: editorOwner, revision: (editor?.revision ?? 0) + 1,
    operation: options.keepOperation ? source.operation : undefined };
  try {
    await invokeCommitImageDrafts({
      checks: keys.map(owner => ({ owner, revision: byOwner.get(owner)?.revision ?? 0 })),
      writes: [restored], deletes: [...new Set([detachedOwner, source.owner])].filter(owner => owner !== editorOwner),
    });
    return restored;
  } catch (error) {
    if (String(error).includes('IMAGE_DRAFT_CONFLICT')) return null;
    throw error;
  }
}
