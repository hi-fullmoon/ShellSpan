import { DOCUMENT_LIMITS, decodeDocumentText, documentExtension, validateDocumentBatch } from './document-import';

export async function extractDocument(file: File, signal: AbortSignal): Promise<string> {
  validateDocumentBatch([file]);
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const extension = documentExtension(file.name);
  if (DOCUMENT_LIMITS.textExtensions.includes(extension)) return decodeDocumentText(new Uint8Array(bytes));
  if (extension === 'pdf') {
    const { extractPdf } = await import('./document-pdf');
    signal.throwIfAborted();
    return extractPdf(bytes, signal);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-office.worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: unknown, text?: string) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(text!);
    };
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('DOCUMENT_TIMEOUT')), DOCUMENT_LIMITS.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(new Error('DOCUMENT_INVALID'));
    worker.onmessage = (event: MessageEvent<{ text?: string; error?: string }>) => {
      finish(event.data.error ? new Error(event.data.error) : undefined, event.data.text);
    };
    worker.postMessage({ bytes, extension }, [bytes]);
  });
}
