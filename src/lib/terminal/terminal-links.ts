import type { IBuffer, IBufferCellPosition, ILink } from '@xterm/xterm';
import type { TerminalSession } from '@/stores/terminalStore';
import { getPlatform, type Platform } from '@/lib/platform';
import { isAbsoluteTerminalPath, openTerminalSftpPath } from '@/lib/terminal/terminal-current-directory';
import { invokeRevealPath } from '@/lib/ipc/tauri';
import { parsePosixPath, parentPosixPath } from '@/lib/path-utils';

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const UNC_PATH = /^(?:\\\\|\/\/)/;
const PATH_PATTERN = /(?:^|[\s("'\x60[=])((?:(?:[A-Za-z]:[\\/]|\/|\\\\)[^\s"'\x60<>()\[\]]+|[^\s"'\x60<>()\[\]:]+:\d+(?::\d+)?))/g;
const PATH_POSITION = /^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/;
const MAX_WRAPPED_SCAN_ROWS = 32;
const MAX_WRAPPED_SCAN_CHARS = 8192;

function normalizePosixRelativeJoin(cwd: string, relative: string): string {
  const stack: string[] = [];
  for (const segment of `${cwd}/${relative}`.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return `/${stack.join('/')}`;
}

interface DetectedLink {
  text: string;
  start: number;
  end: number;
}

export function shouldActivateTerminalLink(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>,
  platform: Platform = getPlatform(),
): boolean {
  return platform === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function terminalHttpUrl(text: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? text : null;
  } catch {
    return null;
  }
}

export function parseTerminalFileLink(text: string): { path: string; line?: number; column?: number } | null {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text) || /^[a-z][a-z\d+.-]*:\/\//i.test(text)) return null;
  const position = PATH_POSITION.exec(text);
  const path = position?.[1] ?? text;
  if (!path || (!ABSOLUTE_PATH.test(path) && (!position || !/[./\\]/.test(path)))) return null;
  const line = position ? Number(position[2]) : undefined;
  const column = position?.[3] ? Number(position[3]) : undefined;
  if ((line !== undefined && !Number.isSafeInteger(line)) || (column !== undefined && !Number.isSafeInteger(column))) return null;
  return { path, line, column };
}

export function findHttpLinksInLine(line: string): DetectedLink[] {
  return Array.from(line.matchAll(URL_PATTERN)).flatMap((match) => {
    const text = match[0].replace(/[),.;!?\]}]+$/g, '');
    return terminalHttpUrl(text) ? [{ text, start: match.index + 1, end: match.index + text.length }] : [];
  });
}

export function findFileLinksInLine(line: string): DetectedLink[] {
  const urls = findHttpLinksInLine(line);
  return Array.from(line.matchAll(PATH_PATTERN)).flatMap((match) => {
    const text = match[1].replace(/[,.;!?\]}:]+$/g, '');
    const start = match.index + match[0].length - match[1].length + 1;
    const end = start + text.length - 1;
    if (!parseTerminalFileLink(text) || urls.some((url) => url.start <= end && url.end >= start)) return [];
    return [{ text, start, end }];
  });
}

export function findLinksInTerminalBuffer(
  buffer: IBuffer,
  bufferLineNumber: number,
  columns: number,
  detect: (text: string) => DetectedLink[],
): Array<Pick<ILink, 'text' | 'range'>> {
  const targetIndex = bufferLineNumber - 1;
  if (!buffer.getLine(targetIndex)) return [];
  let firstLineIndex = targetIndex;
  const minLineIndex = Math.max(0, targetIndex - MAX_WRAPPED_SCAN_ROWS);
  while (firstLineIndex > minLineIndex && buffer.getLine(firstLineIndex)?.isWrapped) firstLineIndex--;

  let text = '';
  const starts: IBufferCellPosition[] = [];
  const ends: IBufferCellPosition[] = [];
  const reusableCell = buffer.getNullCell();
  const maxLineIndex = Math.min(buffer.length, targetIndex + MAX_WRAPPED_SCAN_ROWS + 1);
  for (let lineIndex = firstLineIndex; lineIndex < maxLineIndex; lineIndex++) {
    const line = buffer.getLine(lineIndex);
    if (!line) break;
    for (let column = 0; column < Math.min(columns, line.length); column++) {
      if (text.length >= MAX_WRAPPED_SCAN_CHARS) break;
      const cell = line.getCell(column, reusableCell);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      const start = { x: column + 1, y: lineIndex + 1 };
      const end = { x: column + cell.getWidth(), y: lineIndex + 1 };
      text += chars;
      for (let offset = 0; offset < chars.length; offset++) {
        starts.push(start);
        ends.push(end);
      }
    }
    if (text.length >= MAX_WRAPPED_SCAN_CHARS || !buffer.getLine(lineIndex + 1)?.isWrapped) break;
  }
  return detect(text).flatMap((link) => {
    const start = starts[link.start - 1];
    const end = ends[link.end - 1];
    if (!start || !end || bufferLineNumber < start.y || bufferLineNumber > end.y) return [];
    return [{ text: link.text, range: { start, end } }];
  });
}

export function findHttpLinksInBuffer(buffer: IBuffer, line: number, columns: number) {
  return findLinksInTerminalBuffer(buffer, line, columns, findHttpLinksInLine);
}

export async function openTerminalFileLink(session: TerminalSession, text: string): Promise<boolean> {
  const link = parseTerminalFileLink(text);
  if (!link) return false;
  let path = link.path;
  if (UNC_PATH.test(path)) return false;
  if (!isAbsoluteTerminalPath(session, path)) {
    const cwd = session.currentDirectory;
    if (!cwd || UNC_PATH.test(cwd) || !isAbsoluteTerminalPath(session, cwd) || ABSOLUTE_PATH.test(path)) return false;
    path = cwd.startsWith('/') ? normalizePosixRelativeJoin(cwd, path) : `${cwd}/${path}`;
  }
  if (session.host === 'local' && session.port === 0) {
    await invokeRevealPath(path);
    return true;
  }
  const normalized = normalizePosixRelativeJoin('', path);
  const { segments } = parsePosixPath(normalized);
  return openTerminalSftpPath(session, parentPosixPath(normalized), { entryName: segments[segments.length - 1]?.name });
}
