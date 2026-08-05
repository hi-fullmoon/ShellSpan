import { describe, expect, it } from 'vitest';
import { elideMiddle } from '../elide-middle';

// Deterministic measurement: 1 unit per character.
const measure = (text: string): number => text.length;

describe('elideMiddle', () => {
  it('returns the original text when it fits', () => {
    expect(elideMiddle('short.txt', 20, measure)).toBe('short.txt');
  });

  it('elides the middle, keeping both the head and the tail visible', () => {
    expect(elideMiddle('abcdefghij', 7, measure)).toBe('abc…hij');
  });

  it('keeps the tail (e.g. file extension) readable at narrow widths', () => {
    const result = elideMiddle('a-very-long-file-name', 10, measure);
    expect(result).toBe('a-ver…name');
    expect(result.startsWith('a-ver')).toBe(true);
    expect(result.endsWith('name')).toBe(true);
  });

  it('falls back to a bare ellipsis when nothing else fits', () => {
    expect(elideMiddle('abcdefghij', 1, measure)).toBe('…');
  });

  it('never splits surrogate pairs (emoji) when eliding', () => {
    const measureCodePoints = (text: string): number => Array.from(text).length;
    expect(elideMiddle('a😀bcdef', 4, measureCodePoints)).toBe('a😀…f');
  });
});
