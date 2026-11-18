import { describe, expect, it } from 'vitest';
import { aiLocalFileReference } from '../file-reference';

describe('AI Markdown file references', () => {
  it('keeps the file path separate from line and column positions', () => {
    expect(aiLocalFileReference('C:\\work\\file.ts:22:3', 'code')).toEqual({
      path: 'C:\\work\\file.ts', line: 22, column: 3,
    });
    expect(aiLocalFileReference('file:///C:/work/file%20name.ts#L8-L14', 'link')).toEqual({
      path: 'C:/work/file name.ts', line: 8, column: undefined,
    });
    expect(aiLocalFileReference('/tmp/file%3A25.txt:7', 'link')).toEqual({
      path: '/tmp/file:25.txt', line: 7, column: undefined,
    });
    expect(aiLocalFileReference('/tmp/file%20name.txt', 'code')?.path).toBe('/tmp/file%20name.txt');
  });

  it.each(['code', 'link'] as const)('preserves a POSIX filename ending in numbers after a colon in remote %s', source => {
    expect(aiLocalFileReference('/var/log/worker:2026', source, 'remote')).toEqual({
      path: '/var/log/worker:2026', line: undefined, column: undefined,
    });
  });

  it('recognizes an explicit remote line fragment without consuming the filename suffix', () => {
    expect(aiLocalFileReference('file:///var/log/worker%3A2026#L12C3', 'link', 'remote')).toEqual({
      path: '/var/log/worker:2026', line: 12, column: 3,
    });
  });

  it.each([
    '../file.ts',
    'https://example.com/file.ts',
    '//example.com/file.ts',
    'file://example.com/file.ts',
    '/tmp/%00file.ts',
  ])('does not treat %s as a local file link', href => {
    expect(aiLocalFileReference(href, 'link')).toBeUndefined();
  });
});
