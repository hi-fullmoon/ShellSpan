import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/useToast';
import { t } from '@/locales';
import { detachImageDraft, readImageDraft, restoreCancelledImageDraft, writeImageDraft, type ImageDraft } from '@/lib/ai/image-drafts';
import { imageErrorKey } from '@/lib/ai/image-error';
import { IMAGE_LIMITS } from '@/lib/ai/vision-contract';
import { invokeCancelAgentImageSubmission, invokePrepareAgentImages } from '@/lib/ipc/tauri';
import type { AgentImageUpload } from '@/types/agent-image';

async function bindImageOperation(
  bind: () => Promise<NonNullable<ImageDraft['operation']>>, signal: AbortSignal,
): Promise<NonNullable<ImageDraft['operation']>> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return bind(); }), cancelled]);
  } finally { signal.removeEventListener('abort', abort); }
}

export function useImageDraft(owner: string, text: string, restoreText: (text: string) => void,
  isManagedSubmission?: (operationId: string) => boolean) {
  const toast = useToast();
  const [draft, setDraft] = useState<ImageDraft | null>(null);
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([]);
  const [busy, setBusy] = useState(false);
  const [submittedOperationId, setSubmittedOperationId] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const reportError = useCallback((value: string | null) => {
    setError(value);
    if (value) toast.error(t(imageErrorKey(value)));
  }, [toast]);
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const textRef = useRef(text); textRef.current = text;
  const restoreRef = useRef(restoreText); restoreRef.current = restoreText;
  const managedRef = useRef(isManagedSubmission); managedRef.current = isManagedSubmission;
  const current = useRef<ImageDraft | null>(null);
  const epoch = useRef(0);
  const running = useRef(false);
  const cancelling = useRef<number | null>(null);
  const ready = useRef(false);
  const saving = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const detaching = useRef<AbortController | null>(null);
  useEffect(() => {
    const generation = ++epoch.current;
    setSubmittedOperationId(undefined);
    current.current = null; setDraft(null); setPendingFiles([]); setError(null); setBusy(false); running.current = false; ready.current = false;
    if (typeof indexedDB === 'undefined') { ready.current = true; return; }
    void readImageDraft(owner).then(async value => {
      // A restored queue already exposes this operation and its retry action.
      // Do not also put its old text/images over the user's newer editor draft.
      if (value?.operation && managedRef.current?.(value.operation.id)) value = await readImageDraft(owner, true);
      if (epoch.current !== generation) return;
      ready.current = true; current.current = value; setDraft(value);
      if (value?.images.length) restoreRef.current(value.text);
    }).catch(e => { if (epoch.current === generation) { ready.current = true; reportError(String(e)); } });
    return () => { epoch.current++; };
  }, [owner, reportError]);

  const isCurrent = (generation: number) => epoch.current === generation && ownerRef.current === owner;
  async function persist(value: ImageDraft, generation: number): Promise<void> {
    await writeImageDraft(value, value.revision - 1);
    if (!isCurrent(generation)) return;
    current.current = value; setDraft(value);
  }
  function base(): ImageDraft {
    return current.current ?? { owner, revision: 0, text: textRef.current, images: [] };
  }
  async function add(files: File[]): Promise<void> {
    if (running.current || !ready.current || current.current?.operation) return;
    const generation = epoch.current;
    running.current = true; setBusy(true); setError(null);
    try {
      if (saving.current?.generation === generation) await saving.current.promise;
      if (!isCurrent(generation)) return;
      const previous = base();
      if (!files.length) return;
      if (previous.images.length + files.length > IMAGE_LIMITS.maxImages) {
        toast.error(t('ai.workspace.images.error.count', { max: IMAGE_LIMITS.maxImages }));
        return;
      }
      if (files.some(file => file.size > IMAGE_LIMITS.maxSourceBytes)
        || files.reduce((sum, file) => sum + file.size, 0) > IMAGE_LIMITS.maxBatchBytes) throw new Error('IMAGE_SOURCE_LIMIT');
      setPendingFiles(files);
      const uploads: AgentImageUpload[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!isCurrent(generation)) return;
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        // No extension inference. Empty browser MIME is rejected by native admission too.
        uploads.push({ mediaType: file.type, name: file.name, data: btoa(binary) });
      }
      const normalized = await invokePrepareAgentImages(uploads);
      if (!isCurrent(generation)) return;
      await persist({ ...previous, revision: previous.revision + 1, text: textRef.current, images: [...previous.images, ...normalized] }, generation);
    } catch (e) { if (isCurrent(generation)) reportError(String(e)); }
    finally { if (isCurrent(generation)) { running.current = false; setBusy(false); setPendingFiles([]); } }
  }
  async function remove(index: number): Promise<void> {
    if (running.current || current.current?.operation) return;
    const generation = epoch.current;
    running.current = true; setBusy(true);
    try {
      if (saving.current?.generation === generation) await saving.current.promise;
      if (!isCurrent(generation)) return;
      const previous = base();
      await persist({ ...previous, revision: previous.revision + 1, text: textRef.current, images: previous.images.filter((_, i) => i !== index) }, generation);
    }
    catch (e) { if (isCurrent(generation)) reportError(String(e)); }
    finally { if (isCurrent(generation)) { running.current = false; setBusy(false); } }
  }
  // Text shares the image draft transaction. Send awaits this save, so disk failures never
  // become a successful submission. A late response always updates its original owner only.
  async function saveText(value: string): Promise<void> {
    if (running.current || !current.current?.images.length || current.current.operation) return;
    const generation = epoch.current;
    if (saving.current?.generation === generation) return saving.current.promise;
    const promise = (async () => { try {
      let previous = base();
      await persist({ ...previous, revision: previous.revision + 1, text: value }, generation);
      while (isCurrent(generation) && current.current && current.current.text !== textRef.current) {
        previous = current.current;
        await persist({ ...previous, revision: previous.revision + 1, text: textRef.current }, generation);
      }
    } catch (e) { if (isCurrent(generation)) reportError(String(e)); }
    finally { if (saving.current?.generation === generation) saving.current = null; } })();
    saving.current = { generation, promise };
    return promise;
  }
  useEffect(() => { void saveText(text); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(
    bind: () => Promise<NonNullable<ImageDraft['operation']>>,
    submit: (value: ImageDraft) => Promise<void>,
    accepted: (value: ImageDraft) => void,
  ): Promise<void> {
    if (running.current || !ready.current || !current.current?.images.length) return;
    const generation = epoch.current;
    running.current = true; setBusy(true); setError(null);
    try {
      if (saving.current?.generation === generation) await saving.current.promise;
      if (!isCurrent(generation)) return;
      const previous = base();
      const operation = previous.operation ?? { ...await bind(), createdAtUnixMs: Date.now() };
      if (!isCurrent(generation)) return;
      const value = { ...previous, revision: previous.revision + 1, text: previous.operation ? previous.text : textRef.current, operation };
      await persist(value, generation); // operation identity is durable BEFORE any create/send IPC
      if (!isCurrent(generation)) return;
      setSubmittedOperationId(operation.id);
      await submit(value);
      await writeImageDraft({ owner: value.owner, revision: value.revision + 1, text: '', images: [] }, value.revision);
      if (isCurrent(generation)) {
        current.current = { owner: value.owner, revision: value.revision + 1, text: '', images: [] }; setDraft(current.current);
        accepted(value);
      }
    } catch (e) { if (isCurrent(generation) && cancelling.current !== generation) reportError(String(e)); }
    finally { if (isCurrent(generation)) { running.current = false; setBusy(false); } }
  }
  async function detach(bind: () => Promise<NonNullable<ImageDraft['operation']>>): Promise<ImageDraft | null> {
    if (running.current || !ready.current || !current.current?.images.length) return null;
    const generation = epoch.current;
    const capturedText = textRef.current;
    const cancellation = new AbortController();
    detaching.current = cancellation;
    let bound: ImageDraft | undefined;
    let keepOperation = false;
    running.current = true; setBusy(true); setError(null);
    try {
      if (saving.current?.generation === generation) await saving.current.promise;
      if (!isCurrent(generation)) return null;
      const previous = base();
      keepOperation = Boolean(previous.operation);
      const operation = previous.operation ?? { ...await bindImageOperation(bind, cancellation.signal), createdAtUnixMs: Date.now() };
      cancellation.signal.throwIfAborted();
      const value = { ...previous, revision: previous.revision + 1, text: previous.operation ? previous.text : capturedText, operation };
      await persist(value, generation);
      bound = value;
      cancellation.signal.throwIfAborted();
      const editor = value.owner === owner ? value : await readImageDraft(owner, true);
      cancellation.signal.throwIfAborted();
      const detached = await detachImageDraft(value, cancellation.signal);
      cancellation.signal.throwIfAborted();
      if (isCurrent(generation)) {
        current.current = { owner, revision: value.owner === owner ? value.revision + 1 : editor?.revision ?? 0, text: '', images: [] };
        setDraft(current.current);
        setSubmittedOperationId(operation.id);
      }
      return detached;
    } catch (error) {
      if (cancellation.signal.aborted) {
        if (bound) {
          try {
            const restored = await restoreCancelledImageDraft(bound, { editorOwner: owner, keepOperation });
            if (restored && isCurrent(generation)) { current.current = restored; setDraft(restored); }
          } catch (restoreError) { if (isCurrent(generation)) reportError(String(restoreError)); }
        }
      } else if (isCurrent(generation)) reportError(String(error));
      return null;
    } finally {
      if (detaching.current === cancellation) detaching.current = null;
      if (isCurrent(generation)) { running.current = false; setBusy(false); }
    }
  }
  async function cancel(preparationOnly = false): Promise<void> {
    if (detaching.current) { detaching.current.abort(); return; }
    if (preparationOnly) return;
    const generation = epoch.current;
    const value = current.current;
    if (!value?.operation) { ++epoch.current; running.current = false; setBusy(false); setPendingFiles([]); return; }
    if (cancelling.current === generation) return;
    cancelling.current = generation;
    try {
      const committed = await invokeCancelAgentImageSubmission({ sessionId: value.operation.sessionId, clientOperationId: value.operation.id });
      if (!isCurrent(generation)) return;
      // If commit won, keep the same operation for a confirming retry. Never label it cancelled.
      if (committed) { reportError('IMAGE_ALREADY_COMMITTED: retry to confirm'); return; }
      await persist({ ...value, revision: value.revision + 1, operation: undefined }, generation);
      if (!isCurrent(generation)) return;
      ++epoch.current;
      running.current = false; setBusy(false); reportError('IMAGE_CANCELLED');
    } catch (e) { if (isCurrent(generation)) reportError(String(e)); }
    finally { if (cancelling.current === generation) cancelling.current = null; }
  }
  return { owner, draft, pendingFiles, busy, submittedOperationId, error, add, remove, send, detach, cancel, locked: Boolean(draft?.operation), reportError };
}
