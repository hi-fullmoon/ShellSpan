import { act, cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AiConversationNodeList, aiAskConversationNodeRenderers } from '../workspace/ai-conversation-node-seat';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { sessionEvent } from '@/test/fixtures/agent-session';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';

afterEach(() => cleanup());

describe('terminal reasoning display', () => {
  it.each(['agent', 'ask'] as const)('keeps completed %s Markdown chunks mounted as reasoning grows', async (mode) => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
    const user = userEvent.setup();
    const content = readFileSync('AGENTS.md', 'utf8');
    const node: AiConversationNodeOf<'reasoning'> = {
      kind: 'reasoning', key: 'reasoning:chunks', sourceKind: 'agent',
      sessionId: 'reasoning-chunks', turnId: 'turn-1', stepId: 'step-1',
      firstSeq: 1, lastSeq: 2, timestamp: '2026-09-21T00:00:00.000Z',
      requestId: 'request-1', summary: '', content, state: 'streaming',
    };
    const renderers = mode === 'ask' ? aiAskConversationNodeRenderers : undefined;
    const view = render(<AiConversationNodeList nodes={[node]} renderers={renderers} />);
    const trigger = screen.getByRole('button');
    if (trigger.getAttribute('aria-expanded') === 'false') await user.click(trigger);
    await act(async () => {});
    const chunks = view.container.querySelectorAll('.ai-reasoning-body > .ai-assistant-markdown');
    expect(chunks.length).toBeGreaterThan(1);
    const firstParagraph = chunks[0].querySelector('p');
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(chunks[0], { subtree: true, childList: true, characterData: true });
    const appended = `${content}\n\n${readFileSync('CONTRIBUTING.md', 'utf8')}`;
    await act(async () => {
      view.rerender(<AiConversationNodeList nodes={[{ ...node, content: appended, lastSeq: 3 }]} renderers={renderers} />);
    });
    expect(view.container.querySelector('.ai-reasoning-body p')).toBe(firstParagraph);
    expect(mutations).toHaveLength(0);
    expect(view.container.querySelector('.ai-reasoning-body [data-reveal]')).not.toBeNull();
    expect(view.container.querySelector('.ai-reasoning-body')).toHaveTextContent('许可证');
    observer.disconnect();
  });

  it.each(['agent', 'ask'] as const)('renders %s reasoning with Markdown soft breaks and preserves structured content', async (mode) => {
    await initI18n('en-US');
    const user = userEvent.setup();
    const content = 'We\n need\n continue\n,\n gather\n macOS\n compatible\n ps\n.\n\nNext paragraph.\n\n- Inspect CPU\n- Inspect memory\n\n```sh\nvm_stat\nsysctl hw.memsize\n```\n\nFirst line  \nSecond line';
    const node: AiConversationNodeOf<'reasoning'> = {
      kind: 'reasoning', key: 'reasoning:markdown', sourceKind: 'agent',
      sessionId: 'session-markdown', turnId: 'turn-1', stepId: 'step-1',
      firstSeq: 1, lastSeq: 2, timestamp: '2026-09-21T00:00:00.000Z',
      requestId: 'request-1', summary: 'We', content: 'We\n need', state: 'streaming',
    };
    const renderers = mode === 'ask' ? aiAskConversationNodeRenderers : undefined;
    const view = render(<AiConversationNodeList nodes={[node]} renderers={renderers} />);
    const trigger = screen.getByRole('button');
    if (trigger.getAttribute('aria-expanded') === 'false') await user.click(trigger);
    expect(view.container.querySelector('.ai-reasoning-body p')).toHaveTextContent('We need');
    view.rerender(<AiConversationNodeList nodes={[{ ...node, content, lastSeq: 3 }]} renderers={renderers} />);
    const body = view.container.querySelector('.ai-reasoning-body')!;
    expect(body).toHaveClass('whitespace-normal', 'min-w-0');
    expect(body.querySelector('p')).toHaveTextContent('We need continue , gather macOS compatible ps .');
    expect(body.querySelector('p')!.querySelector('br')).toBeNull();
    expect(body.querySelectorAll('ul > li')).toHaveLength(2);
    expect(body.querySelector('pre code')!.textContent).toBe('vm_stat\nsysctl hw.memsize\n');
    expect(body.querySelector('pre')).toHaveClass('whitespace-pre-wrap');
    expect(body.querySelectorAll('br')).toHaveLength(1);
    expect(body.querySelectorAll('p')).toHaveLength(3);
    view.rerender(<AiConversationNodeList nodes={[{ ...node, content, lastSeq: 4, state: 'completed' }]} renderers={renderers} />);
    if (trigger.getAttribute('aria-expanded') === 'false') await user.click(trigger);
    expect(view.container.querySelector('.ai-reasoning-body pre code')!.textContent).toBe('vm_stat\nsysctl hw.memsize\n');
    expect(node.content).toBe('We\n need');
  });

  it.each([
    ['zh-CN', '思考中…', '思考已中断', '处理失败'],
    ['en-US', 'Thinking…', 'Thinking interrupted', 'Process failed'],
  ] as const)('stops thinking after runtime failure in %s and when replaying history', async (
    locale, thinkingLabel, interruptedLabel, processLabel,
  ) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const user = userEvent.setup();
    const events = agentSessionBaselineScenarios['streaming-reasoning'].events
      .map((event) => ({ ...event, sessionId: `terminal-reasoning-${locale}` }));
    const view = render(<AiConversationNodeList nodes={projectAgentChatNodes(events)} />);
    expect(screen.getByText(thinkingLabel)).toHaveClass('shimmer');
    expect(view.container.querySelector('.ai-reasoning-row')).toHaveAttribute('role', 'status');

    const reason = 'runtimeFailure: assistant text block is invalid or exceeds 131072 bytes';
    const failedEvents = [
      ...events,
      { ...sessionEvent(events.length, {
        turnId: 'turn-01', stepId: 'step-01', type: 'step/end', data: { reason },
      }), sessionId: events[0].sessionId },
      { ...sessionEvent(events.length + 1, {
        turnId: 'turn-01', type: 'turn/end', data: { reason },
      }), sessionId: events[0].sessionId },
      { ...sessionEvent(events.length + 2, {
        type: 'session/ended', data: { status: 'failed', reason },
      }), sessionId: events[0].sessionId },
    ];
    const nodes = projectAgentChatNodes(failedEvents);
    view.rerender(<AiConversationNodeList nodes={nodes} />);
    const liveProcess = screen.getByRole('button', { name: processLabel });
    if (liveProcess.getAttribute('aria-expanded') === 'false') await user.click(liveProcess);

    async function expectStopped(container: HTMLElement) {
      expect(screen.queryByText(thinkingLabel)).not.toBeInTheDocument();
      expect(screen.getByText(interruptedLabel)).not.toHaveClass('shimmer');
      const row = container.querySelector('.ai-reasoning-row')!;
      expect(row).toHaveAttribute('data-state', 'interrupted');
      expect(row).not.toHaveAttribute('role', 'status');
      await user.click(screen.getByRole('button', { name: new RegExp(`^${interruptedLabel} `) }));
      expect(row.querySelector('.ai-reasoning-body')).toHaveTextContent(
        'Read the frozen context. Prepare a concise answer.',
      );
      expect(row.querySelector('.ai-reasoning-body [data-reveal]')).toBeNull();
      const details = within(screen.getByRole('alert')).getByRole('button');
      if (details.getAttribute('aria-expanded') !== 'true') await user.click(details);
      expect(screen.getByText(reason)).toBeVisible();
    }

    await expectStopped(view.container);
    view.unmount();
    const replay = render(<AiConversationNodeList nodes={projectAgentChatNodes(failedEvents)} />);
    const process = screen.getByRole('button', { name: processLabel });
    if (process.getAttribute('aria-expanded') === 'false') await user.click(process);
    await expectStopped(replay.container);
  });
});
