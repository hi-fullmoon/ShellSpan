import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI inline icon spacing', () => {
  it.each([
    ['ai-mention-panel.tsx', 'h-7 w-full min-w-0 justify-start gap-1 px-1.5'],
    ['ai-task-strip.tsx', 'flex min-h-5 min-w-0 shrink-0 items-center gap-1'],
    ['ai-context-meter.tsx', 'flex min-w-0 items-center gap-1'],
  ])('%s keeps icon labels centered with the shared gap', (file, classes) => {
    const source = readFileSync(`src/components/ai/workspace/${file}`, 'utf8');
    expect(source).toContain(`className="${classes}"`);
    if (file === 'ai-context-meter.tsx') {
      expect(source).not.toContain('mr-1.5 inline-block size-2 align-baseline');
    }
  });
});
