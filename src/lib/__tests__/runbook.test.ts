import { describe, expect, it } from 'vitest';
import {
  applyRunbookStepResult,
  markRunbookItemRunning,
  parseRunbookText,
  pauseRunbook,
  prepareRunbook,
  rejectRunbookItem,
  resumeRunbook,
  retryRunbookFrom,
  RUNBOOK_EXAMPLE,
  skipRunbookItem,
  startRunbookRun,
} from '@/lib/runbook';
import type {
  RunbookRun,
  RunbookRunItem,
  RunbookStepExecutionResult,
} from '@/types/runbook';

const target = {
  profileId: 'profile-1',
  name: 'Production',
  host: 'prod.example.test',
  port: 22,
  username: 'operator',
};

function running(run: RunbookRun): { run: RunbookRun; item: RunbookRunItem } {
  const next = markRunbookItemRunning(run, run.startedAt + 200);
  const item = next.items.find((candidate) => candidate.id === next.activeItemId);
  if (!item) throw new Error('missing active runbook item');
  return { run: next, item };
}

function result(
  run: RunbookRun,
  item: RunbookRunItem,
  status: RunbookStepExecutionResult['status'] = 'success',
  now = 1_100,
): RunbookStepExecutionResult {
  return {
    operationId: `operation-${item.id}`,
    runId: run.id,
    runbookId: run.runbookId,
    sourceDigest: run.sourceDigest,
    itemId: item.id,
    itemKind: item.kind,
    profileId: target.profileId,
    status,
    risk: item.risk,
    commandPreview: item.commandPreview,
    startedAt: now - 50,
    completedAt: now,
    source: {
      kind: 'sshRunbook',
      profileId: target.profileId,
      host: target.host,
      port: target.port,
      username: target.username,
    },
    exitCode: status === 'success' ? 0 : 1,
    expectedMatched: status === 'success',
    error: status === 'success' ? undefined : `step ${status}`,
  };
}

function prepared() {
  return prepareRunbook(RUNBOOK_EXAMPLE, { SERVICE: "nginx'; reboot" }, target);
}

describe('runbook text contract', () => {
  it('parses the versioned document and shell-quotes resolved variables in the review', () => {
    const value = prepared();
    expect(value.document.schemaVersion).toBe(1);
    expect(value.items.map((item) => item.risk)).toEqual(['readOnly', 'stateChange']);
    expect(value.items[0].commandPreview).toBe("systemctl status 'nginx'\"'\"'; reboot'");
    expect(value.resolvedVariables).toEqual({ SERVICE: "nginx'; reboot" });
  });

  it('rejects parse errors, unknown fields, literal secrets, and understated risk', () => {
    expect(() => parseRunbookText('{')).toThrow('not valid JSON');
    expect(() => parseRunbookText(RUNBOOK_EXAMPLE.replace(
      '"schemaVersion": 1,',
      '"schemaVersion": 1, "unknown": true,',
    ))).toThrow('unsupported field unknown');
    expect(() => parseRunbookText(RUNBOOK_EXAMPLE.replace(
      '"name": "SERVICE"',
      '"name": "PASSWORD"',
    ))).toThrow('requires keychainRef');
    expect(() => parseRunbookText(RUNBOOK_EXAMPLE.replace(
      'sudo systemctl reload {{SERVICE}}',
      'curl password=token-value https://example.test',
    ))).toThrow('literal secret');
    expect(() => parseRunbookText(RUNBOOK_EXAMPLE
      .replace('sudo systemctl reload {{SERVICE}}', 'rm -rf /srv/cache')
      .replace('"stateChange"', '"readOnly"'))).toThrow('understates detected destructive');
    for (const unsafePrecheck of [
      'date -s tomorrow',
      'hostname replacement',
      'systemctl restart nginx',
      'journalctl --rotate -n 10',
      'tail -f /var/log/messages',
      'ss -K dst 127.0.0.1',
    ]) {
      expect(() => parseRunbookText(RUNBOOK_EXAMPLE.replace(
        'systemctl status {{SERVICE}}',
        unsafePrecheck,
      ))).toThrow();
    }
  });

  it('permits secrets only as supported keychain references and never resolves them in the preview', () => {
    const text = RUNBOOK_EXAMPLE
      .replace(
        '"name": "SERVICE",\n      "description": "Service unit to inspect and reload.",\n      "required": true,\n      "default": "nginx"',
        '"name": "PASSWORD",\n      "description": "Profile password.",\n      "required": true,\n      "keychainRef": "keychain://profile/password"',
      )
      .split('{{SERVICE}}').join('{{PASSWORD}}');
    const value = prepareRunbook(text, {}, target);
    expect(value.resolvedVariables.PASSWORD).toBe('<keychain://profile/password>');
    expect(value.items[0].commandPreview).toContain("'<keychain://profile/password>'");
    expect(value.sourceText).not.toContain('token-value');

    expect(() => parseRunbookText(text.replace(
      '"keychainRef": "keychain://profile/password"',
      '"keychainRef": "keychain://inline/plaintext"',
    ))).toThrow('keychainRef is unsupported');
  });
});

