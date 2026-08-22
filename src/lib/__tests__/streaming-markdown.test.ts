import { describe, expect, it } from 'vitest';
import { splitStreamingMarkdown } from '@/lib/streaming-markdown';

describe('splitStreamingMarkdown', () => {
  it('keeps completed chunks stable as the tail grows', () => {
    const blocks = Array.from(
      { length: 10 },
      (_, index) => `## Section ${index}\n\nParagraph ${index} with **Markdown**.\n\n`,
    ).join('');
    const initial = `${blocks}Tail`;
    const initialChunks = splitStreamingMarkdown(initial, 120);
    const nextChunks = splitStreamingMarkdown(`${initial} continues.`, 120);

    expect(initialChunks.length).toBeGreaterThan(1);
    expect(Math.max(...initialChunks.map((chunk) => chunk.length))).toBeLessThan(180);
    expect(nextChunks.slice(0, -1)).toEqual(initialChunks.slice(0, -1));
    expect(nextChunks.join('')).toBe(`${initial} continues.`);
  });

  it('does not split inside fenced code or a loose list', () => {
    const fenced = `\`\`\`bash\n${'echo hello\n'.repeat(40)}\`\`\`\n\nAfter.\n`;
    const looseList = `${Array.from(
      { length: 12 },
      (_, index) => `${index + 1}. Item ${index}\n\n`,
    ).join('')}After list.\n`;

    expect(splitStreamingMarkdown(fenced, 80)[0]).toContain('```bash');
    expect(splitStreamingMarkdown(fenced, 80)[0]).toContain('```\n');
    expect(splitStreamingMarkdown(looseList, 80)[0]).toContain('12. Item 11');
  });

  it('keeps reference definitions in the same syntax tree as their links', () => {
    const content = `${'Long paragraph.\n\n'.repeat(20)}See [the docs][docs].\n\n[docs]: https://example.com\n`;

    expect(splitStreamingMarkdown(content, 80)).toEqual([content]);
  });
});
