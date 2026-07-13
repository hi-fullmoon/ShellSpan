import { describe, expect, it } from 'vitest';
import { cn, formatBytes, generateId } from './utils';

describe('utils', () => {
  describe('cn', () => {
    it('merges tailwind classes', () => {
      expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    });

    it('handles conditional classes', () => {
      expect(cn('base', false && 'hidden', 'block')).toBe('base block');
    });
  });

  describe('formatBytes', () => {
    it('formats bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
      expect(formatBytes(undefined)).toBe('-');
    });
  });

  describe('generateId', () => {
    it('generates unique ids', () => {
      const a = generateId();
      const b = generateId();
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThan(0);
    });
  });
});
