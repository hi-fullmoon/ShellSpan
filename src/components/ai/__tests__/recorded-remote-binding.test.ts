import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@/types/agent-session';

const fixture = process.env.SHELLSPAN_STAGE2_BINDING_FIXTURE;
describe.skipIf(!fixture)('real Wry SSH approval binding recording', () => {
  const root = resolve(fixture ?? '.');
  const pages = (): AgentSessionEvent[][] => readdirSync(join(root, 'fixture/agent-runtime/sessions-v5'))
    .filter(name => name.endsWith('.jsonl')).map(name => readFileSync(join(root, 'fixture/agent-runtime/sessions-v5', name), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as AgentSessionEvent));

  it('cancels the original approval before expiry without dispatch after an actual SSH reconnect', () => {
    const rows = pages().find(page => page.some(event => event.type === 'tool/approval'
      && event.data.status === 'cancelled' && event.data.reason?.includes('Remote execution binding changed')));
    if (!rows) throw new Error('Actual cancelled original SSH approval required');
    const requested = rows.find(event => event.type === 'tool/approval' && event.data.status === 'requested');
    const cancelled = rows.find(event => event.type === 'tool/approval' && event.data.status === 'cancelled');
    if (requested?.type !== 'tool/approval' || cancelled?.type !== 'tool/approval') throw new Error('Actual approval pair missing');
    expect(cancelled.data.approvalId).toBe(requested.data.approvalId);
    expect(cancelled.timeUnixMs).toBeLessThan(requested.data.expiresAtUnixMs!);
    expect(rows.some(event => event.type === 'tool/execution')).toBe(false);
    expect(rows.some(event => event.type === 'tool/approval' && event.data.status === 'approved')).toBe(false);
    const disconnected = JSON.parse(readFileSync(join(root, 'fixture/binding-disconnected.json'), 'utf8')) as { beforeGeneration: string | null; afterGeneration: string | null };
    const connected = JSON.parse(readFileSync(join(root, 'fixture/binding-reconnected.json'), 'utf8')) as { afterGeneration: string | null };
    expect(disconnected.beforeGeneration).toBeTruthy();
    expect(disconnected.afterGeneration).toBeNull();
    expect(connected.afterGeneration).toBeTruthy();
    expect(connected.afterGeneration).not.toBe(disconnected.beforeGeneration);
  });

  it('requires fresh explicit UI approval and evidence matching the current production revision', () => {
    const report = JSON.parse(readFileSync(join(root, 'binding-evidence.json'), 'utf8')) as {
      passed: boolean; stage3Allowed: boolean; oldSession: string; freshSession: string;
      checks: Record<string, boolean>; sourceSha256: Record<string, string>;
    };
    expect(report.passed).toBe(true);
    expect(report.stage3Allowed).toBe(false);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(report.freshSession).not.toBe(report.oldSession);
    for (const [file, digest] of Object.entries(report.sourceSha256)) {
      expect(createHash('sha256').update(readFileSync(resolve(file))).digest('hex'), file).toBe(digest);
    }
    expect(readFileSync(join(root, 'fresh-pending.ax.txt'), 'utf8')).toContain('允许执行一次');
    expect(readFileSync(join(root, 'fresh-terminal.ax.txt'), 'utf8')).toContain('已批准');
  });
});

const closingFixture = process.env.SHELLSPAN_STAGE2_CLOSE_FIXTURE;
describe.skipIf(!closingFixture)('resident owned SSH fixture closing receipt', () => {
  it('confirms native shutdown, joins the source and waits the owned Child before reporting exit', () => {
    const root = resolve(closingFixture!);
    const read = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, name), 'utf8')) as Record<string, unknown>;
    const receipt = read('fixture/fixture-shutdown.json');
    const fixture = receipt.fixture as Record<string, unknown>;
    expect(receipt.runtimeShutdownConfirmed).toBe(true);
    expect(fixture.sourceWorkerJoined).toBe(true);
    expect(fixture.serverWaitConfirmed).toBe(true);
    expect(fixture.ownedCredentialReleased).toBe(true);
    expect(receipt.sourcePtyWrites).toBe(0);
    const native = read('fixture/settings-review.json');
    expect(native.exitCode).toBe(0);
    expect(native.modelRequests).toBe(receipt.modelRequests);
    expect(native.sessionsCreated).toBe(receipt.sessionsCreated);
    const launch = read('launch-final.json');
    expect(launch.exitCode).toBe(0);
    expect(launch.sourceUnchanged).toBe(true);
    expect(launch.binaryUnchanged).toBe(true);
  });
});
