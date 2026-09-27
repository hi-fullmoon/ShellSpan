import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiConversationNodeList, aiAskConversationNodeRenderers } from '../workspace/ai-conversation-node-seat';
import type { AiReasoningNode } from '@/lib/ai/conversation-node';
import { taskTokenBudgetEvidence } from '@/test/fixtures/task-token-budget';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

// Exercise disclosure states with repository text and recorded session identity,
// without replacing components or simulating a model/IPC response.
const snapshot = taskTokenBudgetEvidence.failed;
const source = readFileSync('AGENTS.md', 'utf8');
const node: AiReasoningNode = {
  kind: 'reasoning', key: snapshot.header.sessionId, sourceKind: 'agent',
  sessionId: snapshot.header.sessionId, turnId: null, stepId: null,
  firstSeq: 0, lastSeq: 0, timestamp: new Date(snapshot.header.createdAtUnixMs).toISOString(),
  requestId: null, summary: source.split('\n')[0], content: source, state: 'streaming',
};
const view = (state: AiReasoningNode['state']) => <AiConversationNodeList
  nodes={[{ ...node, state }]} renderers={aiAskConversationNodeRenderers} />;

beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

describe('Ask reasoning disclosure intent', () => {
  it('follows the stream by default and opens completed history collapsed', async () => {
    const { rerender, unmount } = render(view('streaming'));
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await act(async () => rerender(view('settled')));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await act(async () => rerender(view('streaming')));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    unmount();
    render(view('completed'));
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it.each(['settled', 'completed', 'interrupted'] as const)('preserves a manual expansion and focus when reasoning becomes %s', async (state) => {
    const user = userEvent.setup();
    const { rerender } = render(view('streaming'));
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await act(async () => rerender(view(state)));
    expect(screen.getByRole('button')).toBe(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveFocus();
  });

  it('keeps a manually collapsed section closed when reasoning resumes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(view('streaming'));
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    await act(async () => rerender(view('settled')));
    await act(async () => rerender(view('streaming')));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});
