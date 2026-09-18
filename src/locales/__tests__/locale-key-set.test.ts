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

  it('keeps native deployment timeline events readable without legacy deployment UI keys', () => {
    for (const key of [
      'deployment.prepare.running',
      'deployment.prepare.failed',
      'deployment.prepare.succeeded',
      'deployment.attempt.started',
      'deployment.run.coordinatorStopped',
      'deployment.run.integrityUnknown',
    ] as const) {
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).toBeTruthy();
    }

    for (const key of [
      'deployment.form.createTitle',
      'deployment.artifact.build',
      'deployment.preflight.run',
      'deployment.transfer.upload',
      'deployment.execute.run',
    ]) {
      expect(enUS).not.toHaveProperty(key);
      expect(zhCN).not.toHaveProperty(key);
    }
  });
});
