import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProfileStore } from '@/stores/profileStore';
import { RunbookPanel } from '../runbook-panel';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('RunbookPanel', () => {
  afterEach(() => {
    useProfileStore.setState({ profiles: [] });
  });

  it('renders the reviewable local text contract and risk-aware workflow', () => {
    render(<RunbookPanel />);
    expect(screen.getByRole('heading', { name: 'runbook.title' })).toBeInTheDocument();
    expect((screen.getByRole('textbox', { name: 'runbook.textTitle' }) as HTMLTextAreaElement).value)
      .toContain('"schemaVersion": 1');
    expect(screen.getByText('Reload nginx safely')).toBeInTheDocument();
    expect(screen.getByText('runbook.secretPolicy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /runbook.reviewRun/ })).toBeDisabled();
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
});
