import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiConversationNodeList,
  aiConversationNodeRenderers,
  type AiConversationNodeRendererMap,
} from '@/components/ai/workspace/ai-conversation-node-seat';
import { classifyAiTool } from '@/components/ai/workspace/ai-tool-presentation';
import { projectAgentConversationNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import {
  agentSessionEventFixture,
  agentSessionFailedEventFixture,
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

describe('AiConversationNodeList', () => {
  beforeEach(async () => {
    cleanup();
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  it('renders Agent projections through the keyed node seat', () => {
    const agentNodes = projectAgentConversationNodes(agentSessionEventFixture);
    render(<AiConversationNodeList nodes={agentNodes} />);

    expect(screen.getByText('Check nginx now.')).toBeVisible();
    expect(screen.getByText('Checking now.')).toBeVisible();
    expect(document.querySelector('[data-ai-node-key="tool:call-health"]'))
      .toHaveAttribute('data-ai-node-kind', 'tool');
  });

  it('renders lifecycle markers and terminal errors as distinct stable node views', () => {
    const nodes = projectAgentConversationNodes(agentSessionFailedEventFixture);
    const { container } = render(<AiConversationNodeList nodes={nodes} />);

    expect(container.querySelector('[data-ai-node-kind="lifecycleMarker"]'))
      .toBeInTheDocument();
    expect(container.querySelector('[data-ai-node-kind="error"] [role="alert"]'))
      .toHaveTextContent('Provider connection failed.');
    expect(container.querySelectorAll('[data-ai-node-key]')).toHaveLength(nodes.length);
  });

  it('rerenders only the changed streaming node across 20 projection revisions', () => {
    const projected = projectAgentConversationNodes(agentSessionEventFixture);
    const user = projected.find((node) => node.kind === 'userMessage');
    const assistant = projected.find((node) => node.kind === 'assistantMessage');
    if (!user || user.kind !== 'userMessage' || !assistant || assistant.kind !== 'assistantMessage') {
      throw new Error('Agent fixture did not project the expected messages');
    }
    const renderUser = vi.fn(({ node }: { node: typeof user }) => <span>{node.content}</span>);
    const renderAssistant = vi.fn(({ node }: { node: typeof assistant }) => <span>{node.content}</span>);
    const renderers = {
      ...aiConversationNodeRenderers,
      userMessage: renderUser,
      assistantMessage: renderAssistant,
    } satisfies AiConversationNodeRendererMap;
    const { rerender } = render(
      <AiConversationNodeList nodes={[user, assistant]} renderers={renderers} />,
    );

    for (let revision = 1; revision <= 20; revision += 1) {
      rerender(
        <AiConversationNodeList
          nodes={[
            { ...user },
            { ...assistant, content: `${assistant.content}${'.'.repeat(revision)}` },
          ]}
          renderers={renderers}
        />,
      );
    }

    expect(renderUser).toHaveBeenCalledTimes(1);
    expect(renderAssistant).toHaveBeenCalledTimes(21);
  });

  it('keeps 50 tool payloads out of the conversation DOM until details open', () => {
    const base = projectAgentConversationNodes(agentSessionEventFixture)
      .find((node) => node.kind === 'tool');
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
      content: '## Safe result\n\nThe service is **ready**.',
      state: 'completed',
    };
    render(<AiConversationNodeList nodes={[userNode, assistantNode]} />);

    const userArticle = screen.getByRole('article', { name: 'Your message' });
    const assistantArticle = screen.getByRole('article', { name: 'AI assistant message' });
    expect(userArticle.querySelector('.ai-message-bubble-user')).toBeInTheDocument();
    expect(assistantArticle.querySelector('.ai-message-bubble-assistant')).toBeInTheDocument();
    expect(assistantArticle.querySelector('.ai-message-bubble-content')).toHaveStyle({ padding: '0px' });
    expect(within(assistantArticle).getByRole('heading', { name: 'Safe result' })).toBeVisible();

    await user.click(within(assistantArticle).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(assistantNode.content);
    expect(await within(assistantArticle).findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('expands and collapses projected reasoning without duplicating a running indicator', async () => {
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

    expect(container.querySelector('.ai-reasoning-body')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand thinking summary' }));
    expect(container.querySelector('.ai-reasoning-body'))
      .toHaveTextContent('Inspect the service state Choose the safe read-only command.');
    await user.click(screen.getByRole('button', { name: 'Collapse thinking summary' }));
    expect(container.querySelector('.ai-reasoning-body')).not.toBeInTheDocument();
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
    const stats: AiConversationNodeOf<'turnStats'> = {
      kind: 'turnStats',
      key: 'stats:session-fixture',
      sourceKind: 'agent',
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: null,
      firstSeq: 1,
      lastSeq: 10,
      timestamp: '2026-09-03T00:00:10.000Z',
      turnNumber: 1,
      stepCount: 2,
      modelDurationMs: null,
      toolDurationMs: 220,
      averageTimeToFirstTokenMs: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      tokensPerSecond: null,
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

    const statsRow = screen.getByLabelText('Turn statistics');
    expect(statsRow.querySelectorAll('[data-stat]')).toHaveLength(3);
    expect(statsRow.querySelector('[data-stat="turn"]')).toHaveTextContent('1 turns');
    expect(statsRow.querySelector('[data-stat="steps"]')).toHaveTextContent('2 steps');
    expect(statsRow.querySelector('[data-stat="tools"]')).toHaveTextContent('Tools 0.2s');
    for (const missing of ['model', 'ttft', 'rate', 'tokens']) {
      expect(statsRow.querySelector(`[data-stat="${missing}"]`)).not.toBeInTheDocument();
    }
    expect(getComputedStyle(statsRow).overflow).toBe('hidden');
    expect(getComputedStyle(statsRow).textOverflow).toBe('ellipsis');
    await waitFor(() => expect(payload).toHaveTextContent('/very-long-segment'));
  });
});
