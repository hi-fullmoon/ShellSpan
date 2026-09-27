import { describe, expect, it } from 'vitest';

import { initialSessionIntent } from '@/lib/ai/session-intent';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';

describe('initialSessionIntent', () => {
  it.each(['', '   ', '\n\t'])('does not invent success criteria for image-only input %j', content => {
    for (const locale of [zhCN, enUS]) {
      const goal = locale['ai.workspace.images.noTextGoal'];
      expect(initialSessionIntent(content, goal)).toEqual({ goal, successCriteria: [] });
      expect(goal).not.toBe(locale['ai.workspace.images.add']);
      expect(goal.trim()).not.toBe('');
    }
  });

  it('uses the actual request when images have accompanying text', () => {
    const text = '请解释截图中的 nginx 警告';
    expect(initialSessionIntent(text, zhCN['ai.workspace.images.noTextGoal']))
      .toEqual({ goal: text, successCriteria: [text] });
  });

  it('preserves the full goal while bounding native success criteria', () => {
    const text = '诊断'.repeat(300);
    const result = initialSessionIntent(text, zhCN['ai.workspace.images.noTextGoal']);
    expect(result.goal).toBe(text);
    expect(result.successCriteria).toEqual([`${text.slice(0, 511)}…`]);
    expect(new TextEncoder().encode(result.successCriteria[0]).length).toBeLessThanOrEqual(2048);
  });
});
