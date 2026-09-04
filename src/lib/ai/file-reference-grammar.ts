import type { FileCandidate } from '@/types/agent-file-reference';
export interface ActiveFileToken { start: number; end: number; query: string; quoted: boolean }
const unsafe = /[\u0000-\u001f\u007f-\u009f"\\:\u2028\u2029]/u;
/** Offsets are textarea UTF-16 offsets. Replace the entire token, including a suffix after the caret. */
export function activeFileToken(text: string, caret: number, selectionEnd = caret): ActiveFileToken | null {
  if (caret !== selectionEnd || caret < 0 || caret > text.length) return null;
  for (let start = 0; start < caret; start++) {
    if (text[start] !== '@' || (start > 0 && !/\s/u.test(text[start - 1]))) continue;
    const quoted = text[start + 1] === '"';
    const from = start + (quoted ? 2 : 1);
    let end = from;
    while (end < text.length && (quoted ? text[end] !== '"' && !/[\r\n]/.test(text[end]) : !/\s/u.test(text[end]))) end++;
    const closed = quoted && text[end] === '"';
    if (caret >= from && caret <= end) {
      const query = text.slice(from, caret);
      if (unsafe.test(query)) return null;
      return { start, end: end + (closed ? 1 : 0), query, quoted };
    }
    start = end;
  }
  return null;
}
export function formatFileMention(candidate: FileCandidate, preserveQuote = false): string | null {
  const { path } = candidate;
  if (!path || path.length > 2048 || unsafe.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) return null;
  const quoted = preserveQuote || /\s/u.test(path);
  const directory = candidate.kind === 'directory';
  return `@${quoted ? '"' : ''}${path}${directory ? '/' : quoted ? '"' : ''}`;
}
export function insertFileMention(text: string, token: ActiveFileToken, candidate: FileCandidate): { text: string; caret: number } | null {
  const mention = formatFileMention(candidate, token.quoted);
  if (mention === null) return null;
  const suffix = text.slice(token.end);
  const inserted = mention + (candidate.kind === 'file' && (!suffix || !/^\s/u.test(suffix)) ? ' ' : '');
  return { text: text.slice(0, token.start) + inserted + suffix, caret: token.start + inserted.length };
}
