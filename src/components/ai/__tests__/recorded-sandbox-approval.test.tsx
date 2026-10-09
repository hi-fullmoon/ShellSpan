import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingApproval } from '@/lib/ai/agent-session-adapter';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AgentSessionEvent } from '@/types/agent-session';
import { AiApprovalPanel } from '../workspace/ai-approval-panel';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const fixture = process.env.SHELLSPAN_STAGE2_APPROVAL_FIXTURE;
// This regression needs an actual Wry/model/audit-failure recording. No fallback
// events, fabricated snapshot or mocked IPC are substituted when it is absent.
describe.skipIf(!fixture)('recorded Wry sandbox approval failure', () => {
  let events: AgentSessionEvent[];
  beforeEach(async () => {
    const root = resolve(fixture!);
    const directory = join(root, 'fixture/agent-runtime/sessions-v5');
    const journals = readdirSync(directory).filter(name => name.endsWith('.jsonl'));
    if (journals.length !== 1) throw new Error('An exact single-session recorded fixture is required');
    events = readFileSync(join(directory, journals[0]!), 'utf8').trim().split('\n').map(line => JSON.parse(line) as AgentSessionEvent);
    useAppStore.setState({locale:'zh-CN'});
    await initI18n('zh-CN');
  });
  afterEach(cleanup);
  const requestedPrefix = () => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'tool/approval' && event.data.status === 'requested') return events.slice(0, index + 1);
    }
    throw new Error('Actual recorded requested approval missing');
  };
  it('removes actionable approval after the actual cancelled turn while retaining its history', () => {
    expect(pendingApproval(projectAgentChatNodes(requestedPrefix()))).not.toBeNull();
    expect(events.some(event => event.type === 'turn/end')).toBe(true);
    const nodes = projectAgentChatNodes(events);
    expect(pendingApproval(nodes)).toBeNull();
    expect(nodes.some(node => node.kind === 'turnProcess' && node.hasEndBoundary)).toBe(true);
  });
  it('announces the actual permission failure once without a second hidden error message', () => {
    const approval = pendingApproval(projectAgentChatNodes(requestedPrefix()));
    if (!approval) throw new Error('Actual pending command required');
    const ax = readFileSync(join(resolve(fixture!), 'audit-failure.ax.txt'), 'utf8');
    const error = ax.match(/text (failed to open Agent session log: Permission denied \(os error 13\))/)?.[1];
    if (!error) throw new Error('Actual recorded OS write failure required');
    render(<AiApprovalPanel approval={approval} decision={null} error={error}
      onApprove={() => {}} onReject={() => {}} onOpenDetails={() => {}} />);
    expect(screen.getAllByText(error, {exact:true})).toHaveLength(1);
  });
});
