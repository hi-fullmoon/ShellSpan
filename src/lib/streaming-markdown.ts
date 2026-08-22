export const STREAMING_MARKDOWN_CHUNK_TARGET = 2048;

type MarkdownBlockKind = 'list' | 'quote' | 'indentedCode' | 'other';

interface MarkdownLine {
  complete: boolean;
  end: number;
  text: string;
}

function markdownLines(content: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline + 1;
    const textEnd = newline === -1 ? end : newline;
    lines.push({
      complete: newline !== -1,
      end,
      text: content.slice(start, textEnd).replace(/\r$/, ''),
    });
    start = end;
  }
  return lines;
}

function blockKind(line: string): MarkdownBlockKind {
  if (/^\s*>/.test(line)) return 'quote';
  if (/^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(line)) return 'list';
  if (/^(?:\t| {4})/.test(line)) return 'indentedCode';
  return 'other';
}

function fenceRun(line: string): string | undefined {
  const run = /^ {0,3}(`+|~+)/.exec(line)?.[1];
  return run && run.length >= 3 ? run : undefined;
}

function continuesAcrossBlankLine(
  currentKind: MarkdownBlockKind | null,
  nextLine: string,
): boolean {
  const nextKind = blockKind(nextLine);
  if (currentKind === 'list') {
    return nextKind === 'list' || /^(?:\t| {2,})\S/.test(nextLine);
  }
  if (currentKind === 'quote') return nextKind === 'quote';
  if (currentKind === 'indentedCode') return nextKind === 'indentedCode';
  return false;
}

/**
 * Splits a growing Markdown document at completed top-level block boundaries.
 * Existing chunks stay byte-for-byte stable as new tail content arrives, so
 * memoized renderers only need to parse the final growing chunk.
 */
export function splitStreamingMarkdown(
  content: string,
  targetSize = STREAMING_MARKDOWN_CHUNK_TARGET,
): string[] {
  if (!content) return [];
  if (!Number.isFinite(targetSize) || targetSize <= 0) return [content];
  // Reference definitions can resolve links in earlier blocks and therefore
  // must stay in the same Markdown syntax tree as their consumers.
  if (/^ {0,3}\[[^\]\n]+\]:\s*\S+/m.test(content)) return [content];

  const lines = markdownLines(content);
  const chunks: string[] = [];
  let chunkStart = 0;
  let currentKind: MarkdownBlockKind | null = null;
  let openFence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const run = fenceRun(line.text);

    if (openFence) {
      if (
        run
        && run[0] === openFence.marker
        && run.length >= openFence.length
        && line.text.slice(line.text.indexOf(run) + run.length).trim() === ''
      ) {
        openFence = null;
      }
      continue;
    }

    if (run) {
      currentKind ??= 'other';
      openFence = { marker: run[0], length: run.length };
      continue;
    }

    if (line.text.trim() !== '') {
      currentKind ??= blockKind(line.text);
      continue;
    }

    let lastBlankIndex = index;
    while (
      lastBlankIndex + 1 < lines.length
      && lines[lastBlankIndex + 1].text.trim() === ''
    ) {
      lastBlankIndex += 1;
    }
    const nextLine = lines[lastBlankIndex + 1];
    // Wait for the look-ahead line to finish before classifying it. A partial
    // "-" or "1." can still become a continuation of the preceding list.
    if (!nextLine?.complete) break;

    const continuesBlock = continuesAcrossBlankLine(currentKind, nextLine.text);
    const boundary = lines[lastBlankIndex].end;
    if (!continuesBlock) {
      if (boundary - chunkStart >= targetSize) {
        chunks.push(content.slice(chunkStart, boundary));
        chunkStart = boundary;
      }
      currentKind = null;
    }
    index = lastBlankIndex;
  }

  if (chunkStart < content.length) chunks.push(content.slice(chunkStart));
  return chunks.length > 0 ? chunks : [content];
}
