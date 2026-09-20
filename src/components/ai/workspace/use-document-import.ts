import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/useToast';
import { useI18n } from '@/hooks/useI18n';
import { DOCUMENT_LIMITS, documentErrorKey, validateDocumentBatch } from '@/lib/ai/document-import';
import { decodeDocumentMessage, encodeDocumentMessage, type DocumentAttachment } from '@/lib/ai/document-message';
import { extractDocument } from '@/lib/ai/document-extract';
import { invokeReadAiAttachment } from '@/lib/ipc/tauri';

export function useDocumentImport(scope: string, draft: string, update: (text: string) => void, disabled: boolean) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<readonly Pick<File, 'name' | 'size'>[]>([]);
  const operation = useRef<AbortController | null>(null);
  const latest = useRef({ scope, draft, update, disabled });
  latest.current = { scope, draft, update, disabled };
  const cancel = () => { operation.current?.abort(); operation.current = null; setBusy(false); setPending([]); };
  useEffect(() => {
    cancel();
    return () => { operation.current?.abort(); operation.current = null; };
  }, [scope]);

  async function run(load: (signal: AbortSignal) => Promise<readonly File[]>): Promise<boolean> {
    if (operation.current || latest.current.disabled) return false;
    const controller = new AbortController();
    operation.current = controller;
    // Claim the current workspace immediately, before asynchronous history restore
    // can replace the conversation while the selected files are still parsing.
    latest.current.update(latest.current.draft);
    setBusy(true);
    const isCurrent = () => !controller.signal.aborted && latest.current.scope === scope && !latest.current.disabled;
    try {
      const files = await load(controller.signal);
      if (!isCurrent() || !files.length) return false;
      validateDocumentBatch(files);
      const existing = decodeDocumentMessage(latest.current.draft);
      validateDocumentBatch([...existing.documents, ...files]);
      setPending(files);
      const documents: DocumentAttachment[] = [];
      for (const file of files) {
        documents.push({ id: crypto.randomUUID(), name: file.name, size: file.size, text: await extractDocument(file, controller.signal) });
        if (!isCurrent()) return false;
        // Enforce aggregate limits before parsing another file, without truncation.
        const current = decodeDocumentMessage(latest.current.draft);
        encodeDocumentMessage(current.text, [...current.documents, ...documents]);
      }
      const current = decodeDocumentMessage(latest.current.draft);
      latest.current.update(encodeDocumentMessage(current.text, [...current.documents, ...documents]));
      return true;
    } catch (error) {
      if (isCurrent()) toast.error(t(documentErrorKey(error)));
      return false;
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false); setPending([]); }
    }
  }

  return {
    busy, pending, cancel,
    addFrom: run,
    addFiles: (files: readonly File[]) => run(async () => files),
    addPaths: (paths: readonly string[]) => run(async signal => {
      if (paths.length > DOCUMENT_LIMITS.maxFiles) throw new Error('DOCUMENT_BATCH_LIMIT');
      const files: File[] = [];
      for (const path of paths) {
        signal.throwIfAborted();
        const result = await invokeReadAiAttachment(path);
        signal.throwIfAborted();
        const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
        files.push(new File([bytes], result.name));
        validateDocumentBatch(files);
      }
      return files;
    }),
  };
}
