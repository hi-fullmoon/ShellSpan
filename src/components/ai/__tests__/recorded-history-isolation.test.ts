import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@/types/agent-session';

const fixture = process.env.SHELLSPAN_STAGE2_HISTORY_FIXTURE;
describe.skipIf(!fixture)('real Wry history isolation before approval expiry', () => {
  const root = resolve(fixture ?? '.');
  const read = (name: string) => readFileSync(join(root, name), 'utf8');
  const events = (): AgentSessionEvent[] => {
    const folder = join(root, 'fixture/agent-runtime/sessions-v5');
    const files = readdirSync(folder).filter(name => name.startsWith('target-a-') && name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    return readFileSync(join(folder, files[0]), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as AgentSessionEvent);
  };

  it('shows history without approval controls on B while the original approval remains valid on A', () => {
    const rows = events();
    const requested = rows.find(row => row.type === 'tool/approval' && row.data.status === 'requested');
    if (requested?.type !== 'tool/approval' || !requested.data.expiresAtUnixMs) throw new Error('Real pending approval required');
    for (const name of ['b-history-before-expiry', 'b-history-expanded', 'a-return-before-expiry']) {
      const time = JSON.parse(read(`${name}-time.json`)) as { observedAtUnixMs: number };
      expect(time.observedAtUnixMs).toBeGreaterThan(requested.timeUnixMs);
      expect(time.observedAtUnixMs).toBeLessThan(requested.data.expiresAtUnixMs);
    }
    const history = read('b-history-before-expiry.ax.txt');
    expect(history).toContain('Own secondary Mac SSH target, Value: on');
    expect(history).toContain('旧命令不会自动重试');
    expect(history).not.toContain('允许执行一次');
    const expanded = read('b-history-expanded.ax.txt');
    expect(expanded).toContain('等待批准');
    expect(expanded).not.toContain('允许执行一次');
    const returned = read('a-return-before-expiry.ax.txt');
    expect(returned).toContain('Own ordinary-account Mac SSH fixture, Value: on');
    expect(returned).toContain('允许执行一次');
  });

  it('records rejection without approval or dispatch and no live authorization', () => {
    const rows = events();
    expect(rows.filter(row => row.type === 'request/start')).toHaveLength(2);
    expect(rows.filter(row => row.type === 'tool/approval' && row.data.status === 'requested')).toHaveLength(1);
    expect(rows.some(row => row.type === 'tool/approval' && row.data.status === 'rejected')).toBe(true);
    expect(rows.some(row => row.type === 'tool/approval' && row.data.status === 'approved')).toBe(false);
    expect(rows.some(row => row.type === 'tool/execution')).toBe(false);
    expect(read('resources.ax.txt')).toContain('"state":"none"');
    expect(read('resources.ax.txt')).toContain('"activeProcesses":0');
    const launch = JSON.parse(read('launch-final.json')) as { exitCode: number; sourceUnchanged: boolean; binaryUnchanged: boolean };
    expect(launch.exitCode).toBe(0);
    expect(launch.sourceUnchanged).toBe(true);
    expect(launch.binaryUnchanged).toBe(true);
  });
});
