import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSkillProposalSeat } from '../workspace/ai-skill-proposal-panel';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import type { AgentSkillProposalView, ResolveSkillProposalInput } from '@/types/agent-skill';

function makeProposal(
  overrides: Partial<AgentSkillProposalView['proposal']> = {},
): AgentSkillProposalView {
  return {
    identity: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'req-1',
      callId: 'call-1',
      proposalId: 'prop-1',
    },
    proposal: {
      mode: 'create',
      scope: 'user',
      workspaceAllowed: true,
      scopeDowngradeReason: null,
      name: 'deploy-orders',
      description: 'Deploy orders service with preflight and rollback checks',
      instructions: '# Deploy Orders\n\n1. Check disk space\n2. Reload systemd\n',
      userInvocable: true,
      disableModelInvocation: true,
      summary: 'Distilled from this deployment session',
      existingContent: null,
      existingFileHash: null,
      overwritesBuiltin: false,
      shadowedByWorkspace: false,
      validationIssues: [],
      ...overrides,
    },
    status: 'pending',
    firstSeq: 10,
    lastSeq: 10,
    timestamp: new Date(1_700_000_000_000).toISOString(),
  };
}

beforeEach(async () => {
  useToastStore.setState({ toasts: [] });
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AiSkillProposalSeat', () => {
  it('renders inline card with CardAction review button and saves with one toast', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn<(input: ResolveSkillProposalInput) => Promise<void>>(async () => undefined);
    const { container } = render(
      <AiSkillProposalSeat proposal={makeProposal()} onResolve={onResolve} />,
    );

    const card = container.querySelector('[data-slot="ai-skill-proposal-card"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-slot="card-action"]')).not.toBeNull();
    expect(screen.getByText('/deploy-orders')).toBeVisible();
    expect(screen.getByText('Global')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save skill' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      action: 'save',
      scope: 'user',
      name: 'deploy-orders',
      disableModelInvocation: true,
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]?.message).toContain('/deploy-orders');
  });

  it('opens review dialog with readable scope label, height-shrink scroll chain, diff view and no footer border', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn<(input: ResolveSkillProposalInput) => Promise<void>>(async () => undefined);
    render(
      <AiSkillProposalSeat
        proposal={makeProposal({
          mode: 'update',
          existingContent: '---\nname: deploy-orders\ndescription: Old\n---\n\n# Old\n',
          existingFileHash: 'a'.repeat(64),
        })}
        onResolve={onResolve}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Review Diff / Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveClass('flex', 'flex-col');

    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    expect(footer).toHaveClass('shrink-0');
    expect(footer?.className).not.toContain('border-t');

    // Readable i18n label in Select trigger instead of raw 'user'.
    expect(dialog).toHaveTextContent('User global (~/.shellspan/skills)');
    expect(dialog.querySelector('[data-slot="ai-skill-proposal-diff"]')).not.toBeNull();
  });

  it('blocks saving when redaction issue is present and supports revision request & cancel', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn<(input: ResolveSkillProposalInput) => Promise<void>>(async () => undefined);
    render(
      <AiSkillProposalSeat
        proposal={makeProposal({
          validationIssues: [
            {
              code: 'redactionRequired',
              field: 'instructions',
              message: 'Remove secret token before saving.',
            },
          ],
        })}
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText('Remove secret token before saving.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save skill' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.type(
      screen.getByPlaceholderText(/Describe what to adjust/),
      'Remove the token and add rollback check',
    );
    await user.click(screen.getByRole('button', { name: 'Send feedback' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      action: 'requestRevision',
      note: 'Remove the token and add rollback check',
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
    expect(onResolve.mock.calls[1]?.[0]).toMatchObject({ action: 'cancel' });
  });

  it('shows save failure in contextual alert without duplicating a toast', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn(async () => {
      throw new Error('SKILL_CONFLICT: changed on disk');
    });
    render(<AiSkillProposalSeat proposal={makeProposal()} onResolve={onResolve} />);

    await user.click(screen.getByRole('button', { name: 'Save skill' }));
    expect(await screen.findByText('SKILL_CONFLICT: changed on disk')).toBeVisible();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
