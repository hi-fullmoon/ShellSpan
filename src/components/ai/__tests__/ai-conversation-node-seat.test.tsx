import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiConversationNodeList,
  aiConversationNodeRenderers,
  type AiConversationNodeRendererMap,
} from '@/components/ai/workspace/ai-conversation-node-seat';
import { classifyAiTool } from '@/components/ai/workspace/ai-tool-presentation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import {
  agentSessionEventFixture,
  agentSessionFailedEventFixture,
  agentSessionRunningEventFixture,
} from '@/test/fixtures/agent-session';
import '@/components/ai/ai-panel.css';

function toolNode(
  changes: Partial<AiConversationNodeOf<'tool'>> = {},
): AiConversationNodeOf<'tool'> {
  return {
    kind: 'tool',
    key: 'tool:fixture',
    sourceKind: 'agent',
    sessionId: 'session-fixture',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 1,
    lastSeq: 1,
    timestamp: '2026-09-03T00:00:00.000Z',
    callId: 'call-fixture',
    name: 'terminal.exec',
    summary: 'Run diagnostics',
    state: 'running',
    effect: 'readOnly',
    durationMs: null,
    detailRef: { kind: 'agentTool', sessionId: 'session-fixture', callId: 'call-fixture' },
    evidenceRefs: [],
    input: { command: 'printf ready', cwd: '/srv/app' },
    output: null,
    error: null,
    target: null,
    idempotency: null,
    approval: null,
    ...changes,
  };
}

