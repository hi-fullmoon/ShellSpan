import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStreamingMarkdownSplitter, splitStreamingMarkdown } from '../streaming-markdown';

const documents = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md']
  .map((path) => readFileSync(path, 'utf8'));

describe('streaming Markdown cache', () => {
  it('preserves Markdown boundaries while replaying repository documents', () => {
    for (const document of documents) {
      const split = createStreamingMarkdownSplitter();
      for (let length = 1; length < document.length; length += 73) {
        const content = document.slice(0, length);
        const chunks = split(content);
        expect(chunks).toEqual(splitStreamingMarkdown(content));
        expect(split(content)).toBe(chunks);
      }
      expect(split(document)).toEqual(splitStreamingMarkdown(document));
    }
  });

  it('invalidates cached prefixes on edits, deletion and replacement', () => {
    const split = createStreamingMarkdownSplitter();
    for (const content of [...documents, documents[0].slice(0, 500), '', documents[0]]) {
      expect(split(content)).toEqual(splitStreamingMarkdown(content));
    }
  });

  it('reparses earlier references when a multiline definition arrives late', () => {
    const split = createStreamingMarkdownSplitter(80);
    const prefix = `${documents[0]}\n\n[documentation][docs]\n\n[docs]:\n`;
    split(prefix);
    const content = `${prefix}  https://example.com/documentation\n`;
    expect(split(content)).toEqual([content]);
  });
});
