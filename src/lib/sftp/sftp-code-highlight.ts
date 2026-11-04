import { getFileExtension } from './sftp-preview';

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonl: 'json', ndjson: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini',
  graphql: 'graphql', gql: 'graphql', sql: 'sql',
  rb: 'ruby', php: 'php', lua: 'lua', dart: 'dart', swift: 'swift',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
  diff: 'diff', patch: 'diff', pl: 'perl', r: 'r',
};

const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;
const HIGHLIGHT_TIMEOUT_MS = 10_000;
const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;

export function getSftpCodeLanguage(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const name = fileName.trim().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const extension = getFileExtension(name);
  return Object.prototype.hasOwnProperty.call(LANGUAGES, extension) ? LANGUAGES[extension] : undefined;
}

function remember(key: string, html: string): void {
  const bytes = (key.length + html.length) * 2;
  if (bytes > MAX_CACHE_BYTES) return;
  const previous = cache.get(key);
  if (previous) {
    cacheBytes -= previous.bytes;
    cache.delete(key);
  }
  cache.set(key, { html, bytes });
  cacheBytes += bytes;
  while (cacheBytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    cache.delete(oldest[0]);
    cacheBytes -= oldest[1].bytes;
  }
}

export function highlightSftpCode(
  content: string,
  fileName?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const language = getSftpCodeLanguage(fileName);
  if (!language || !content || signal?.aborted) return Promise.resolve(null);
  const key = `${language}\0${content}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached.html);
  }
  if (typeof Worker === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (html: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
      if (html !== null) remember(key, html);
      resolve(html);
    };
    const abort = (): void => finish(null);
    try {
      worker = new Worker(new URL('./sftp-code-highlight.worker.ts', import.meta.url), { type: 'module' });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(null), HIGHLIGHT_TIMEOUT_MS);
      worker.onmessage = (event: MessageEvent<unknown>) => finish(typeof event.data === 'string' ? event.data : null);
      worker.onerror = (event) => {
        event.preventDefault();
        finish(null);
      };
      worker.onmessageerror = () => finish(null);
      worker.postMessage({ content, language });
    } catch {
      finish(null);
    }
  });
}
