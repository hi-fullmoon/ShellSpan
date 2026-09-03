import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiConversationNodeList,
  aiConversationNodeRenderers,
  type AiConversationNodeRendererMap,
} from '@/components/ai/workspace/ai-conversation-node-seat';
import {
  projectAgentConversationNodes,
  projectAskConversationNodes,
} from '@/lib/ai/conversation-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import {
  agentSessionEventFixture,
  agentSessionFailedEventFixture,
} from '@/test/fixtures/agent-session';
import {
  askStreamingConversationFixture,
  askStreamingMessageFixture,
} from '@/test/fixtures/ask-streaming';

describe('AiConversationNodeList', () => {
  beforeEach(async () => {
    cleanup();
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  it('renders Ask and Agent projections through the same keyed node seat', () => {
    const askNodes = projectAskConversationNodes({
      conversation: askStreamingConversationFixture,
      messages: askStreamingMessageFixture,
      phase: 'streaming',
    });
    const { unmount } = render(<AiConversationNodeList nodes={askNodes} />);

    expect(screen.getByText('Why did the deployment fail?')).toBeVisible();
    expect(screen.getByText('Inspecting the deployment output.')).toBeVisible();
    expect(document.querySelector('[data-ai-node-key="assistant:ask-stream-request"]'))
      .toHaveAttribute('data-ai-node-kind', 'assistantMessage');

    unmount();
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
    const projected = projectAskConversationNodes({
      conversation: askStreamingConversationFixture,
      messages: askStreamingMessageFixture,
      phase: 'streaming',
    });
    const user = projected.find((node) => node.kind === 'userMessage');
    const assistant = projected.find((node) => node.kind === 'assistantMessage');
    if (!user || user.kind !== 'userMessage' || !assistant || assistant.kind !== 'assistantMessage') {
      throw new Error('Ask fixture did not project the expected messages');
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
});
