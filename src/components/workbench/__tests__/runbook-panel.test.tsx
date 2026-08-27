import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProfileStore } from '@/stores/profileStore';
import { dispatchAgentRunbookDraft } from '@/lib/diagnostic-agent';
import { RUNBOOK_EXAMPLE } from '@/lib/runbook';
import * as tauri from '@/lib/tauri';
import type { ConnectionProfile } from '@/types';
import { RunbookPanel } from '../runbook-panel';

const originalEnsurePassword = useProfileStore.getState().ensurePassword;

vi.mock('../runbook-json-editor', () => ({
  default: ({
    value,
    onChange,
    disabled,
    ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    ariaLabel: string;
  }) => (
    <textarea
      data-slot="runbook-json-editor-test-double"
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));

describe('RunbookPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    act(() => {
      useProfileStore.setState({
        profiles: [],
        ensurePassword: originalEnsurePassword,
      });
    });
  });

  it('renders the reviewable local text contract and risk-aware workflow', async () => {
    const { container } = render(<RunbookPanel />);
    expect(screen.getByRole('heading', { name: 'runbook.title' })).toBeInTheDocument();
    expect((await screen.findByRole('textbox', { name: 'runbook.textTitle' }) as HTMLTextAreaElement).value)
      .toContain('"schemaVersion": 1');
    expect(container.querySelector('[data-slot="runbook-json-editor-test-double"]')).toBeInTheDocument();
    expect(screen.getByText('Reload nginx safely')).toBeInTheDocument();
    expect(screen.getByText('runbook.secretPolicy')).toBeInTheDocument();
    const reviewButton = screen.getByRole('button', { name: /runbook.reviewRun/ });
    expect(reviewButton).toHaveClass('h-9');
    expect(reviewButton).toBeDisabled();
    expect(reviewButton.querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: 'runbook.open' }).querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: 'runbook.save' }).querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: 'runbook.validate' }).querySelector('svg')).toBeNull();
    expect(screen.getByRole('tab', { name: 'runbook.tab.source' }).querySelector('svg')).toBeNull();
    expect(screen.getByRole('tab', { name: 'runbook.tab.workflow' }).querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: 'runbook.targetMode.single' }).querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: 'runbook.targetMode.tag' }).querySelector('svg')).toBeNull();

    const panel = container.querySelector<HTMLElement>('[data-slot="runbook-panel"]');
    const header = panel?.querySelector('[data-slot="workbench-page-header"]');
    const headerCopy = header?.querySelector('[data-slot="workbench-page-header-copy"]');
    const headerActions = header?.querySelector('[data-slot="workbench-page-header-actions"]');
    const scroller = panel?.querySelector('[data-slot="scroll-area"]');
    const content = panel?.querySelector('[data-slot="workbench-page-content"]');
    const overview = container.querySelector('[data-slot="runbook-overview"]');
    const layout = container.querySelector('[data-slot="runbook-layout"]');
    const workspace = container.querySelector('[data-slot="runbook-workspace"]');
    const setup = container.querySelector('[data-slot="runbook-setup"]');
    expect(panel).toHaveClass('@container', 'min-w-0');
    expect(header).toBeInTheDocument();
    expect(headerCopy).toHaveClass('@min-[64rem]:flex-1');
    expect(headerCopy).not.toHaveClass('@min-[64rem]:shrink-0');
    expect(headerActions).toHaveClass('@min-[64rem]:shrink-0', '@min-[64rem]:flex-nowrap');
    expect(headerActions).not.toHaveClass('@min-[64rem]:flex-1');
    expect(scroller).toHaveClass('min-h-0', 'flex-1');
    expect(content).toHaveClass('@container');
    expect(overview).toBeInTheDocument();
    expect(workspace).toBeInTheDocument();
    expect(setup).toBeInTheDocument();
    expect(layout).toHaveClass(
      'grid-cols-1',
      '@min-[60rem]:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]',
    );
  });

  it('uses the shadcn target-mode toggle and exposes tagged batching limits', () => {
    useProfileStore.setState({
      profiles: [{
        id: 'profile-1',
        name: 'prod-1',
        host: 'prod-1.example.test',
        port: 22,
        username: 'operator',
        authMethod: 'password',
        tags: ['production'],
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    render(<RunbookPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'runbook.targetMode.tag' }));

    expect(screen.getByRole('combobox', { name: 'runbook.multi.tag' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'runbook.multi.concurrency' })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: 'runbook.multi.batchSize' })).toHaveValue(5);
    expect(screen.getByRole('button', { name: 'runbook.multi.startPreflight' })).toBeDisabled();
  });

  it('loads an AI draft for review without saving or executing it', () => {
    act(() => {
      useProfileStore.setState({
        profiles: [{
          id: 'profile-1',
          name: 'prod-1',
          host: 'prod-1.example.test',
          port: 22,
          username: 'operator',
          authMethod: 'password',
          tags: ['production'],
          createdAt: 1,
          updatedAt: 1,
        }],
      });
      dispatchAgentRunbookDraft({
        sourceText: RUNBOOK_EXAMPLE,
        profileId: 'profile-1',
        contextLabel: 'operator@prod-1.example.test',
        contextObservedAt: 1_000,
        objective: 'Reload nginx safely',
        target: 'The bound production host only',
      });
    });
    render(<RunbookPanel />);

    expect(screen.getByText('runbook.aiDraftTitle')).toBeInTheDocument();
    expect(screen.getAllByText(/Reload nginx safely/)).not.toHaveLength(0);
    expect(screen.getAllByText(/operator@prod-1.example.test/)).not.toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'runbook.target' }))
      .toHaveTextContent('prod-1 · operator@prod-1.example.test:22');
    expect(screen.getByRole('combobox', { name: 'runbook.target' }))
      .not.toHaveTextContent('profile-1');
    expect(screen.getByRole('button', { name: 'runbook.reviewRun' })).toBeEnabled();
  });

  it('locks the workspace while opening a file and prevents duplicate dialogs', async () => {
    let resolveOpen: (value: null) => void = () => undefined;
    const open = vi.spyOn(tauri, 'invokeOpenRunbookFile').mockImplementation(() => (
      new Promise((resolve) => {
        resolveOpen = resolve;
      })
    ));
    render(<RunbookPanel />);

    const openButton = screen.getByRole('button', { name: 'runbook.open' });
    fireEvent.click(openButton);
    fireEvent.click(openButton);

    const openingButton = await screen.findByRole('button', { name: 'runbook.opening' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(openingButton).toBeDisabled();
    expect(openingButton.querySelector('svg')).toHaveAttribute('data-icon', 'inline-start');
    expect(screen.getByRole('button', { name: 'runbook.save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'runbook.validate' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'runbook.textTitle' })).toBeDisabled();

    await act(async () => resolveOpen(null));
    await waitFor(() => expect(screen.getByRole('button', { name: 'runbook.open' })).toBeEnabled());
  });

  it('locks and revalidates the reviewed item while credentials are prepared', async () => {
    const profile: ConnectionProfile = {
      id: 'profile-1',
      name: 'prod-1',
      host: 'prod-1.example.test',
      port: 22,
      username: 'operator',
      authMethod: 'password',
      password: 'test-password',
      tags: ['production'],
      createdAt: 1,
      updatedAt: 1,
    };
    let resolveCredentials: (value: ConnectionProfile) => void = () => undefined;
    const ensurePassword = vi.fn(() => new Promise<ConnectionProfile>((resolve) => {
      resolveCredentials = resolve;
    }));
    const execute = vi.spyOn(tauri, 'invokeExecuteRunbookStep');
    act(() => {
      useProfileStore.setState({ profiles: [profile], ensurePassword });
      dispatchAgentRunbookDraft({
        sourceText: RUNBOOK_EXAMPLE,
        profileId: profile.id,
        contextLabel: `${profile.username}@${profile.host}`,
        contextObservedAt: 1_000,
        objective: 'Reload nginx safely',
        target: 'The bound production host only',
      });
    });
    const { container } = render(<RunbookPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'runbook.reviewRun' }));
    const executionReview = container.querySelector('[data-slot="runbook-execution-review"]') as HTMLElement;

    fireEvent.click(within(executionReview).getByRole('button', { name: 'runbook.approveExecute' }));

    const preparingButton = await within(executionReview)
      .findByRole('button', { name: 'runbook.preparing' });
    expect(preparingButton).toBeDisabled();
    expect(preparingButton.querySelector('svg')).toHaveAttribute('data-icon', 'inline-start');
    expect(within(executionReview).getByRole('button', { name: 'runbook.pause' })).toBeDisabled();
    expect(within(executionReview).getByRole('button', { name: 'runbook.reject' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'runbook.textTitle' })).toBeDisabled();

    act(() => {
      dispatchAgentRunbookDraft({
        sourceText: RUNBOOK_EXAMPLE,
        profileId: profile.id,
        contextLabel: `${profile.username}@${profile.host}`,
        contextObservedAt: 2_000,
        objective: 'A newer reviewed draft',
        target: 'The same host with newer context',
      });
    });
    await act(async () => resolveCredentials(profile));

    await waitFor(() => expect(ensurePassword).toHaveBeenCalledTimes(1));
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByText(/A newer reviewed draft/)).toBeInTheDocument();
  });

  it('removes the execution footer when a run stops without available actions', () => {
    act(() => {
      useProfileStore.setState({
        profiles: [{
          id: 'profile-1',
          name: 'prod-1',
          host: 'prod-1.example.test',
          port: 22,
          username: 'operator',
          authMethod: 'password',
          tags: ['production'],
          createdAt: 1,
          updatedAt: 1,
        }],
      });
      dispatchAgentRunbookDraft({
        sourceText: RUNBOOK_EXAMPLE,
        profileId: 'profile-1',
        contextLabel: 'operator@prod-1.example.test',
        contextObservedAt: 1_000,
        objective: 'Reload nginx safely',
        target: 'The bound production host only',
      });
    });
    const { container } = render(<RunbookPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'runbook.reviewRun' }));
    const executionReview = container.querySelector('[data-slot="runbook-execution-review"]');
    expect(executionReview).toBeInTheDocument();
    expect(executionReview?.querySelector('[data-slot="card-footer"]')).toBeInTheDocument();
    const resolvedVariables = executionReview?.querySelector('[data-slot="runbook-resolved-variables"]');
    const resolvedVariable = resolvedVariables?.querySelector('[data-slot="runbook-resolved-variable"]');
    const runItem = executionReview?.querySelector('[data-slot="runbook-run-item"]');
    const runItemHeader = runItem?.querySelector('[data-slot="runbook-run-item-header"]');
    const runItemStatus = runItem?.querySelector('[data-slot="runbook-run-item-status"]');
    expect(resolvedVariables).toBeInTheDocument();
    expect(resolvedVariable).toHaveClass('flex', 'items-center', 'gap-3', 'border', 'bg-card');
    expect(resolvedVariable).not.toHaveClass('grid-cols-[8rem_1fr]', 'bg-muted/60');
    expect(runItem).toHaveClass('grid-cols-[auto_minmax(0,1fr)]');
    expect(runItem).not.toHaveClass('grid-cols-[auto_minmax(0,1fr)_auto]');
    expect(runItemStatus).toHaveClass('shrink-0');
    expect(runItemStatus?.parentElement).toBe(runItemHeader);

    fireEvent.click(within(executionReview as HTMLElement).getByRole('button', { name: 'runbook.reject' }));

    expect(executionReview?.querySelector('[data-slot="card-footer"]')).not.toBeInTheDocument();
  });

  it('uses a neutral, single-flight cancel action while an approved command is running', async () => {
    vi.spyOn(tauri, 'invokeExecuteRunbookStep').mockImplementation(() => new Promise(() => {}));
    let resolveCancel: () => void = () => undefined;
    const cancel = vi.spyOn(tauri, 'invokeCancelRunbookStep').mockImplementation(() => (
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      })
    ));
    act(() => {
      useProfileStore.setState({
        profiles: [{
          id: 'profile-1',
          name: 'prod-1',
          host: 'prod-1.example.test',
          port: 22,
          username: 'operator',
          authMethod: 'password',
          password: 'test-password',
          tags: ['production'],
          createdAt: 1,
          updatedAt: 1,
        }],
      });
      dispatchAgentRunbookDraft({
        sourceText: RUNBOOK_EXAMPLE,
        profileId: 'profile-1',
        contextLabel: 'operator@prod-1.example.test',
        contextObservedAt: 1_000,
        objective: 'Reload nginx safely',
        target: 'The bound production host only',
      });
    });
    const { container } = render(<RunbookPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'runbook.reviewRun' }));
    const executionReview = container.querySelector('[data-slot="runbook-execution-review"]');
    expect(executionReview).toBeInTheDocument();

    fireEvent.click(within(executionReview as HTMLElement).getByRole('button', { name: 'runbook.approveExecute' }));

    await waitFor(() => {
      const cancelButton = within(executionReview as HTMLElement)
        .getByRole('button', { name: 'runbook.cancel' });
      expect(cancelButton).toHaveClass('border');
      expect(cancelButton).not.toHaveClass('bg-destructive');
    });

    const cancelButton = within(executionReview as HTMLElement)
      .getByRole('button', { name: 'runbook.cancel' });
    fireEvent.click(cancelButton);
    fireEvent.click(cancelButton);

    const cancellingButton = await within(executionReview as HTMLElement)
      .findByRole('button', { name: 'runbook.cancelling' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancellingButton).toBeDisabled();
    expect(cancellingButton.querySelector('svg')).toHaveAttribute('data-icon', 'inline-start');

    await act(async () => resolveCancel());
    expect(within(executionReview as HTMLElement)
      .getByRole('button', { name: 'runbook.cancelling' })).toBeDisabled();
  });
});