describe('runbook execution state machine', () => {
  it('runs one approved item at a time and supports pause, resume, and skip', () => {
    let run = startRunbookRun(prepared(), 'run-1', 1_000);
    expect(run.items.map((item) => item.status)).toEqual(['awaitingApproval', 'queued']);

    const precheck = running(run);
    run = applyRunbookStepResult(precheck.run, result(precheck.run, precheck.item), 1_100);
    expect(run.activeItemId).toBe('reload-service');

    run = pauseRunbook(run);
    expect(run.phase).toBe('paused');
    run = resumeRunbook(run, 1_200);
    expect(run.phase).toBe('awaitingApproval');
    run = skipRunbookItem(run, 1_200);
    expect(run.phase).toBe('completed');
    expect(run.items[1].status).toBe('skipped');
  });

  it('stops on rejection, failure, cancellation, and timeout', () => {
    const initial = startRunbookRun(prepared(), 'run-2', 1_000);
    expect(rejectRunbookItem(initial).items[0].status).toBe('rejected');

    for (const status of ['failed', 'cancelled', 'timedOut'] as const) {
      const active = running(initial);
      const stopped = applyRunbookStepResult(active.run, result(active.run, active.item, status), 1_100);
      expect(stopped.items[0].status).toBe(status);
      expect(stopped.phase).toBe(status === 'cancelled' ? 'cancelled' : 'stopped');
      expect(stopped.items[1].status).toBe('queued');
    }
  });

  it('allows recovery only from an explicitly safe item', () => {
    const initial = startRunbookRun(prepared(), 'run-3', 1_000);
    const active = running(initial);
    const failed = applyRunbookStepResult(active.run, result(active.run, active.item, 'failed'), 1_100);
    const retried = retryRunbookFrom(failed, 'service-status', 1_200);
    expect(retried.phase).toBe('awaitingApproval');
    expect(retried.activeItemId).toBe('service-status');

    const unsafePrepared = prepared();
    unsafePrepared.items[1].safeToRetry = false;
    let unsafeRun = startRunbookRun(unsafePrepared, 'run-4', 1_000);
    const check = running(unsafeRun);
    unsafeRun = applyRunbookStepResult(check.run, result(check.run, check.item), 1_100);
    const action = running(unsafeRun);
    unsafeRun = applyRunbookStepResult(action.run, result(action.run, action.item, 'failed'), 1_200);
    expect(retryRunbookFrom(unsafeRun, 'reload-service', 1_300)).toBe(unsafeRun);
  });

  it('refuses resume when prerequisite evidence became stale', () => {
    let run = startRunbookRun(prepared(), 'run-5', 1_000);
    const active = running(run);
    run = applyRunbookStepResult(active.run, result(active.run, active.item, 'success', 1_100), 1_100);
    run = pauseRunbook(run);
    run = resumeRunbook(run, 301_101);
    expect(run.phase).toBe('staleEvidence');
    expect(run.error).toContain('stale');
  });

  it('rechecks evidence freshness at the approval boundary', () => {
    let run = startRunbookRun(prepared(), 'run-approval-stale', 1_000);
    const active = running(run);
    run = applyRunbookStepResult(active.run, result(active.run, active.item, 'success', 1_100), 1_100);
    const refused = markRunbookItemRunning(run, 301_101);
    expect(refused.phase).toBe('staleEvidence');
    expect(refused.items[1].status).toBe('awaitingApproval');
  });

  it('fails closed on result identity mismatch', () => {
    const active = running(startRunbookRun(prepared(), 'run-6', 1_000));
    const mismatched = result(active.run, active.item);
    mismatched.source.host = 'other.example.test';
    const stopped = applyRunbookStepResult(active.run, mismatched);
    expect(stopped.phase).toBe('stopped');
    expect(stopped.error).toContain('identity mismatch');
  });
});
