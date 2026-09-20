import { getDocument, PDFWorker } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { DOCUMENT_LIMITS, validateDocumentText } from './document-import';

export async function extractPdf(bytes: ArrayBuffer, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const port = new Worker(workerUrl, { type: 'module' });
  const worker = PDFWorker.create({ port });
  const resources = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href);
  const task = getDocument({
    data: new Uint8Array(bytes), worker, useSystemFonts: true, useWasm: false, stopAtErrors: true,
    cMapUrl: new URL('cmaps/', resources).href,
    standardFontDataUrl: new URL('standard_fonts/', resources).href,
  });
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  const abort = () => interrupt(new DOMException('Aborted', 'AbortError'));
  const timer = setTimeout(() => interrupt(new Error('DOCUMENT_TIMEOUT')), DOCUMENT_LIMITS.timeoutMs);
  port.onerror = () => interrupt(new Error('DOCUMENT_INVALID'));
  signal.addEventListener('abort', abort, { once: true });
  const extract = async () => {
    const pdf = await task.promise;
    if (pdf.numPages > DOCUMENT_LIMITS.maxPdfPages) throw new Error('DOCUMENT_PAGE_LIMIT');
    const pages: string[] = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      if (!text.trim()) throw new Error('DOCUMENT_OCR');
      length += text.length;
      if (length > DOCUMENT_LIMITS.maxCharacters) throw new Error('DOCUMENT_TEXT_LIMIT');
      pages.push(text);
      page.cleanup();
    }
    return validateDocumentText(pages.join('\n\n'));
  };
  try {
    return await Promise.race([extract(), interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    // Terminate the actual worker even if a parser is stuck and cannot answer a
    // graceful destroy request. The caller's cancellation/deadline settles first.
    void task.destroy().catch(() => {});
    worker.destroy();
    port.terminate();
  }
}
