import hljs from 'highlight.js/lib/common';

const MAX_HIGHLIGHT_LINE_LENGTH = 10_000;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 4_000;
const HIGHLIGHT_FRAME_BUDGET_MS = 6;
const HIGHLIGHT_MAX_LINES_PER_FRAME = 60;

const EXTENSION_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  tsx: 'typescript',
  jsx: 'javascript',
  vue: 'xml',
  svg: 'xml',
  mjs: 'javascript',
  cjs: 'javascript',
};

const languageResolutionCache = new Map<string, string | null>();
const lineHtmlCache = new Map<string, string>();

interface HighlightJob {
  readonly language: string;
  readonly lines: readonly string[];
  cursor: number;
  cancelled: boolean;
  readonly onProgress: () => void;
}

const pendingJobs: HighlightJob[] = [];
let scheduledPumpHandle: number | null = null;
let scheduledViaRaf = false;

export function resolveDiffHighlightLanguage(path: string): string | null {
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === path.length - 1) return null;
  const extension = path.slice(dotIndex + 1).toLowerCase();
  const cached = languageResolutionCache.get(extension);
  if (cached !== undefined) return cached;
  const candidate = EXTENSION_LANGUAGE_ALIASES[extension] ?? extension;
  const resolved = hljs.getLanguage(candidate) ? candidate : null;
  languageResolutionCache.set(extension, resolved);
  return resolved;
}

function cacheKey(language: string, text: string): string {
  return `${language}\0${text}`;
}

export function getCachedDiffLineHtml(language: string, text: string): string | undefined {
  if (text.length === 0 || text.length > MAX_HIGHLIGHT_LINE_LENGTH) return undefined;
  const key = cacheKey(language, text);
  const hit = lineHtmlCache.get(key);
  if (hit === undefined) return undefined;
  lineHtmlCache.delete(key);
  lineHtmlCache.set(key, hit);
  return hit;
}

function putCachedDiffLineHtml(language: string, text: string, html: string): void {
  const key = cacheKey(language, text);
  if (lineHtmlCache.has(key)) {
    lineHtmlCache.delete(key);
  } else if (lineHtmlCache.size >= MAX_HIGHLIGHT_CACHE_ENTRIES) {
    const oldestKey = lineHtmlCache.keys().next().value;
    if (oldestKey !== undefined) {
      lineHtmlCache.delete(oldestKey);
    }
  }
  lineHtmlCache.set(key, html);
}

export function highlightDiffLineSync(language: string, text: string): string | null {
  if (text.length === 0 || text.length > MAX_HIGHLIGHT_LINE_LENGTH) return null;
  const cached = getCachedDiffLineHtml(language, text);
  if (cached !== undefined) return cached;
  const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  putCachedDiffLineHtml(language, text, html);
  return html;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function scheduleNextPump(): void {
  if (scheduledPumpHandle !== null || pendingJobs.length === 0) return;
  if (typeof requestAnimationFrame === 'function') {
    scheduledViaRaf = true;
    scheduledPumpHandle = requestAnimationFrame(() => {
      scheduledPumpHandle = null;
      pumpHighlightJobs();
    });
  } else {
    scheduledViaRaf = false;
    scheduledPumpHandle = globalThis.setTimeout(() => {
      scheduledPumpHandle = null;
      pumpHighlightJobs();
    }, 0) as unknown as number;
  }
}

function pumpHighlightJobs(): void {
  const start = nowMs();
  let processedLines = 0;
  const progressedJobs = new Set<HighlightJob>();

  while (pendingJobs.length > 0) {
    const job = pendingJobs[0];
    if (job.cancelled || job.cursor >= job.lines.length) {
      pendingJobs.shift();
      continue;
    }

    let progressed = false;
    while (job.cursor < job.lines.length) {
      const line = job.lines[job.cursor];
      job.cursor += 1;
      if (getCachedDiffLineHtml(job.language, line) === undefined) {
        highlightDiffLineSync(job.language, line);
        processedLines += 1;
        progressed = true;
      }
      if (
        processedLines >= HIGHLIGHT_MAX_LINES_PER_FRAME
        || (processedLines > 0 && nowMs() - start >= HIGHLIGHT_FRAME_BUDGET_MS)
      ) {
        break;
      }
    }

    if (progressed) {
      progressedJobs.add(job);
    }
    if (job.cursor >= job.lines.length) {
      pendingJobs.shift();
    }
    if (
      processedLines >= HIGHLIGHT_MAX_LINES_PER_FRAME
      || (processedLines > 0 && nowMs() - start >= HIGHLIGHT_FRAME_BUDGET_MS)
    ) {
      break;
    }
  }

  for (const job of progressedJobs) {
    if (!job.cancelled) {
      job.onProgress();
    }
  }

  if (pendingJobs.length > 0) {
    scheduleNextPump();
  }
}

/**
 * Schedules chunked syntax highlighting for uncached diff lines using a
 * per-frame time budget so large diffs render immediately as plain text
 * and progressively colorize without blocking input or scrolling.
 */
export function scheduleDiffLinesHighlight(
  language: string,
  lines: readonly string[],
  onProgress: () => void,
): () => void {
  const uniqueMissing: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.length === 0 || line.length > MAX_HIGHLIGHT_LINE_LENGTH) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    if (getCachedDiffLineHtml(language, line) === undefined) {
      uniqueMissing.push(line);
    }
  }
  if (uniqueMissing.length === 0) {
    return () => {};
  }
  const job: HighlightJob = {
    language,
    lines: uniqueMissing,
    cursor: 0,
    cancelled: false,
    onProgress,
  };
  pendingJobs.push(job);
  scheduleNextPump();
  return () => {
    job.cancelled = true;
  };
}

export function clearDiffHighlightCacheForTests(): void {
  lineHtmlCache.clear();
  languageResolutionCache.clear();
  for (const job of pendingJobs) {
    job.cancelled = true;
  }
  pendingJobs.length = 0;
  if (scheduledPumpHandle !== null) {
    if (scheduledViaRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(scheduledPumpHandle);
    } else {
      clearTimeout(scheduledPumpHandle);
    }
    scheduledPumpHandle = null;
  }
}
