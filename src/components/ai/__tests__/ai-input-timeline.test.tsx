import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { inboxTimelineEvidence, inboxTimelineView } from '@/test/fixtures/agent-inbox-timeline';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';

beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

it('keeps waiting input in its queue and shows an accepted correction between process sections', async () => {
  const { events } = inboxTimelineEvidence;
  const consumed = events.findIndex(event => event.type === 'user/message' && event.data.message.messageId === 'correction');
  const { container, rerender } = render(<AiWorkspaceRoot scope="workbench" view={inboxTimelineView(consumed)} />);
  const queue = await screen.findByRole('region', { name: 'Queued input' });
  expect(within(queue).getByText('Waiting for next step')).toBeInTheDocument();
  expect(container.querySelector('[data-ai-node-key="user:correction"]')).toBeNull();
  const first = container.querySelector('[data-ai-node-key="user:initial"]');
  const process = container.querySelector('[data-ai-node-key="turn-process:turn-1"]');
  await act(async () => rerender(<AiWorkspaceRoot scope="workbench" view={inboxTimelineView(consumed + 1)} />));
  expect(container.querySelector('[data-ai-node-key="user:initial"]')).toBe(first);
  expect(container.querySelector('[data-ai-node-key="turn-process:turn-1"]')).toBe(process);
  expect(screen.queryByText('Waiting for next step')).toBeNull();
  expect(screen.getByText('Added to this turn')).toBeInTheDocument();
  const correction = container.querySelector('[data-ai-node-key="user:correction"]');
  expect(correction).toBeInTheDocument();
  expect(first!.closest('[data-slot="message-scroller-item"]')).toHaveAttribute('data-scroll-anchor', 'true');
  expect(correction!.closest('[data-slot="message-scroller-item"]')).not.toHaveAttribute('data-scroll-anchor', 'true');
  expect(process!.compareDocumentPosition(correction!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  await act(async () => rerender(<AiWorkspaceRoot scope="workbench" view={inboxTimelineView()} />));
  expect(container.querySelector('[data-ai-node-key="user:correction"]')).toBe(correction);
  expect(container.querySelectorAll('[data-ai-node-kind="turnTail"]')).toHaveLength(1);
  expect(screen.queryByRole('region', { name: 'Queued input' })).toBeNull();
  const nextTurnInput = container.querySelector('[data-ai-node-key="user:new-turn-step"]');
  expect(nextTurnInput!.closest('[data-slot="message-scroller-item"]')).toHaveAttribute('data-scroll-anchor', 'true');
});
