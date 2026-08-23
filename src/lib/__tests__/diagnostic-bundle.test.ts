import { describe, expect, it } from 'vitest';
import { buildDiagnosticBundle } from '@/lib/diagnostic-bundle';

describe('diagnostic bundle', () => {
  it('contains explicit feature state and redacts selected logs', () => {
    const bundle = buildDiagnosticBundle({
      version: '2.1.0',
      platform: 'Windows',
      locale: 'zh-CN',
      featureState: {
        terminalSessions: 2,
        sftpTabs: 1,
        activeTransfers: 0,
        aiConfigured: true,
      },
      recentFailures: [{
        operationId: 'transfer-123',
        kind: 'upload',
        category: 'network',
      }],
      selectedLog: {
        name: 'termbridge.log',
        source: 'frontend',
        content: 'PASSWORD=hunter2\nAuthorization: Bearer token-value',
      },
    }, '2026-08-23T00:00:00.000Z');

    expect(bundle).not.toContain('hunter2');
    expect(bundle).not.toContain('token-value');
    expect(JSON.parse(bundle)).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-08-23T00:00:00.000Z',
      application: { name: 'TermBridge', version: '2.1.0', platform: 'Windows' },
      featureState: { terminalSessions: 2, sftpTabs: 1 },
      recentFailures: [{ operationId: 'transfer-123', kind: 'upload', category: 'network' }],
    });
  });
});
