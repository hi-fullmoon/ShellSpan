import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AboutDialog } from '@/components/about-dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe('AboutDialog', () => {
  it('uses the file-manager dialog style without a confirm button', () => {
    render(<AboutDialog open onClose={vi.fn()} />);

    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).toHaveClass(
      'max-w-md',
      'data-open:animate-[dialog-fade-in_150ms_ease-out]',
      'data-closed:animate-[dialog-fade-out_150ms_ease-in]',
    );
    expect(content).not.toHaveClass('data-open:animate-in', 'data-closed:animate-out');
    expect(document.querySelector('[data-slot="about-content"]')).toHaveClass(
      'rounded-md',
      'border-app-border',
      'bg-app-surface-muted/30',
    );
    expect(document.querySelector('[data-slot="about-version-row"]')).toHaveTextContent(
      'about.version--',
    );
    expect(screen.queryByRole('button', { name: 'about.ok' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.close' })).toBeInTheDocument();
  });
});
