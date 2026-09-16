import { describe, expect, it } from 'vitest';

import enUS from '../en-US';
import zhCN from '../zh-CN';

describe('locale catalog key sets', () => {
  it('keeps English and Simplified Chinese keys identical', () => {
    const englishKeys = Object.keys(enUS).sort();
    const chineseKeys = Object.keys(zhCN).sort();

    expect(englishKeys).toEqual(chineseKeys);
  });

  it('covers every terminal surface presentation state', () => {
    for (const key of [
      'agent.executionSurface.v1.state.initializing',
      'agent.executionSurface.v1.state.ready',
      'agent.executionSurface.v1.state.unavailable',
      'agent.executionSurface.v1.state.directFallback',
    ] as const) {
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).toBeTruthy();
    }
  });
});
