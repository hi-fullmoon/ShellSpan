import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const fixture = process.env.SHELLSPAN_LINUX_HOST_RECORDING;
describe.skipIf(!fixture)('actual Linux host lifecycle recording', () => {
  const root = path.resolve(fixture ?? '.');
  const read = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));

  it('confirms real Linux root normal exit, timeout, cancellation and disconnect', () => {
    const normal = read('target-1-lifecycle/host-normal.json').data;
    expect(normal.stdout).toBe('Linux\n0\nhost-normal');
    expect(normal.exitCode).toBe(0);
    expect(normal.terminationConfirmed).toBe(true);
    expect(normal.sandboxBackend).toBe('host-account');
    expect(normal.sandboxCapability.status).toBe('unavailable');
    const timeout = read('target-1-lifecycle/host-timeout.json').data;
    expect(timeout).toMatchObject({ stdout: 'host-started', lifecycle: 'timedOut',
      terminationConfirmed: true, failure: { admission: 'started' } });
    const cancelled = read('target-1-lifecycle/host-cancel.json');
    expect(cancelled).toMatchObject({ stdout: 'host-started', state: 'cancelled', terminationConfirmed: true });
    const disconnected = read('target-1-lifecycle/host-disconnect.json');
    expect(disconnected).toMatchObject({ stdout: 'host-started', state: 'failed',
      terminationConfirmed: true, failure: { admission: 'started', code: 'sandboxAuthorizationInvalid' } });
    expect(cancelled.processHandle).not.toBe(disconnected.processHandle);
    const end = read('target-1-lifecycle/host-lifecycle.json');
    expect(end).toMatchObject({ passed: true, sourceWorkerJoined: true, sourcePtyWrites: 0,
      ledger: { debt: 0, custody: 0 }, stage3Allowed: false });
  });

  it('recovers only the signed own custody after a real owned Child crash', () => {
    const checkpoint = read('target-1-crash/host-checkpoint.json');
    expect(checkpoint).toMatchObject({ actualStarted: true, ledger: { debt: 1, custody: 1 },
      process: { stdout: 'host-started', state: 'running', terminationConfirmed: false } });
    const report = read('report.json');
    expect(report.profiles[0]).toMatchObject({ ownedChildWaitExitCode: -9, crashRecoveryExitCode: 0 });
    expect(report.sourceUnchanged).toBe(true);
    expect(report.binaryUnchanged).toBe(true);
    const recovered = read('target-1-crash/host-recovery.json');
    expect(recovered).toMatchObject({ passed: true, recovery: { resolved: 1, uncertain: 0 },
      ledger: { debt: 0, custody: 0 }, stage3Allowed: false });
    expect(report.stage3Allowed).toBe(false);
  });
});

const recoveryReport = process.env.SHELLSPAN_LINUX_HOST_ORIGINAL_RECOVERY_REPORT;
describe.skipIf(!recoveryReport)('original Linux host capsule recovery recording', () => {
  it('preserves the failed execution and records separately confirmed cleanup', () => {
    const reportPath = path.resolve(recoveryReport ?? '.');
    const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
    const original = read(path.join(path.dirname(reportPath), 'host-normal.json')).data;
    expect(original).toMatchObject({ stdout: 'Linux\n0\nhost-normal', terminationConfirmed: false,
      failure: { admission: 'started' } });
    expect(read(path.join(path.dirname(reportPath), 'host-recovery.json'))).toMatchObject({
      passed: false, recovery: { resolved: 0, uncertain: 1 }, ledger: { debt: 1, custody: 1 },
    });
    expect(read(reportPath)).toMatchObject({ passed: true,
      recovery: { resolved: 1, uncertain: 0 }, ledger: { debt: 0, custody: 0 },
      scope: 'cleanup-only; no original command replay or execution grant', stage3Allowed: false,
    });
  });
});

const uncertainStartup = process.env.SHELLSPAN_LINUX_HOST_STARTUP_RECORDING;
describe.skipIf(!uncertainStartup)('actual uncertain Linux host startup recording', () => {
  it('retains protected debt when the original startup has no verified terminal receipt', () => {
    const root = path.resolve(uncertainStartup ?? '.');
    const read = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
    expect(read('host-normal.json').data).toMatchObject({
      stdout: '', terminationConfirmed: false, failure: { admission: 'unknown' },
    });
    expect(read('host-recovery.json')).toMatchObject({
      passed: false, recovery: { resolved: 0, uncertain: 1 }, ledger: { debt: 1, custody: 1 },
      stage3Allowed: false, scope: 'cleanup-only; no original command replay or execution grant',
    });
    expect(read('../report.json')).toMatchObject({
      passed: false, sourceUnchanged: true, binaryUnchanged: true, stage3Allowed: false,
    });
  });
});
