import { describe, expect, it } from 'vitest';
import { decodeDocumentText, DOCUMENT_ACCEPT, DOCUMENT_LIMITS, documentErrorKey, isDocumentName, validateDocumentBatch } from '../document-import';
import { decodeDocumentMessage, encodeDocumentMessage } from '../document-message';
import { createAiComposerState, reduceAiComposer } from '../composer-machine';

describe('document import policy', () => {
  it('accepts supported extensions regardless of case or missing browser MIME', () => {
    for (const name of ['Report.PDF', '报告.docx', 'table.xlsx', 'README.md', 'app.tsx', 'logs.LOG']) {
      expect(isDocumentName(name)).toBe(true);
      expect(() => validateDocumentBatch([{ name, size: 1 }])).not.toThrow();
    }
    for (const name of ['archive.zip', 'old.doc', 'old.xls', 'movie.mp4', 'program.exe']) {
      expect(isDocumentName(name)).toBe(false);
      expect(() => validateDocumentBatch([{ name, size: 1 }])).toThrow('DOCUMENT_FORMAT');
    }
    expect(DOCUMENT_ACCEPT).toContain('.pdf,.docx,.xlsx');
  });
  it('rejects empty, oversized and excessive batches before reading', () => {
    expect(() => validateDocumentBatch([{ name: 'empty.txt', size: 0 }])).toThrow('DOCUMENT_EMPTY');
    expect(() => validateDocumentBatch([{ name: 'large.pdf', size: DOCUMENT_LIMITS.maxFileBytes + 1 }])).toThrow('DOCUMENT_SIZE_LIMIT');
    expect(() => validateDocumentBatch(Array.from({ length: 11 }, () => ({ name: 'data.txt', size: 1 })))).toThrow('DOCUMENT_BATCH_LIMIT');
    expect(() => validateDocumentBatch(Array.from({ length: 3 }, () => ({ name: 'data.txt', size: DOCUMENT_LIMITS.maxFileBytes })))).toThrow('DOCUMENT_BATCH_LIMIT');
  });
  it('decodes UTF-8 and BOM-marked UTF-16 without corrupting Chinese text', () => {
    expect(decodeDocumentText(new TextEncoder().encode('标题\n正文'))).toBe('标题\n正文');
    expect(decodeDocumentText(new Uint8Array([0xff, 0xfe, 0x07, 0x68, 0x98, 0x98]))).toBe('标题');
    expect(() => decodeDocumentText(new Uint8Array([0xff, 0x00, 0x01]))).toThrow('DOCUMENT_ENCODING');
    expect(() => decodeDocumentText(new Uint8Array([0x00, 0x61]))).toThrow('DOCUMENT_ENCODING');
  });
  it('round-trips attachments independently of user text, including Markdown and JSON', () => {
    const text = '```ts\nconst value = 1;\n```';
    const documents = [{ id: 'one', name: 'notes.md', size: 30, text }];
    const result = encodeDocumentMessage('Explain this', documents);
    expect(decodeDocumentMessage(result)).toEqual({ text: 'Explain this', documents });
    expect(encodeDocumentMessage('normal text', [])).toBe('normal text');
    expect(decodeDocumentMessage('{"shellspanDocumentMessage":1,"text":"hello","documents":[{}]}').documents).toEqual([]);
    expect(() => encodeDocumentMessage('x'.repeat(DOCUMENT_LIMITS.maxDraftCharacters), documents)).toThrow('DOCUMENT_TEXT_LIMIT');
  });
  it('maps empty and encrypted PDFs to actionable messages', () => {
    expect(documentErrorKey(new Error('DOCUMENT_EMPTY'))).toBe('ai.workspace.documents.error.empty');
    expect(documentErrorKey(new Error('PasswordException: password required'))).toBe('ai.workspace.documents.error.password');
  });
  it('checks UTF-8 serialized bytes against the native message limit', () => {
    const documents = [{ id: 'notes', name: 'notes.txt', size: 150000, text: '中'.repeat(50000) }];
    expect(() => encodeDocumentMessage('Summarize', documents)).toThrow('DOCUMENT_MESSAGE_LIMIT');
    expect(decodeDocumentMessage(encodeDocumentMessage('Summarize', documents, false)).documents).toEqual(documents);
  });
  it('keeps documents with the detached message and restores them after submission failure', () => {
    const documents = [{ id: 'readme', name: 'README.md', size: 10, text: 'SSH client' }];
    const content = encodeDocumentMessage('Summarize', documents);
    const sent = reduceAiComposer(createAiComposerState({ draft: content }), {
      type: 'submit.requested', gesture: 'primary', accelerated: false, clientOperationId: 'upload',
      now: 1, hasProvider: true, canCreateSession: true,
    });
    expect(sent.state.draft).toBe('');
    expect(sent.state.detached?.content).toBe(content);
    const failed = reduceAiComposer(sent.state, { type: 'submit.failed', clientOperationId: 'upload',
      error: { kind: 'offline', message: 'Disconnected', retryable: true } });
    expect(decodeDocumentMessage(failed.state.draft)).toEqual({ text: 'Summarize', documents });
  });
});
