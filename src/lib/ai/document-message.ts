import { DOCUMENT_LIMITS, isDocumentName, validateDocumentBatch, validateDocumentText } from './document-import';

export interface DocumentAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly text: string;
}
export interface DocumentMessage {
  readonly text: string;
  readonly documents: readonly DocumentAttachment[];
}
const PREFIX = '{"shellspanDocumentMessage":1,';

/** Versioned, self-contained message content keeps attachments in the same durable
 * transaction as text, including queued messages, retries and image submissions.
 * Plain messages remain byte-for-byte unchanged. Providers receive the extracted
 * documents as structured user content, not instructions or local filesystem paths.
 */
export function encodeDocumentMessage(text: string, documents: readonly DocumentAttachment[], enforceTextLimit = true): string {
  if (!documents.length) return text;
  validateDocumentBatch(documents);
  documents.forEach(document => validateDocumentText(document.text));
  if (enforceTextLimit && text.length + documents.reduce((sum, document) => sum + document.text.length, 0) > DOCUMENT_LIMITS.maxDraftCharacters) {
    throw new Error('DOCUMENT_TEXT_LIMIT');
  }
  const encoded = JSON.stringify({ shellspanDocumentMessage: 1, text, documents });
  if (enforceTextLimit && new TextEncoder().encode(encoded).byteLength > DOCUMENT_LIMITS.maxMessageBytes) {
    throw new Error('DOCUMENT_MESSAGE_LIMIT');
  }
  return encoded;
}

export function decodeDocumentMessage(content: string): DocumentMessage {
  const plain = { text: content, documents: [] };
  if (!content.startsWith(PREFIX) || content.length > DOCUMENT_LIMITS.maxDraftCharacters * 8) return plain;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || !('text' in parsed) || typeof parsed.text !== 'string'
      || !('documents' in parsed) || !Array.isArray(parsed.documents) || !parsed.documents.length
      || parsed.documents.length > DOCUMENT_LIMITS.maxFiles) return plain;
    const documents: DocumentAttachment[] = [];
    const values: readonly unknown[] = parsed.documents;
    for (const value of values) {
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !value.id || value.id.length > 100
        || !('name' in value) || typeof value.name !== 'string' || value.name.length > 255 || !isDocumentName(value.name)
        || !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0
        || !('text' in value) || typeof value.text !== 'string') return plain;
      documents.push({ id: value.id, name: value.name, size: value.size, text: value.text });
    }
    if (new Set(documents.map(document => document.id)).size !== documents.length) return plain;
    encodeDocumentMessage(parsed.text, documents, false);
    return { text: parsed.text, documents };
  } catch { return plain; }
}

export function documentMessageSummary(content: string): string {
  const message = decodeDocumentMessage(content);
  return message.text.trim() || message.documents.map(document => document.name).join(', ');
}
