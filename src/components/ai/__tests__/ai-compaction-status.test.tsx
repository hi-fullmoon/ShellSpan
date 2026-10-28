import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AiConversation } from '../workspace/ai-conversation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/compaction-progress.json';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';

const traces = capture as unknown as Record<'completed' | 'failed' | 'cancelled', readonly AgentSessionEvent[]>;
const nodes = (events: readonly AgentSessionEvent[]) => projectAgentChatNodes(events).filter(node => node.kind !== 'systemPrompt' && node.kind !== 'userMessage');
afterEach(cleanup);

it.each(['zh-CN', 'en-US'] as const)('shows preparation progress before turn admission in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const events = traces.completed;
  const start = events.findIndex(event => event.type === 'compaction/start');
  const progress = events.slice(start, start + 1);
  expect(progress.some(event => event.type === 'turn/start' || event.type === 'agent/status')).toBe(false);
  const { container, rerender } = render(<AiConversation nodes={nodes(progress)} status={projectAgentActivity(progress).status} throughSeq={null} />);
  expect(container.querySelector('[data-ai-compaction-status]')).toHaveAttribute('aria-busy', 'true');
  expect(container).toHaveTextContent(locale === 'zh-CN' ? '正在压缩上下文' : 'Compacting context');
  const settled = events.slice(start);
  rerender(<AiConversation nodes={nodes(settled)} status={projectAgentActivity(settled).status} throughSeq={null} />);
  expect(container.querySelector('[data-ai-compaction-status]')).toHaveAttribute('data-ai-compaction-status', 'completed');
  expect(container.querySelector('[data-ai-compaction-status] [data-slot="spinner"]')).toBeNull();
});

it.each(['zh-CN', 'en-US'] as const)('shows live progress then recorded outcomes in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  for (const state of ['completed', 'failed', 'cancelled'] as const) {
    const events = traces[state];
    const start = events.findIndex(event => event.type === 'compaction/start');
    const active = events.slice(0, start + 1);
    const { container, rerender, unmount } = render(<AiConversation nodes={nodes(active)} status={projectAgentActivity(active).status} throughSeq={null} />);
    const row = container.querySelector('[data-ai-compaction-status]');
    expect(row).toHaveAttribute('aria-busy', 'true');
    expect(row).toHaveAttribute('role', 'status');
    expect(row).toHaveTextContent(locale === 'zh-CN' ? '正在压缩上下文' : 'Compacting context');
    expect(row?.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
    rerender(<AiConversation nodes={nodes(events)} status="idle" throughSeq={null} />);
    expect(row).toHaveAttribute('data-ai-compaction-status', state);
    expect(row).toHaveAttribute('aria-busy', 'false');
    expect(row?.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(row?.querySelector('[data-ai-compaction-duration]')).toHaveTextContent(locale === 'zh-CN' ? '用时' : 'Took');
    expect(container).not.toHaveTextContent(locale === 'zh-CN' ? '正在压缩上下文' : 'Compacting context');
    unmount();
  }
});

it('updates actual elapsed time and ends stale progress when execution stops', async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  const events = traces.completed;
  const start = events.findIndex(event => event.type === 'compaction/start');
  const active = nodes(events.slice(0, start + 1));
  const { container, rerender } = render(<AiConversation nodes={active} status="running" throughSeq={null} />);
  const duration = container.querySelector('[data-ai-compaction-duration]');
  const initial = duration?.textContent;
  await waitFor(() => expect(duration?.textContent).not.toBe(initial), { timeout: 2500 });
  for (const status of ['idle', 'failed', 'cancelled'] as const) {
    rerender(<AiConversation nodes={active} status={status} throughSeq={null} />);
    expect(container.querySelector('[data-ai-compaction-status="running"]')).toBeNull();
    expect(container.querySelector('[data-ai-compaction-status] [data-slot="spinner"]')).toBeNull();
    expect(container.querySelector('[data-ai-compaction-duration]')).toBeNull();
  }
});
