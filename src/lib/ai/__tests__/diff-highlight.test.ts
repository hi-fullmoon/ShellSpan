import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDiffHighlightCacheForTests,
  getCachedDiffLineHtml,
  highlightDiffLineSync,
  resolveDiffHighlightLanguage,
  scheduleDiffLinesHighlight,
} from '../diff-highlight';

describe('diff-highlight', () => {
  afterEach(() => {
    clearDiffHighlightCacheForTests();
    vi.restoreAllMocks();
  });

  it('resolves language aliases and rejects unknown extensions', () => {
    expect(resolveDiffHighlightLanguage('src/App.tsx')).toBe('typescript');
    expect(resolveDiffHighlightLanguage('scripts/check.mjs')).toBe('javascript');
    expect(resolveDiffHighlightLanguage('src-tauri/src/lib.rs')).toBe('rs');
    expect(resolveDiffHighlightLanguage('README')).toBeNull();
    expect(resolveDiffHighlightLanguage('data.unknownextxyz')).toBeNull();
  });

  it('caches synchronous line highlighting results and skips empty or oversized lines', () => {
    const line = 'const answer = 42;';
    expect(getCachedDiffLineHtml('typescript', line)).toBeUndefined();
    const html = highlightDiffLineSync('typescript', line);
    expect(html).toContain('hljs-keyword');
    expect(getCachedDiffLineHtml('typescript', line)).toBe(html);

    expect(highlightDiffLineSync('typescript', '')).toBeNull();
    expect(highlightDiffLineSync('typescript', 'a'.repeat(10_001))).toBeNull();
  });

  it('progressively highlights uncached lines in chunks and honors cancellation', async () => {
    const lines = Array.from({ length: 140 }, (_, idx) => `const item_${idx} = ${idx};`);
    const progressCalls: number[] = [];

    const cancel = scheduleDiffLinesHighlight('typescript', lines, () => {
      progressCalls.push(progressCalls.length + 1);
    });

    await vi.waitFor(() => {
      expect(getCachedDiffLineHtml('typescript', lines[lines.length - 1])).toBeDefined();
    });

    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    cancel();

    // Already cached lines should not schedule any work.
    const noopProgress = vi.fn();
    scheduleDiffLinesHighlight('typescript', lines.slice(0, 10), noopProgress);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(noopProgress).not.toHaveBeenCalled();
  });
});
