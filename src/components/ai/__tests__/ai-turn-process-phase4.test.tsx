import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

  it('renders every traceable Turn stat and hides every unavailable token group', () => {
    const complete = projectAgentChatNodes(agentSessionBaselineScenarios.hello.events);
    const { rerender } = render(<AiConversationNodeList nodes={complete} />);
    const stats = screen.getByLabelText('Turn statistics');

    expect(within(stats).getByText('1 turns')).toBeVisible();
    expect(within(stats).getByText('1 steps')).toBeVisible();
    expect(stats.querySelector('[data-stat="model"]')).toHaveTextContent('LLM 0.5s');
    expect(stats.querySelector('[data-stat="ttft"]')).toHaveTextContent('First token avg 0.2s');
    expect(stats.querySelector('[data-stat="rate"]')).toHaveTextContent('80 tok/s');
    expect(stats.querySelector('[data-stat="cacheRead"]')).toHaveTextContent('Cache read 64');
    expect(stats.querySelector('[data-stat="cacheWrite"]')).toHaveTextContent('Cache write 8');
    expect(stats.querySelector('[data-stat="cacheHit"]')).toHaveTextContent('Cache hit 50%');
    expect(stats.querySelector('[data-stat="inputTokens"]')).toHaveTextContent('Input 128');
    expect(stats.querySelector('[data-stat="outputTokens"]')).toHaveTextContent('Output 24');
    expect(stats.querySelector('[data-stat="reasoningTokens"]')).toHaveTextContent('Reasoning 10');

    rerender(<AiConversationNodeList nodes={projectAgentChatNodes(
      agentSessionBaselineScenarios['missing-usage'].events,
    )} />);
    const missing = screen.getByLabelText('Turn statistics');
    for (const key of [
      'rate', 'cacheRead', 'cacheWrite', 'cacheHit', 'inputTokens', 'outputTokens', 'reasoningTokens',
    ]) {
      expect(missing.querySelector(`[data-stat="${key}"]`)).not.toBeInTheDocument();
    }
  });
});
