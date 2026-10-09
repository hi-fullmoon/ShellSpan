import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiNativeRecoveryNotice } from '../workspace/ai-native-recovery-notice';
import { initI18n } from '@/locales';
import type { AgentSessionEvent } from '@/types/agent-session';

const fixture = process.env.SHELLSPAN_STAGE2_RECOVERY_FIXTURE;
describe.skipIf(!fixture)('actual workbench crash and trusted resource recovery recording', () => {
  let events: AgentSessionEvent[];
  const recorded = (name: string) => readFileSync(join(resolve(fixture!), name), 'utf8');
  beforeEach(async () => {
    const directory = join(resolve(fixture!), 'fixture/agent-runtime/sessions-v5');
    events = readdirSync(directory).filter(name => name.endsWith('.jsonl')).flatMap(name => (
      readFileSync(join(directory, name), 'utf8').trim().split('\n').map(line => JSON.parse(line) as AgentSessionEvent)
    ));
    await initI18n('zh-CN');
  });
  afterEach(cleanup);
  it('renders a gate with no actionable continuation until resource receipts are checked', () => {
    const dispatched = events.find(event => event.type === 'tool/execution');
    expect(dispatched).toBeDefined();
    render(<AiNativeRecoveryNotice sessionId={dispatched!.sessionId} />);
    expect(screen.getByRole('alert')).toHaveTextContent('旧授权不会恢复，命令不会自动重放');
    expect(screen.getByRole('button', { name: '核对资源清理回执' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '结束中断回合并新建会话' })).toBeDisabled();
  });
  it('records unconfirmed blocking and trusted cleanup as distinct actual UI states', () => {
    expect(recorded('resources-unconfirmed.ax.txt')).toContain('仍有 1 项资源无法确认');
    expect(recorded('resources-unconfirmed.ax.txt')).toContain('button (disabled) 结束中断回合并新建会话');
    expect(recorded('resources-confirmed.ax.txt')).toContain('本次解除 1 项');
    expect(recorded('resources-confirmed.ax.txt')).not.toContain('button (disabled) 结束中断回合并新建会话');
  });
  it('requires a different actual approval after cleanup and retains the interrupted effect', () => {
    const approvals = events.filter(event => event.type === 'tool/approval' && event.data.status === 'approved');
    expect(new Set(approvals.map(event => event.sessionId)).size).toBe(2);
    expect(recorded('fresh-awaiting-approval.ax.txt')).toContain('printf fresh > recovery-fresh');
    const project = join(resolve(fixture!), 'fixture/owned-project');
    expect(readFileSync(join(project, 'recovery-started'), 'utf8')).toBe('started');
    expect(readFileSync(join(project, 'recovery-fresh'), 'utf8')).toBe('fresh');
    expect(readdirSync(project)).not.toContain('recovery-ended');
  });
});
