import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProfileStore } from '@/stores/profileStore';
import { dispatchAgentRunbookDraft } from '@/lib/diagnostic-agent';
import { RUNBOOK_EXAMPLE } from '@/lib/runbook';
import { RunbookPanel } from '../runbook-panel';

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
    act(() => {
      useProfileStore.setState({ profiles: [] });
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
    expect(screen.getByRole('button', { name: 'runbook.reviewRun' })).toBeEnabled();
  });
});
