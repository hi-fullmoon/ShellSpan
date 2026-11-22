import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiConversationNode, AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { conversationRows, groupTurnProcessChildren } from '../ai-conversation-rows';
import { AiConversation } from '../ai-conversation';

function toolNode(
  id: string,
  name: string,
  overrides: Partial<AiConversationNodeOf<'tool'>> = {},
): AiConversationNodeOf<'tool'> {
  return {
    kind: 'tool',
    key: `tool:${id}`,
    sourceKind: 'agent',
    sessionId: 'sess-group',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 1,
    lastSeq: 2,
    timestamp: '2026-11-22T12:00:00.000Z',
    callId: id,
    name,
    nativeName: name,
    title: null,
    summary: '',
    state: 'succeeded',
    effect: 'readOnly',
    durationMs: 120,
    detailRef: { kind: 'agentTool', sessionId: 'sess-group', callId: id },
    evidenceRefs: [],
    input: name === 'search_text' ? { query: `pattern-${id}` } : { path: `/etc/nginx/${id}.conf` },
    output: { content: `output-${id}` },
    error: null,
    target: null,
    idempotency: 'yes',
    approval: null,
    ...overrides,
  };
}

function turnProcessNode(
  children: readonly AiConversationNodeOf<'tool'>[],
  overrides: Partial<AiConversationNodeOf<'turnProcess'>> = {},
): AiConversationNodeOf<'turnProcess'> {
  return {
    kind: 'turnProcess',
    key: 'process:turn-1',
    sourceKind: 'agent',
    sessionId: 'sess-group',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 1,
    lastSeq: 10,
    timestamp: '2026-11-22T12:00:00.000Z',
    status: 'running',
    answerGeneration: 'req-1',
    hasStartBoundary: true,
    hasEndBoundary: false,
    childKeys: children.map((child) => child.key),
    children,
    ...overrides,
  };
}

describe('consecutive read-only tool grouping', () => {
  beforeEach(async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  afterEach(cleanup);

  it('groups >=2 consecutive succeeded read/search tools and keeps non-groupable tools separate', () => {
    const read1 = toolNode('r1', 'read_file');
    const search1 = toolNode('s1', 'search_text');
    const edit1 = toolNode('e1', 'apply_patch', { effect: 'stateChange', input: { path: 'app.ts' } });
    const singleRead = toolNode('r2', 'read_file');
    const failedRead = toolNode('r3', 'read_file', { state: 'failed', error: 'ENOENT' });
    const runningRead = toolNode('r4', 'read_file', { state: 'running' });
    const read5 = toolNode('r5', 'read_file');
    const read6 = toolNode('r6', 'list_directory', { input: { path: '/etc/nginx/conf.d' } });

    const process = turnProcessNode([read1, search1, edit1, singleRead, failedRead, runningRead, read5, read6]);
    const entries = groupTurnProcessChildren(process.children);

    expect(entries).toHaveLength(6);
    expect(entries[0].node.key).toBe('tool:r1');
    expect(entries[0].groupedTools?.map((tool) => tool.key)).toEqual(['tool:r1', 'tool:s1']);
    expect(entries[1].node.key).toBe('tool:e1');
    expect(entries[1].groupedTools).toBeUndefined();
    expect(entries[2].node.key).toBe('tool:r2');
    expect(entries[2].groupedTools).toBeUndefined();
    expect(entries[3].node.key).toBe('tool:r3');
    expect(entries[3].groupedTools).toBeUndefined();
    expect(entries[4].node.key).toBe('tool:r4');
    expect(entries[4].groupedTools).toBeUndefined();
    expect(entries[5].node.key).toBe('tool:r5');
    expect(entries[5].groupedTools?.map((tool) => tool.key)).toEqual(['tool:r5', 'tool:r6']);

    const rows = conversationRows([process]);
    expect(rows[0].processChildKeys).toEqual(['tool:r1', 'tool:e1', 'tool:r2', 'tool:r3', 'tool:r4', 'tool:r5']);
  });

  it('updates a group in place without remounting and expands to show individual tool rows', async () => {
    const read1 = toolNode('nginx', 'read_file', { durationMs: 80 });
    const read2 = toolNode('upstream', 'read_file', { durationMs: 120 });
    const search1 = toolNode('proxy', 'search_text', { durationMs: 50 });

    const initialNodes: AiConversationNode[] = [
      turnProcessNode([read1, read2], { sessionId: 'sess-group:inplace' }),
    ];
    const { container, rerender } = render(
      <AiConversation nodes={initialNodes} status="running" throughSeq={4} />,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[data-tool-group] button')!;
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('Read');
    expect(trigger).toHaveTextContent('2 files · nginx.conf, upstream.conf');

    const nextNodes: AiConversationNode[] = [
      turnProcessNode([read1, read2, search1], { sessionId: 'sess-group:inplace', lastSeq: 12 }),
    ];
    rerender(<AiConversation nodes={nextNodes} status="running" throughSeq={6} />);

    const updatedTrigger = container.querySelector<HTMLButtonElement>('[data-tool-group] button')!;
    expect(updatedTrigger).toBe(trigger);
    expect(updatedTrigger).toHaveTextContent('Explored');
    expect(updatedTrigger).toHaveTextContent('2 reads, 1 search');

    fireEvent.click(updatedTrigger);
    expect(updatedTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('/etc/nginx/nginx.conf')).toBeVisible();
    expect(screen.getByText('/etc/nginx/upstream.conf')).toBeVisible();
    expect(screen.getByText('pattern-proxy')).toBeVisible();
  });

  it('renders localized zh-CN copy for read-only, search-only, and mixed tool groups', async () => {
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');

    const s1 = toolNode('s1', 'search_text', { input: { query: 'worker_processes' } });
    const s2 = toolNode('s2', 'search_text', { input: { query: 'proxy_pass' } });
    const { container } = render(
      <AiConversation
        nodes={[turnProcessNode([s1, s2], { sessionId: 'sess-group:zh' })]}
        status="running"
        throughSeq={4}
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[data-tool-group] button')!;
    expect(trigger).toHaveTextContent('已搜索');
    expect(trigger).toHaveTextContent('2 次 · worker_processes, proxy_pass');
  });
});
