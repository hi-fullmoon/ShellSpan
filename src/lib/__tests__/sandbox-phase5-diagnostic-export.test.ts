import { describe, expect, it } from 'vitest';
import { buildDiagnosticBundle } from '@/lib/diagnostic-bundle';
import { formatLogRecord } from '@/lib/logger';

describe('sandbox acceptance diagnostic serialization', () => {
  it('preserves diagnostic metadata and removes owned secret, bearer and environment markers', () => {
    const content = [
      'backend=macos-seatbelt capability=partial exitCode=1',
      'secret=phase5-owned-secret',
      'Authorization: Bearer phase5-owned-bearer',
      'OPENAI_API_KEY=phase5-owned-env',
      'AWS_SECRET_ACCESS_KEY=phase5-owned-cloud',
    ].join('\n');
    const bundle = buildDiagnosticBundle({
      version: 'acceptance', platform: 'macOS', locale: 'zh-CN',
      featureState: { terminalSessions: 1, sftpTabs: 0, activeTransfers: 0, aiConfigured: true },
      recentFailures: [{ operationId: 'phase5-operation', kind: 'upload', category: 'network' }],
      selectedLog: { name: 'backend.log', source: 'backend', content },
    }, '2026-10-07T00:00:00Z');
    for (const marker of ['phase5-owned-secret', 'phase5-owned-bearer', 'phase5-owned-env', 'phase5-owned-cloud']) {
      expect(bundle).not.toContain(marker);
    }
    expect(JSON.parse(bundle)).toMatchObject({
      schemaVersion: 1, application: { name: 'ShellSpan', version: 'acceptance' },
      featureState: { terminalSessions: 1, aiConfigured: true },
      recentFailures: [{ operationId: 'phase5-operation', category: 'network' }],
      selectedLog: { name: 'backend.log', source: 'backend' },
    });
    expect(bundle).toContain('backend=macos-seatbelt capability=partial exitCode=1');
  });

  it('redacts the production logger module, message and details while retaining failure facts', () => {
    const record = formatLogRecord('backend secret=phase5-owned-module',
      'failed exitCode=1 Authorization: Bearer phase5-owned-message',
      ['OPENAI_API_KEY=phase5-owned-detail']);
    for (const marker of ['phase5-owned-module', 'phase5-owned-message', 'phase5-owned-detail']) {
      expect(record).not.toContain(marker);
    }
    expect(record).toContain('backend');
    expect(record).toContain('failed exitCode=1');
    expect(record).toContain('[REDACTED]');
  });

  it('redacts prefixed and CamelCase structured credential values while retaining references and IDs', () => {
    const record = formatLogRecord('backend', 'authorization failed', [{
      OPENAI_API_KEY: 'phase5-owned-api',
      customProviderApiKey: 'phase5-owned-custom',
      AWS_SECRET_ACCESS_KEY: 'phase5-owned-cloud',
      servicePassword: 'phase5-owned-password',
      credentialReference: 'phase5-reference', operationId: 'phase5-operation', exitCode: 1,
    }]);
    for (const marker of ['phase5-owned-api', 'phase5-owned-custom', 'phase5-owned-cloud', 'phase5-owned-password']) {
      expect(record).not.toContain(marker);
    }
    expect(record).toContain('phase5-reference');
    expect(record).toContain('phase5-operation');
    expect(record).toContain('"exitCode":1');
  });
});
