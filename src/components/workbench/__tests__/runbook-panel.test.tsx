import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
  it('renders the reviewable local text contract and risk-aware workflow', () => {
    render(<RunbookPanel />);
    expect(screen.getByRole('heading', { name: 'runbook.title' })).toBeInTheDocument();
    expect((screen.getByRole('textbox', { name: 'runbook.textTitle' }) as HTMLTextAreaElement).value)
      .toContain('"schemaVersion": 1');
    expect(screen.getByText('Reload nginx safely')).toBeInTheDocument();
    expect(screen.getByText('runbook.secretPolicy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /runbook.reviewRun/ })).toBeDisabled();
  });
});