function assistantText(node: AiConversationNodeOf<'assistantMessage'>): string {
  return node.blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

describe('AiConversationNodeList', () => {
  beforeEach(async () => {
    cleanup();
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  it('renders Agent projections through the keyed node seat', async () => {
    const agentNodes = projectAgentChatNodes(agentSessionEventFixture);
    render(<AiConversationNodeList nodes={agentNodes} />);

    expect(screen.getByText('Check nginx now.')).toBeVisible();
    expect(document.querySelector('[data-ai-node-key="turn-process:turn-1"]'))
      .toHaveAttribute('data-ai-node-kind', 'turnProcess');
    expect(document.querySelector('[data-ai-node-key="tool:turn-1:step-1:call-health"]')).not.toBeInTheDocument();
    const process = screen.getByRole('button', { name: 'Thought' });
    expect(process).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Command: active' })).not.toBeInTheDocument();
    });
    fireEvent.click(process);
    expect(await screen.findByRole('button', { name: 'Command: active' })).toBeVisible();
  });

  it('keeps lifecycle copy out of Conversation and terminal errors inside Turn Process', () => {
    const nodes = projectAgentChatNodes(agentSessionFailedEventFixture);
    const { container } = render(<AiConversationNodeList nodes={nodes} />);
    const process = nodes.find((node) => node.kind === 'turnProcess');

    expect(container.querySelector('[data-ai-node-kind="lifecycleMarker"]'))
      .not.toBeInTheDocument();
    expect(process?.kind === 'turnProcess' ? process.children : []).toEqual([
      expect.objectContaining({
        kind: 'error',
        message: 'Provider connection failed.',
      }),
    ]);
    expect(container.querySelectorAll('[data-ai-node-key]')).toHaveLength(nodes.length);
  });

  it('rerenders only the changed streaming node across 20 projection revisions', () => {
    const projected = projectAgentChatNodes(agentSessionRunningEventFixture);
    const user = projected.find((node) => node.kind === 'userMessage');
    const assistant = projected.find((node) => node.kind === 'assistantMessage');
    if (!user || user.kind !== 'userMessage' || !assistant || assistant.kind !== 'assistantMessage') {
      throw new Error('Agent fixture did not project the expected messages');
    }
    const renderUser = vi.fn(({ node }: { node: typeof user }) => <span>{node.content}</span>);
    const renderAssistant = vi.fn(({ node }: { node: typeof assistant }) => (
      <span>{assistantText(node)}</span>
    ));
    const renderers = {
      ...aiConversationNodeRenderers,
      userMessage: renderUser,
      assistantMessage: renderAssistant,
    } satisfies AiConversationNodeRendererMap;
    const { rerender } = render(
      <AiConversationNodeList nodes={[user, assistant]} renderers={renderers} />,
    );

    for (let revision = 1; revision <= 20; revision += 1) {
      const text = `${assistantText(assistant)}${'.'.repeat(revision)}`;
      rerender(
        <AiConversationNodeList
          nodes={[
            { ...user },
            {
              ...assistant,
              blocks: [{ type: 'text', text }],
            },
          ]}
          renderers={renderers}
        />,
      );
    }

    expect(renderUser).toHaveBeenCalledTimes(1);
    expect(renderAssistant).toHaveBeenCalledTimes(21);
  });

  it('keeps 50 tool payloads out of the conversation DOM until details open', () => {
    const process = projectAgentChatNodes(agentSessionEventFixture)
      .find((node) => node.kind === 'turnProcess');
    const base = process?.kind === 'turnProcess'
      ? process.children.find((node) => node.kind === 'tool')
      : undefined;
    if (!base || base.kind !== 'tool') throw new Error('Agent fixture did not project a tool');
    const sentinel = 'TOOL_INPUT_MUST_STAY_LAZY';
    const tools = Array.from({ length: 50 }, (_, index) => ({
      ...base,
      key: `tool:perf-${index}`,
      callId: `perf-${index}`,
      input: { payload: sentinel, index },
    }));
    const { container } = render(<AiConversationNodeList nodes={tools} />);

    expect(container.querySelectorAll('[data-ai-node-kind="tool"]')).toHaveLength(50);
    expect(container).not.toHaveTextContent(sentinel);
  });

  it('renders the user bubble and shell-free Markdown assistant with message copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const userNode: AiConversationNodeOf<'userMessage'> = {
      kind: 'userMessage',
      key: 'user:layout',
      sourceKind: 'agent',
      sessionId: 'agent-layout',
      turnId: 'request-layout',
      stepId: null,
      firstSeq: 0,
      lastSeq: 0,
      timestamp: '2026-09-03T00:00:00.000Z',
      messageId: 'user-layout',
      content: 'Keep this compact.',
      delivery: 'committed',
    };
    const assistantNode: AiConversationNodeOf<'assistantMessage'> = {
      kind: 'assistantMessage',
      key: 'assistant:layout',
      sourceKind: 'agent',
      sessionId: 'agent-layout',
      turnId: 'request-layout',
      stepId: null,
      firstSeq: 1,
      lastSeq: 1,
      timestamp: '2026-09-03T00:00:01.000Z',
      messageId: 'assistant-layout',
      requestId: 'request-layout',
      blocks: [{ type: 'text', text: '## Safe result\n\nThe service is **ready**.' }],
      state: 'completed',
    };
    const { rerender } = render(<AiConversationNodeList nodes={[
      userNode, { ...assistantNode, state: 'streaming' },
    ]} />);
    expect(within(screen.getByRole('article', { name: 'AI assistant message' }))
      .queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Your message' }))
      .getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    rerender(<AiConversationNodeList nodes={[userNode, assistantNode]} />);

    const userArticle = screen.getByRole('article', { name: 'Your message' });
    const assistantArticle = screen.getByRole('article', { name: 'AI assistant message' });
    expect(userArticle.querySelector('.ai-message-bubble-user')).toBeInTheDocument();
    expect(assistantArticle.querySelector('.ai-message-bubble-assistant')).toBeInTheDocument();
    expect(assistantArticle.querySelector('.ai-message-bubble-content')).toHaveStyle({ padding: '0px' });
    expect(within(assistantArticle).getByRole('heading', { name: 'Safe result' })).toBeVisible();

    await user.click(within(assistantArticle).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(assistantText(assistantNode));
    expect(await within(assistantArticle).findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('renders projected reasoning as a semantic nested disclosure', async () => {
    const user = userEvent.setup();
    const reasoning: AiConversationNodeOf<'reasoning'> = {
      kind: 'reasoning',
      key: 'reasoning:fixture',
      sourceKind: 'agent',
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      firstSeq: 1,
      lastSeq: 2,
      timestamp: '2026-09-03T00:00:00.000Z',
      requestId: 'request-1',
      summary: 'Inspect the service state',
      content: 'Inspect the service state\nChoose the safe read-only command.',
      state: 'completed',
    };
    const { container } = render(<AiConversationNodeList nodes={[reasoning]} />);

    const disclosure = screen.getByRole('button', { name: 'Reasoning Inspect the service state' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.ai-reasoning-body')).toBeNull();
    await user.click(disclosure);
    expect(container.querySelector('.ai-reasoning-body'))
      .toHaveTextContent('Inspect the service state Choose the safe read-only command.');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('[data-ai-running-indicator]')).toHaveLength(0);
  });

  it.each([
    ['terminal.exec', 'terminal'],
    ['read_file', 'read'],
    ['search_text', 'search'],
    ['web.fetch', 'web'],
    ['apply_patch', 'edit'],
    ['write_file', 'write'],
    ['python', 'code'],
    ['vendor.future_capability', 'generic'],
  ] as const)('classifies %s with the %s presentation', (name, variant) => {
    expect(classifyAiTool(name)).toBe(variant);
  });

  it('covers running, completed, and failed tool rows, inline expansion, details, and fallback', async () => {
    const user = userEvent.setup();
    const openTool = vi.fn();
    const running = toolNode();
    const completed = toolNode({
      key: 'tool:read',
      callId: 'call-read',
      name: 'read_file',
      summary: '/srv/app/config.toml',
      state: 'succeeded',
      durationMs: 125,
      input: { path: '/srv/app/config.toml' },
      output: 'enabled = true',
    });
    const failed = toolNode({
      key: 'tool:future',
      callId: 'call-future',
      name: 'vendor.future_capability',
      summary: 'Provider rejected the call',
      state: 'failed',
      input: { opaque: true },
      output: { message: 'Provider rejected the call' },
      error: 'Provider rejected the call',
    });
    const { container } = render(
      <AiConversationNodeList nodes={[running, completed, failed]} onOpenTool={openTool} />,
    );
    const runningSeat = container.querySelector('[data-ai-node-key="tool:fixture"]') as HTMLElement;
    const completedSeat = container.querySelector('[data-ai-node-key="tool:read"]') as HTMLElement;
    const failedSeat = container.querySelector('[data-ai-node-key="tool:future"]') as HTMLElement;

    expect(runningSeat.querySelector('[data-tool-state="running"]')).toHaveAttribute('data-tool-variant', 'terminal');
    expect(completedSeat.querySelector('[data-tool-state="succeeded"]')).toHaveAttribute('data-tool-variant', 'read');
    expect(completedSeat).toHaveTextContent('125 ms');
    expect(failedSeat.querySelector('[data-tool-state="failed"]')).toHaveAttribute('data-tool-fallback');
    expect(within(failedSeat).getByRole('status')).toHaveTextContent('Failed');

    await user.click(within(runningSeat).getByRole('button', { name: 'Command: Run diagnostics' }));
    expect(runningSeat.querySelector('[data-ai-tool-view="terminal"]')).toBeInTheDocument();
    const inspect = within(runningSeat).getByRole('button', { name: 'Open details for terminal.exec' });
    await user.click(inspect);
    expect(openTool).toHaveBeenCalledWith(running);

    await user.click(within(failedSeat).getByRole('button', { name: 'Tool call: Provider rejected the call' }));
    expect(failedSeat.querySelector('[data-ai-tool-view="generic"]')).toHaveTextContent('Provider rejected the call');
  });

  it('renders a produced artifact and preserves its details navigation', async () => {
    const user = userEvent.setup();
    const openArtifact = vi.fn();
    const artifact: AiConversationNodeOf<'artifact'> = {
      kind: 'artifact',
      key: 'artifact:report',
      sourceKind: 'agent',
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      firstSeq: 1,
      lastSeq: 1,
      timestamp: '2026-09-03T00:00:00.000Z',
      artifactId: 'report',
      artifactKind: 'text',
      title: 'Deployment report',
      sizeBytes: 42,
      mediaType: 'text/plain',
      sha256: 'abc123',
      sensitivity: 'internal',
    };
    render(<AiConversationNodeList nodes={[artifact]} onOpenArtifact={openArtifact} />);

    expect(screen.getByText('Produced')).toBeVisible();
    expect(screen.getByText('42 B')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open artifact Deployment report' }));
    expect(openArtifact).toHaveBeenCalledWith(artifact);
  });

  it('renders only real tail metrics and keeps long generic payloads bounded at narrow widths', async () => {
    const user = userEvent.setup();
    const longValue = `/very-long-segment-${'x'.repeat(80)}`.repeat(20);
    const generic = toolNode({
      key: 'tool:narrow',
      callId: 'call-narrow',
      name: 'vendor.future_capability',
      summary: 'Unknown long payload',
      state: 'succeeded',
      input: { path: longValue },
      output: { value: longValue },
    });
    const projectedTail = projectAgentChatNodes(agentSessionEventFixture)
      .find((node): node is AiConversationNodeOf<'turnTail'> => node.kind === 'turnTail');
    expect(projectedTail).toBeDefined();
    if (!projectedTail) return;
    const stats: AiConversationNodeOf<'turnTail'> = {
      ...projectedTail,
      stats: {
        ...projectedTail.stats,
        stepCount: 2,
        modelDurationMs: null,
        toolDurationMs: 220,
        averageTimeToFirstTokenMs: null,
        uncachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        tokensPerSecond: null,
        usageComplete: false,
      },
    };
    const { container } = render(
      <div className="ai-panel-shell" style={{ width: 240 }}>
        <AiConversationNodeList nodes={[generic, stats]} />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Tool call: Unknown long payload' }));
    const flow = container.querySelector('[data-ai-node-key="tool:narrow"]') as HTMLElement;
    const card = flow.querySelector('.ai-io-card') as HTMLElement;
    const payload = flow.querySelector('.ai-io-text') as HTMLElement;
    expect(getComputedStyle(flow).minWidth).toBe('0px');
    expect(getComputedStyle(card).maxWidth).toBe('calc(100% - 4px)');
    expect(getComputedStyle(card).overflow).toBe('hidden');
    expect(getComputedStyle(payload).overflowWrap).toBe('anywhere');

    const footer = screen.getByLabelText('Turn statistics');
    expect(within(footer).queryByRole('button', { name: /^Usage/ })).not.toBeInTheDocument();
    await user.click(within(footer).getByRole('button', { name: /^Time / }));
    const details = await screen.findByRole('dialog', { name: 'Turn timing and speed' });
    expect(details.querySelector('[data-stat="steps"]')).toHaveTextContent('2');
    expect(details.querySelector('[data-stat="tools"]')).toHaveTextContent('0.2s');
    for (const missing of ['model', 'ttft', 'rate', 'tokens']) {
      expect(details.querySelector(`[data-stat="${missing}"]`)).not.toBeInTheDocument();
    }
    const statsRow = footer.querySelector('.ai-turn-stats') as HTMLElement;
    expect(getComputedStyle(statsRow).display).toBe('flex');
    expect(getComputedStyle(statsRow).flexWrap).toBe('wrap');
    expect(getComputedStyle(statsRow).overflow).toBe('visible');
    await waitFor(() => expect(payload).toHaveTextContent('/very-long-segment'));
  });
});
