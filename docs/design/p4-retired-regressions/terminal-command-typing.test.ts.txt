import { describe, expect, it } from 'vitest';
import captures from '@/test/fixtures/terminal-command-source-native.json';
import { createTerminalCommandTyping } from '../registry/terminal-command-typing';

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('verified command typewriter', () => {
  it('reveals the captured source over real paint frames without splitting graphemes', async () => {
    const source = captures.cases[0].source;
    const shown: string[] = [];
    const typing = createTerminalCommandTyping(() => true, () => shown.push(typing.show('capture', source)));
    try {
      expect(typing.show('capture', source)).toBe('');
      await wait(180);
      expect(new Set(shown).size).toBeGreaterThan(2);
      expect(shown[0].length).toBeLessThan(source.length);
      const combining = source.indexOf('e\u0301');
      const emoji = source.indexOf('👩‍💻');
      for (const prefix of shown) {
        expect(source.startsWith(prefix)).toBe(true);
        expect(prefix.length).not.toBe(combining + 1);
        expect(prefix.length <= emoji || prefix.length >= emoji + '👩‍💻'.length).toBe(true);
      }
      const paints = shown.length;
      typing.retain(new Set());
      await wait(40);
      expect(shown).toHaveLength(paints);
    } finally { typing.dispose(); }
  });

  it('flushes confirmed text for reduced motion and submission, and stops after disposal', async () => {
    const source = captures.cases[0].source;
    let animated = false;
    let paints = 0;
    const typing = createTerminalCommandTyping(() => animated, () => { paints++; });
    try {
      expect(typing.show('capture', source)).toBe(source);
      await wait(40);
      expect(paints).toBe(0);
      animated = true;
      expect(typing.show('capture', source)).toBe('');
      expect(typing.show('capture', source, true)).toBe(source);
      const prefix = source.slice(0, source.indexOf('\n'));
      typing.show('next', prefix);
      typing.dispose();
      await wait(40);
      expect(paints).toBe(0);
    } finally { typing.dispose(); }
  });

  it('keeps progress across larger receipts and intermediate redraw prefixes', async () => {
    const source = captures.cases[0].source;
    let verified = source.slice(0, source.indexOf('\n'));
    const shown: string[] = [];
    const typing = createTerminalCommandTyping(() => true, () => shown.push(typing.show('capture', verified)));
    try {
      typing.show('capture', verified);
      await wait(80);
      const before = typing.show('capture', verified);
      expect(before.length).toBeGreaterThan(0);
      verified = source;
      expect(typing.show('capture', verified)).toBe(before);
      await wait(80);
      const current = typing.show('capture', verified);
      expect(current.length).toBeGreaterThan(before.length);
      const redraw = source.slice(0, source.indexOf('\n'));
      expect(redraw.startsWith(typing.show('capture', redraw))).toBe(true);
      expect(typing.show('capture', verified)).toBe(current);
    } finally { typing.dispose(); }
  });
});
