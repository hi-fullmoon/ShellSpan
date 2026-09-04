import { useEffect, useRef, useState } from 'react';
import { readImageDraft, writeImageDraft, type ImageDraft } from '@/lib/ai/image-drafts';
import { IMAGE_LIMITS } from '@/lib/vision-contract';
import { invokeCancelAgentImageSubmission, invokePrepareAgentImages } from '@/lib/tauri';
import type { AgentImageUpload } from '@/types/agent-image';

export function useImageDraft(owner: string, text: string, restoreText: (text: string) => void) {
  const [draft, setDraft] = useState<ImageDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const textRef = useRef(text); textRef.current = text;
  const restoreRef = useRef(restoreText); restoreRef.current = restoreText;
  const current = useRef<ImageDraft | null>(null);
  const epoch = useRef(0);
  const running = useRef(false);
  const ready = useRef(false);
  const saving = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  useEffect(() => {
    const generation = ++epoch.current;
    current.current = null; setDraft(null); setError(null); setBusy(false); running.current = false; ready.current = false;
    if (typeof indexedDB === 'undefined') { ready.current = true; return; }
    void readImageDraft(owner).then(value => {
      if (epoch.current !== generation) return;
      ready.current = true; current.current = value; setDraft(value);
      if (value?.images.length) restoreRef.current(value.text);
    }).catch(e => { if (epoch.current === generation) { ready.current = true; setError(String(e)); } });
    return () => { epoch.current++; };
  }, [owner]);

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
      if (previous.images.length + files.length > IMAGE_LIMITS.maxImages
        || files.some(file => file.size > IMAGE_LIMITS.maxSourceBytes)
        || files.reduce((sum, file) => sum + file.size, 0) > IMAGE_LIMITS.maxBatchBytes) throw new Error('IMAGE_SOURCE_LIMIT');
      const uploads: AgentImageUpload[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        // No extension inference. Empty browser MIME is rejected by native admission too.
        uploads.push({ mediaType: file.type, name: file.name, data: btoa(binary) });
      }
      const normalized = await invokePrepareAgentImages(uploads);
      if (!isCurrent(generation)) return;
      await persist({ ...previous, revision: previous.revision + 1, text: textRef.current, images: [...previous.images, ...normalized] }, generation);
    } catch (e) { if (isCurrent(generation)) setError(String(e)); }
    finally { if (isCurrent(generation)) { running.current = false; setBusy(false); } }
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
    catch (e) { if (isCurrent(generation)) setError(String(e)); }
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
    } catch (e) { if (isCurrent(generation)) setError(String(e)); }
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
      const operation = previous.operation ?? await bind();
      if (!isCurrent(generation)) return;
      const value = { ...previous, revision: previous.revision + 1, text: previous.operation ? previous.text : textRef.current, operation };
      await persist(value, generation); // operation identity is durable BEFORE any create/send IPC
      if (!isCurrent(generation)) return;
      await submit(value);
      await writeImageDraft({ owner: value.owner, revision: value.revision + 1, text: '', images: [] }, value.revision);
      if (isCurrent(generation)) {
        current.current = { owner: value.owner, revision: value.revision + 1, text: '', images: [] }; setDraft(current.current);
        accepted(value);
      }
    } catch (e) { if (isCurrent(generation)) setError(String(e)); }
    finally { if (isCurrent(generation)) { running.current = false; setBusy(false); } }
  }
  async function cancel(): Promise<void> {
    const generation = epoch.current;
    const value = current.current;
    if (!value?.operation) { ++epoch.current; running.current = false; setBusy(false); return; }
    try {
      const committed = await invokeCancelAgentImageSubmission({ sessionId: value.operation.sessionId, clientOperationId: value.operation.id });
      if (!isCurrent(generation)) return;
      // If commit won, keep the same operation for a confirming retry. Never label it cancelled.
      if (committed) { setError('IMAGE_ALREADY_COMMITTED: retry to confirm'); return; }
      await persist({ ...value, revision: value.revision + 1, operation: undefined }, generation);
      if (!isCurrent(generation)) return;
      ++epoch.current;
      running.current = false; setBusy(false); setError('IMAGE_CANCELLED');
    } catch (e) { if (isCurrent(generation)) setError(String(e)); }
  }
  return { draft, busy, error, add, remove, send, cancel, locked: Boolean(draft?.operation), reportError: setError };
}
