import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiConversationNodeList } from '@/components/ai/workspace/ai-conversation-node-seat';
import { projectAgentActivity } from '@/lib/agent-session-projection';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import type { AgentSessionEvent } from '@/types/agent-session';

// These baseline scenarios keep the same request configuration throughout.
function snapshotEvents(events: readonly AgentSessionEvent[]): AgentSessionEvent[] {
  const first = events.find((event) => event.type === 'request/header');
  if (!first) throw new Error('Missing baseline header');
  let requestIndex = 0;
  return events.flatMap((event): AgentSessionEvent[] => {
    if (event.type !== 'request/header') return [event];
    const start: AgentSessionEvent = {
      ...event,
      type: 'request/start',
      data: {
        requestId: event.data.requestId,
        headerRequestId: first.data.requestId,
        providerId: event.data.providerId,
        model: event.data.model,
        reason: event.data.reason,
        series: { seriesId: first.data.series.seriesId, startsSeries: requestIndex === 0, requestIndex },
        attempt: event.data.attempt,
      },
    };
    requestIndex += 1;
    return event === first
      ? [{ ...event, timeUnixMs: event.timeUnixMs - 1, data: { ...event.data, snapshotReason: 'initial' } }, start]
      : [start];
  }).map((event, seq) => ({ ...event, seq }));
}

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('shared request snapshots', () => {
  it.each(['retry-success', 'pagination'] as const)(
    'shows one disclosure and preserves every request and timing for %s', async (scenario) => {
      const user = userEvent.setup();
      const original = agentSessionBaselineScenarios[scenario].events;
      const events = snapshotEvents(original);
      const nodes = projectAgentChatNodes(events);
      const reference = projectAgentChatNodes(original);
      expect(nodes.filter((node) => node.kind === 'turnTail').map((node) => node.stats))
        .toEqual(reference.filter((node) => node.kind === 'turnTail').map((node) => node.stats));
      const activity = projectAgentActivity(events);
      const requests = activity.turns.flatMap((turn) => turn.steps.flatMap((step) => step.requests));
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.systemPrompt)).toEqual([
        requests[0].systemPrompt, requests[0].systemPrompt,
      ]);
      expect(requests[0].systemPrompt).not.toBeNull();
      expect(requests.map((request) => request.startedAt)).toEqual(original.flatMap((event) => (
        event.type === 'request/header' ? [event.timeUnixMs] : []
      )));

      render(<AiConversationNodeList nodes={nodes} />);
      const disclosure = screen.getByRole('button', { name: 'System prompt' });
      expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await user.click(disclosure);
      expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      expect(document.querySelector('.ai-semantic-note-body')?.textContent).toBe(requests[0].systemPrompt);
    },
  );

  it('keeps paginated requests when their snapshot is outside the loaded window', () => {
    const events = snapshotEvents(agentSessionBaselineScenarios.pagination.events);
    const secondStart = events.findIndex((event) => (
      event.type === 'request/start' && event.data.series.requestIndex === 1
    ));
    const window = events.slice(secondStart);
    const request = projectAgentActivity(window).turns[0]?.steps[0]?.requests[0];
    expect(request).toMatchObject({ requestId: 'request-02', systemPrompt: null, toolSchemas: null });
    expect(projectAgentChatNodes(window).some((node) => node.kind === 'systemPrompt')).toBe(false);
    expect(projectAgentActivity([...events.slice(0, secondStart), ...window]))
      .toEqual(projectAgentActivity(events));
  });
});
