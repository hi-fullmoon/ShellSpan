import { describe, expect, it } from 'vitest';
import { connectionTestFailureKey } from '../provider-setup-dialog';
import enUS from '@/locales/en-US';
import zhCN from '@/locales/zh-CN';

describe('provider connection failure feedback', () => {
  it('explains the observed OpenRouter 404 without treating every 404 as a missing URL', () => {
    const key = connectionTestFailureKey({ type: 'failed', kind: 'terminal', status: 404 }, 'openrouter');
    expect(key).toBe('settings.ai.testConnectionNoEndpoint');
    expect(zhCN[key]).toContain('{model}');
    expect(zhCN[key]).toContain('没有可用节点');
    expect(enUS[key]).toContain('{model}');
    expect(enUS[key]).toContain('no available endpoints');
    expect(connectionTestFailureKey({ type: 'failed', kind: 'terminal', status: 404 }, 'generic'))
      .toBe('settings.ai.testConnectionNotFound');
  });
});
