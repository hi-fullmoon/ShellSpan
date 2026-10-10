import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@/types/agent-session';

const fixture = process.env.SHELLSPAN_STAGE2_ACCOUNT_FIXTURE;
describe.skipIf(!fixture)('real different SSH login identity recording', () => {
  const root = resolve(fixture ?? '.');
  const report = () => JSON.parse(readFileSync(join(root, 'account-evidence.json'), 'utf8')) as {
    sessions: Record<'a' | 'b' | 'activity', string>; checks: Record<string, boolean>;
    overallPassed: boolean; stage3Allowed: boolean;
  };
  const rows = (label: 'a' | 'b' | 'activity'): AgentSessionEvent[] =>
    readFileSync(join(root, 'journals', `${report().sessions[label]}.jsonl`), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as AgentSessionEvent);

  it('keeps the A request unapproved and requires a distinct B approval', () => {
    const a = rows('a');
    const b = rows('b');
    expect(a.some(row => row.type === 'tool/execution')).toBe(false);
    expect(a.some(row => row.type === 'tool/approval' && row.data.status === 'approved')).toBe(false);
    const aRequest = a.find(row => row.type === 'tool/approval' && row.data.status === 'requested');
    const bRequest = b.find(row => row.type === 'tool/approval' && row.data.status === 'requested');
    if (aRequest?.type !== 'tool/approval' || bRequest?.type !== 'tool/approval') throw new Error('Two actual approvals required');
    expect(aRequest.data.approvalId).not.toBe(bRequest.data.approvalId);
    expect(b.filter(row => row.type === 'tool/approval' && row.data.status === 'approved')).toHaveLength(1);
    expect(Object.values(report().checks).every(Boolean)).toBe(true);
  });

  it('preserves unconfirmed started-resource debt and does not certify the stage', () => {
    const result = rows('activity').find(row => row.type === 'tool/result');
    if (result?.type !== 'tool/result') throw new Error('Actual native result required');
    expect(result.data.status).toBe('uncertain');
    expect(result.data.data).toMatchObject({ stdout: 'shellspan-account-active-a',
      terminationConfirmed: false, failure: { admission: 'started' },
      executionTarget: { host: '175.178.66.45', username: 'root' } });
    expect(rows('b').filter(row => row.type === 'tool/approval' && row.data.status === 'requested')).toHaveLength(1);
    expect(report().overallPassed).toBe(false);
    expect(report().stage3Allowed).toBe(false);
  });
});
