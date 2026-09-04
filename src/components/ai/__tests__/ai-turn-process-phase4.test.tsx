import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiConversationNodeList } from '@/components/ai/workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import v4Fixture from '@/test/fixtures/agent-session-v4.json';
import type { AgentSessionEvent } from '@/types/agent-session';
import '@/components/ai/ai-panel.css';

function reasoningNode(
  changes: Partial<AiConversationNodeOf<'reasoning'>> = {},
): AiConversationNodeOf<'reasoning'> {
  return {
    kind: 'reasoning',
    key: 'reasoning:phase4',
    sourceKind: 'agent',
    sessionId: 'phase4-session',
    turnId: 'phase4-turn',
    stepId: 'phase4-step',
    firstSeq: 2,
    lastSeq: 3,
    timestamp: '2026-09-03T00:00:00.200Z',
    requestId: 'phase4-request',
    summary: 'Inspect durable facts',
    content: 'Inspect durable facts before answering.',
    state: 'completed',
    ...changes,
  };
}

function contextNode(): AiConversationNodeOf<'contextInjection'> {
  return {
    kind: 'contextInjection',
    key: 'context:phase4',
    sourceKind: 'agent',
    sessionId: 'phase4-session-focus',
    turnId: 'phase4-turn-focus',
    stepId: 'phase4-step-focus',
    firstSeq: 2,
    lastSeq: 2,
    timestamp: '2026-09-03T00:00:00.200Z',
    messageId: 'context-phase4',
    content: 'Runtime context from the committed event.',
    provenance: { kind: 'runtime', label: 'ShellSpan Runtime', producerId: 'runtime' },
  };
}

function processNode(
  changes: Partial<AiConversationNodeOf<'turnProcess'>> = {},
): AiConversationNodeOf<'turnProcess'> {
  const children = changes.children ?? [reasoningNode()];
  return {
    kind: 'turnProcess',
    key: 'turn-process:phase4-turn',
    sourceKind: 'agent',
    sessionId: 'phase4-session',
    turnId: 'phase4-turn',
    stepId: null,
    firstSeq: 1,
    lastSeq: 4,
    timestamp: '2026-09-03T00:00:00.100Z',
    status: 'completed',
    answerGeneration: 'phase4-generation-1',
    hasStartBoundary: true,
    hasEndBoundary: true,
    childKeys: children.map((child) => child.key),
    children,
    ...changes,
  };
}

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(() => cleanup());

