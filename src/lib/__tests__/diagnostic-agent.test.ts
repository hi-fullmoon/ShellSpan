import { describe, expect, it } from 'vitest';
import { parseRunbookText } from '@/lib/runbook';
import {
  createAgentRunbookDraft,
  isSafeReadOnlyAgentCommand,
  parseDiagnosticAgentPlan,
} from '../diagnostic-agent';

function planValue() {
  return {
    objective: 'Reload nginx after validating its current state',
    target: 'The currently bound nginx host only',
    assumptions: ['The service is managed by systemd.'],
    summary: 'Collect fresh service evidence before proposing one reviewed reload.',
    evidence: [
      {
        id: 'terminal-context',
        description: 'Original terminal context',
        source: 'context',
        sourceStepId: null,
        maxAgeSeconds: 120,
      },
      {
        id: 'service-status-output',
        description: 'Fresh nginx service status',
        source: 'stepOutput',
        sourceStepId: 'check-service',
        maxAgeSeconds: 45,
      },
    ],
    steps: [
      {
        id: 'check-service',
        title: 'Check nginx',
        description: 'Collect bounded read-only service status.',
        command: 'systemctl status nginx',
        risk: 'readOnly',
        evidenceIds: ['terminal-context'],
        impact: 'Reads status from the currently bound host.',
        rollback: 'No mutation is performed.',
        expected: { exitCode: 0, stdoutContains: [] },
        timeoutSeconds: 15,
        safeToRetry: true,
      },
      {
        id: 'reload-service',
        title: 'Reload nginx',
        description: 'Reload only after fresh evidence is accepted.',
        command: 'sudo systemctl reload nginx',
        risk: 'stateChange',
        evidenceIds: ['service-status-output'],
        impact: 'Reloads nginx on the reviewed host.',
        rollback: 'Restore the previous configuration and reload nginx again.',
        expected: { exitCode: 0, stdoutContains: [] },
        timeoutSeconds: 30,
        safeToRetry: false,
      },
    ],
  };
}

describe('diagnostic agent plan', () => {
  it('parses the structured objective, assumptions, evidence, risks, and rollback', () => {
    const plan = parseDiagnosticAgentPlan(JSON.stringify(planValue()));
    expect(plan.objective).toContain('Reload nginx');
    expect(plan.evidence[1]).toMatchObject({
      source: 'stepOutput',
      sourceStepId: 'check-service',
      maxAgeSeconds: 45,
    });
    expect(plan.steps[1]).toMatchObject({
      risk: 'stateChange',
      evidenceIds: ['service-status-output'],
      safeToRetry: false,
    });
  });

  it('creates a reviewable Runbook without executing or widening the target', () => {
    const plan = parseDiagnosticAgentPlan(JSON.stringify(planValue()));
    const runbook = parseRunbookText(createAgentRunbookDraft(plan));
    expect(runbook.evidenceMaxAgeSeconds).toBe(45);
    expect(runbook.prechecks).toEqual([
      expect.objectContaining({ id: 'check-service', command: 'systemctl status nginx' }),
    ]);
    expect(runbook.steps).toEqual([
      expect.objectContaining({
        id: 'reload-service',
        risk: 'stateChange',
        rollback: 'Restore the previous configuration and reload nginx again.',
      }),
    ]);
  });

  it('allows an evidence-only diagnostic Runbook with no modifying steps', () => {
    const value = planValue();
    value.steps = [value.steps[0]];
    const plan = parseDiagnosticAgentPlan(JSON.stringify(value));
    expect(parseRunbookText(createAgentRunbookDraft(plan)).steps).toEqual([]);
  });

  it('blocks modifying steps that cite only context, stale structure, or missing rollback', () => {
    const contextOnly = planValue();
    contextOnly.steps[1].evidenceIds = ['terminal-context'];
    expect(() => parseDiagnosticAgentPlan(JSON.stringify(contextOnly)))
      .toThrow(/lacks prior executable evidence/);

    const readAfterWrite = planValue();
    readAfterWrite.steps.reverse();
    expect(() => parseDiagnosticAgentPlan(JSON.stringify(readAfterWrite)))
      .toThrow(/read-only evidence steps must precede/);

    const noRollback = planValue() as unknown as { steps: Array<Record<string, unknown>> };
    delete noRollback.steps[1].rollback;
    expect(() => parseDiagnosticAgentPlan(JSON.stringify(noRollback))).toThrow(/rollback/);
  });

  it('fails closed on risk understatement, unknown evidence, and unsupported fields', () => {
    const understated = planValue();
    understated.steps[0].command = 'systemctl restart nginx';
    expect(() => parseDiagnosticAgentPlan(JSON.stringify(understated)))
      .toThrow(/unsafe read-only command/);

    const missing = planValue();
    missing.steps[1].evidenceIds = ['made-up'];
    expect(() => parseDiagnosticAgentPlan(JSON.stringify(missing))).toThrow(/unknown evidence/);

    expect(() => parseDiagnosticAgentPlan(JSON.stringify({
      ...planValue(),
      unrestrictedShell: true,
    }))).toThrow(/unknown field/);
  });

  it.each([
    'sudo df -h',
    'df -h && rm -rf /tmp/cache',
    'systemctl restart nginx',
    'journalctl --vacuum-size=1M',
    'date -s 12:00:00',
    'hostname compromised-host',
    'ss -K dst 203.0.113.10',
    'cat /etc/hosts > /tmp/hosts',
    'tail -f /var/log/system.log',
    'docker logs app',
    'docker stats',
    'kubectl get pods --watch',
    'cat /dev/zero',
  ])('rejects unsafe read-only commands: %s', (command) => {
    expect(isSafeReadOnlyAgentCommand(command)).toBe(false);
  });

  it.each([
    'df -h',
    'date -u +%FT%T',
    'hostname -f',
    'ss -lntp',
    'journalctl -u nginx -n 50',
    'systemctl status nginx',
    'docker logs --tail 200 app',
    'docker stats --no-stream',
    'kubectl logs app --tail=200',
  ])('allows bounded read-only commands: %s', (command) => {
    expect(isSafeReadOnlyAgentCommand(command)).toBe(true);
  });

  it('rejects plans with more than eight steps', () => {
    const value = planValue();
    value.steps = Array.from({ length: 9 }, (_, index) => ({
      ...value.steps[0],
      id: `check-${index}`,
    }));
    expect(() => parseDiagnosticAgentPlan(JSON.stringify(value))).toThrow(/1-8 steps/);
  });

});
