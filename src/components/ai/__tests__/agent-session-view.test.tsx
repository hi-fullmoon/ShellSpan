import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSessionView } from '@/components/ai/agent-session-view';
import { agentSessionEventFixture } from '@/lib/__tests__/agent-session-fixture';
import { projectAgentSession } from '@/lib/agent-session-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

describe('AgentSessionView', () => {
  beforeEach(async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  it('renders Conversation and Activity from the same Session projection', async () => {
    const user = userEvent.setup();
    const projection = projectAgentSession(agentSessionEventFixture);
    render(<AgentSessionView projection={projection} />);

    expect(screen.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Check nginx now.')).toBeVisible();
    expect(screen.getByText('Checking now.')).toBeVisible();
    expect(screen.getByText('Check service health')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Expand terminal tool call' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await user.click(screen.getByRole('button', { name: 'Expand terminal tool call' }));
    expect(screen.getByText('systemctl is-active nginx', { exact: false })).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('Turn 1')).toBeVisible();
    expect(screen.getByText('Step 1')).toBeVisible();
    expect(screen.getByText('gpt-test · 170 ms · 32000 tokens')).toBeVisible();
    expect(screen.getByText('1/1 steps completed')).toBeVisible();
    expect(screen.getByText('Wave 1/1 · 1/1 targets completed')).toBeVisible();
    expect(screen.getByTestId('agent-fleet-matrix')).toBeVisible();
    expect(screen.getByText('terminal-a')).toBeVisible();
    expect(screen.getByText('verifier · session-verifier')).toBeVisible();
  });

  it('adapts a durable runtime approval without changing the legacy approval card', async () => {
    const user = userEvent.setup();
    const onApproveRuntime = vi.fn();
    const onRejectRuntime = vi.fn();
    const projection = projectAgentSession(agentSessionEventFixture.slice(0, 15));
    render(
      <AgentSessionView
        projection={projection}
        onApproveRuntime={onApproveRuntime}
        onRejectRuntime={onRejectRuntime}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Awaiting approval');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onRejectRuntime).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      callId: 'call-health',
      approvalId: 'approval-health',
    });

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(onApproveRuntime).toHaveBeenCalledWith({
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      callId: 'call-health',
      approvalId: 'approval-health',
    });
  });
});