describe('AI Phase 4 Turn Process renderer', () => {
  it('renders the completed hierarchy as prompt, user, collapsed process, answer, and tail', async () => {
    const user = userEvent.setup();
    const nodes = projectAgentChatNodes(agentSessionBaselineScenarios.hello.events);
    const { container } = render(<AiConversationNodeList nodes={nodes} />);
    const kinds = [...container.querySelectorAll<HTMLElement>('[data-ai-node-kind]')]
      .map((element) => element.dataset.aiNodeKind);

    expect(kinds).toEqual([
      'systemPrompt', 'userMessage', 'turnProcess', 'assistantMessage', 'turnTail',
    ]);
    expect(screen.getByRole('button', { name: 'System prompt' })).toHaveAttribute('aria-expanded', 'false');
    const process = screen.getByRole('button', { name: 'Thought' });
    expect(process).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Hello! How can I help?')).toBeVisible();

    await user.click(process);
    expect(process).toHaveAttribute('aria-expanded', 'true');
    const reasoning = screen.getByRole('button', {
      name: 'Reasoning Read the frozen context. Answer directly.',
    });
    expect(reasoning).toHaveAttribute('aria-expanded', 'false');
    await user.click(reasoning);
    expect((await screen.findAllByText('Read the frozen context. Answer directly.'))
      .some((element) => element.classList.contains('ai-reasoning-body'))).toBe(true);
    expect(screen.getByText('Hello! How can I help?')).toBeVisible();
  });

  it('does not render an empty Process for a direct answer', () => {
    const nodes = projectAgentChatNodes(agentSessionBaselineScenarios['direct-answer'].events);
    const { container } = render(<AiConversationNodeList nodes={nodes} />);

    expect(container.querySelector('[data-ai-node-kind="turnProcess"]')).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Thought' })).not.toBeInTheDocument();
    expect(screen.getByText('Hello! How can I help?')).toBeVisible();
    expect(container.querySelector('[data-ai-node-kind="turnTail"]')).toBeInTheDocument();
  });

  it.each(['running', 'completed', 'failed', 'cancelled'] as const)(
    'omits process-message actions during a %s turn while preserving the final answer copy',
    async (status) => {
      const user = userEvent.setup();
      const commentary = "I'll check interfaces, routes, DNS, and outbound connectivity.";
      const events = agentSessionBaselineScenarios['single-tool'].events.map((event) => (
        event.type === 'assistant/message' && event.data.messageId === 'message-assistant-tools'
          ? { ...event, data: { ...event.data, content: [
            { type: 'text' as const, text: commentary }, ...event.data.content,
          ] } }
          : event
      ));
      const nodes = projectAgentChatNodes(events).map((node) => (
        node.kind === 'turnProcess'
          ? { ...node, sessionId: `process-actions-${status}`, status, hasEndBoundary: status !== 'running' }
          : node
      ));
      const { container } = render(<AiConversationNodeList nodes={nodes} />);
      const processTrigger = container.querySelector<HTMLButtonElement>('.ai-turn-process-trigger')!;
      if (processTrigger.getAttribute('aria-expanded') === 'false') await user.click(processTrigger);

      const processMessage = screen.getByText(commentary).closest<HTMLElement>('[role="article"]')!;
      expect(processMessage).toBeVisible();
      expect(within(processMessage).queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
      expect(processMessage.querySelector('time')).not.toBeInTheDocument();
      expect(processMessage.querySelector('.ai-message-actions')).not.toBeInTheDocument();
      expect(within(screen.getByRole('article', { name: 'Your message' }))
        .getByRole('button', { name: 'Copy' })).toBeInTheDocument();

      await user.click(within(screen.getByLabelText('Turn statistics')).getByRole('button', { name: 'Copy' }));
      expect(await navigator.clipboard.readText()).toBe('nginx is active.');
    },
  );

  it('keeps streaming process state and focus across committed chunk revisions', async () => {
    const user = userEvent.setup();
    const events = agentSessionBaselineScenarios['streaming-reasoning'].events;
    const { rerender } = render(<AiConversationNodeList nodes={projectAgentChatNodes(events)} />);
    const trigger = screen.getByRole('button', { name: 'Thinking' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', {
      name: 'Thinking… Read the frozen context. Prepare a concise answer.',
    })).toHaveAttribute('aria-expanded', 'false');

    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();

    const previous = events[events.length - 1];
    const nextEvent = {
      ...previous,
      seq: previous.seq + 1,
      timeUnixMs: previous.timeUnixMs + 100,
      type: 'assistant/chunk',
      data: { requestId: 'request-01', reasoningDelta: ' Keep the response short.' },
    } as AgentSessionEvent;
    rerender(<AiConversationNodeList nodes={projectAgentChatNodes([...events, nextEvent])} />);

    const updatedTrigger = screen.getByRole('button', { name: 'Thinking' });
    expect(updatedTrigger).toBe(trigger);
    expect(updatedTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(updatedTrigger).toHaveFocus();

    await user.keyboard(' ');
    expect(updatedTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(updatedTrigger).toHaveFocus();
  });

  it('folds terminal process content once and restores focus from a hidden child', async () => {
    const context = contextNode();
    const running = processNode({
      key: 'turn-process:phase4-focus',
      sessionId: 'phase4-session-focus',
      turnId: 'phase4-turn-focus',
      answerGeneration: 'phase4-generation-focus',
      status: 'running',
      hasEndBoundary: false,
      children: [context],
      childKeys: [context.key],
    });
    const { rerender } = render(<AiConversationNodeList nodes={[running]} />);
    const contextTrigger = screen.getByRole('button', { name: 'Runtime context' });
    contextTrigger.focus();
    expect(contextTrigger).toHaveFocus();

    rerender(<AiConversationNodeList nodes={[{
      ...running,
      status: 'completed',
      hasEndBoundary: true,
      lastSeq: running.lastSeq + 1,
    }]} />);

    await waitFor(() => {
      const process = screen.getByRole('button', { name: 'Thought' });
      expect(process).toHaveAttribute('aria-expanded', 'false');
      expect(process).toHaveFocus();
    });
  });

  it('scopes manual disclosure state to session, Turn, and answer generation', async () => {
    const user = userEvent.setup();
    const first = processNode({
      key: 'turn-process:phase4-generation',
      sessionId: 'phase4-session-generation',
      turnId: 'phase4-turn-generation',
      answerGeneration: 'generation-one',
    });
    const { rerender } = render(<AiConversationNodeList nodes={[first]} />);
    await user.click(screen.getByRole('button', { name: 'Thought' }));
    expect(screen.getByRole('button', { name: 'Thought' })).toHaveAttribute('aria-expanded', 'true');

    rerender(<AiConversationNodeList nodes={[{
      ...first,
      answerGeneration: 'generation-two',
      lastSeq: first.lastSeq + 1,
    }]} />);
    expect(screen.getByRole('button', { name: 'Thought' })).toHaveAttribute('aria-expanded', 'false');

    rerender(<AiConversationNodeList nodes={[{ ...first, lastSeq: first.lastSeq + 2 }]} />);
    expect(screen.getByRole('button', { name: 'Thought' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps partial history expanded and omits a misleading terminal tail', () => {
    const nodes = projectAgentChatNodes(v4Fixture as unknown as readonly AgentSessionEvent[]);
    const { container } = render(<AiConversationNodeList nodes={nodes} />);
    const process = screen.getByRole('button', { name: 'Process history' });

    expect(process).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Runtime context' })).toBeVisible();
    expect(container.querySelector('[data-ai-node-kind="turnTail"]')).not.toBeInTheDocument();
  });

  it.each([
    ['provider-error', 'Process failed', 'Fixture provider unavailable.', false],
    ['cancelled', 'Process cancelled', 'The report begins with', true],
  ] as const)('renders a deterministic %s terminal layout', async (scenario, label, answer, hasAnswer) => {
    const user = userEvent.setup();
    const nodes = projectAgentChatNodes(agentSessionBaselineScenarios[scenario].events);
    const { container } = render(<AiConversationNodeList nodes={nodes} />);
    const process = screen.getByRole('button', { name: label });

    expect(process).toHaveAttribute('aria-expanded', 'false');
    if (hasAnswer) expect(screen.getByText(answer)).toBeVisible();
    else expect(screen.queryByText(answer)).not.toBeInTheDocument();
    expect(container.querySelector('[data-ai-node-kind="turnTail"]')).toHaveAttribute(
      'data-ai-node-kind',
      'turnTail',
    );
    await user.click(process);
    if (!hasAnswer) expect(await screen.findByText(answer)).toBeVisible();
  });

  it.each([
    ['Usage 144 tok', 'Turn usage'],
    ['Time 1.1s', 'Turn timing and speed'],
  ])('opens %s details only on click, not hover', async (label, title) => {
    const user = userEvent.setup();
    const tail = projectAgentChatNodes(agentSessionBaselineScenarios.hello.events)
      .find((node): node is AiConversationNodeOf<'turnTail'> => node.kind === 'turnTail')!;
    render(<AiConversationNodeList nodes={[tail]} />);
    const trigger = screen.getByRole('button', { name: label });

    await user.hover(trigger);
    // Wait beyond the previous hover delay to catch deferred opening.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: title })).toBeVisible();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('formats the reference usage and duration and toggles details on click', async () => {
    const user = userEvent.setup();
    const tail = projectAgentChatNodes(agentSessionBaselineScenarios.hello.events)
      .find((node): node is AiConversationNodeOf<'turnTail'> => node.kind === 'turnTail')!;
    render(<AiConversationNodeList nodes={[{
      ...tail,
      durationMs: 139_000,
      models: [{ providerId: 'minimax-cn', model: 'MiniMax-M3' }],
      stats: {
        ...tail.stats,
        uncachedInputTokens: 7_007,
        cacheReadTokens: 556_713,
        cacheWriteTokens: 0,
        outputTokens: 3_033,
        reasoningTokens: 0,
        totalTokens: 566_753,
        averageTimeToFirstTokenMs: 8_600,
        tokensPerSecond: 32,
      },
    }]} />);
    expect(screen.getByRole('button', { name: 'Time 2m 19s' })).toBeVisible();
    const usageTrigger = screen.getByRole('button', { name: 'Usage 567K tok' });
    await user.click(usageTrigger);
    const usage = await screen.findByRole('dialog', { name: 'Turn usage' });
    expect(within(usage).getByText('566,753 tok')).toBeVisible();
    expect(usage.querySelector('[data-stat="cacheHit"]')).toHaveTextContent('98.8%');
    expect(usage.querySelector('[data-stat="cacheRead"]')).toHaveTextContent('556,713 tok');
    expect(usage.querySelector('[data-stat="cacheWrite"]')).not.toBeInTheDocument();
    await user.click(usageTrigger);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the footer compact and reveals only recorded metrics in accessible popovers', async () => {
    const user = userEvent.setup();
    const complete = projectAgentChatNodes(agentSessionBaselineScenarios.hello.events);
    const { rerender, container } = render(<AiConversationNodeList nodes={complete} />);
    const footer = screen.getByLabelText('Turn statistics');
    expect(within(footer).getAllByRole('button')).toHaveLength(3);
    expect(container.querySelector('.ai-assistant-actions')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(within(footer).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('Hello! How can I help?');
    await user.click(within(footer).getByRole('button', { name: 'Usage 144 tok' }));
    const usage = await screen.findByRole('dialog', { name: 'Turn usage' });
    expect(usage.querySelector('[data-stat="cacheRead"]')).toHaveTextContent('64 tok');
    expect(usage.querySelector('[data-stat="cacheWrite"]')).toHaveTextContent('8 tok');
    expect(usage.querySelector('[data-stat="cacheHit"]')).toHaveTextContent('50.0%');
    expect(usage.querySelector('[data-stat="uncachedInput"]')).toHaveTextContent('56 tok');
    expect(usage.querySelector('[data-stat="outputTokens"]')).toHaveTextContent('24 tok');
    expect(usage.querySelector('[data-stat="reasoningTokens"]')).toHaveTextContent('10 tok');
    expect(usage.querySelector('[data-stat="models"]')).toHaveTextContent('deepseek/deepseek-reasoner');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const timeTrigger = within(footer).getByRole('button', { name: 'Time 1.1s' });
    timeTrigger.focus();
    await user.keyboard('{Enter}');
    const timing = await screen.findByRole('dialog', { name: 'Turn timing and speed' });
    expect(timing.querySelector('[data-stat="duration"]')).toHaveTextContent('1.1s');
    expect(timing.querySelector('[data-stat="model"]')).toHaveTextContent('0.5s');
    expect(timing.querySelector('[data-stat="ttft"]')).toHaveTextContent('0.2s');
    expect(timing.querySelector('[data-stat="rate"]')).toHaveTextContent('80 tok/s');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    rerender(<AiConversationNodeList nodes={projectAgentChatNodes(
      agentSessionBaselineScenarios['missing-usage'].events,
    )} />);
    expect(screen.queryByRole('button', { name: /^Usage/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Time / }));
    const missing = await screen.findByRole('dialog', { name: 'Turn timing and speed' });
    expect(missing.querySelector('[data-stat="rate"]')).not.toBeInTheDocument();
  });
});
