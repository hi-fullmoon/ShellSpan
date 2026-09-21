import { describe, expect, it } from 'vitest';
import { fallbackSessionTitle } from '../session-title';

describe('fallbackSessionTitle', () => {
  it('keeps short task names and collapses whitespace', () => {
    expect(fallbackSessionTitle('  排查\n Nginx\t启动失败 ')).toBe('排查 Nginx 启动失败');
    expect(fallbackSessionTitle('Inspect nginx')).toBe('Inspect nginx');
  });

  it('bounds long goals without splitting Unicode code points', () => {
    expect(fallbackSessionTitle('测'.repeat(60))).toBe(`${'测'.repeat(47)}…`);
    expect(fallbackSessionTitle('𠮷'.repeat(60))).toBe(`${'𠮷'.repeat(47)}…`);
    expect(fallbackSessionTitle('a'.repeat(48))).toHaveLength(48);
  });
});
