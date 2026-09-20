import limits from './document-contract.json';
import type { LocaleKey } from '@/locales';

export const DOCUMENT_LIMITS = limits;
const extensions = [...limits.documentExtensions, ...limits.textExtensions];
export const DOCUMENT_ACCEPT = extensions.map(value => `.${value}`).join(',');
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
export function documentExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}
export function isDocumentName(name: string): boolean {
  return extensions.includes(documentExtension(name));
}
export function validateDocumentBatch(files: readonly Pick<File, 'name' | 'size'>[]): void {
  if (files.length > limits.maxFiles || files.reduce((sum, file) => sum + file.size, 0) > limits.maxBatchBytes) {
    throw new Error('DOCUMENT_BATCH_LIMIT');
  }
  for (const file of files) {
    if (!isDocumentName(file.name)) throw new Error('DOCUMENT_FORMAT');
    if (!file.size) throw new Error('DOCUMENT_EMPTY');
    if (file.size > limits.maxFileBytes) throw new Error('DOCUMENT_SIZE_LIMIT');
  }
}
export function validateDocumentText(text: string): string {
  if (text.length > limits.maxCharacters) throw new Error('DOCUMENT_TEXT_LIMIT');
  if (!text.trim()) throw new Error('DOCUMENT_EMPTY');
  return text;
}
export function documentErrorKey(error: unknown): LocaleKey {
  const message = String(error);
  if (message.includes('CHAT_REFERENCE_READ')) return 'ai.workspace.addMenu.readError';
  if (message.includes('CHAT_REFERENCE_EMPTY')) return 'ai.workspace.addMenu.emptyChat';
  if (message.includes('DOCUMENT_FORMAT')) return 'ai.workspace.documents.error.format';
  if (message.includes('DOCUMENT_EMPTY')) return 'ai.workspace.documents.error.empty';
  if (message.includes('DOCUMENT_OCR')) return 'ai.workspace.documents.error.ocr';
  if (message.includes('DOCUMENT_MESSAGE_LIMIT')) return 'ai.workspace.documents.error.messageLimit';
  if (message.includes('DOCUMENT_ENCODING')) return 'ai.workspace.documents.error.encoding';
  if (message.includes('DOCUMENT_PASSWORD') || message.includes('PasswordException')) return 'ai.workspace.documents.error.password';
  if (message.includes('DOCUMENT_TEXT_LIMIT') || message.includes('DOCUMENT_PAGE_LIMIT')) return 'ai.workspace.documents.error.textLimit';
  if (message.includes('DOCUMENT_SIZE_LIMIT') || message.includes('DOCUMENT_BATCH_LIMIT')) return 'ai.workspace.documents.error.size';
  if (message.includes('DOCUMENT_TIMEOUT')) return 'ai.workspace.documents.error.timeout';
  return 'ai.workspace.documents.error.invalid';
}

/** Decodes text strictly; never turn a renamed binary file into a successful attachment. */
export function decodeDocumentText(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('DOCUMENT_ENCODING'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(text)) throw new Error('DOCUMENT_ENCODING');
  return validateDocumentText(text);
}
