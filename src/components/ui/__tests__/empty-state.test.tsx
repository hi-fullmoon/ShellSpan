import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState, PanelEmptyState } from '../empty-state';

describe('PanelEmptyState', () => {
  it('grows into the available panel height so its content is vertically centered', () => {
    const { container } = render(<PanelEmptyState title="Nothing here" />);

    const panel = container.querySelector('[data-slot="panel-empty-state"]');
    expect(panel).toHaveClass(
      'flex',
      'min-h-0',
      'flex-1',
      'items-center',
      'justify-center',
    );
    expect(panel).not.toHaveClass('h-full');
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('uses compact, muted typography on small surfaces', () => {
    const { container } = render(<EmptyState title="No matches" size="sm" />);

    expect(container.querySelector('[data-slot="empty-state"]')).toHaveClass('gap-1', 'p-2');
    expect(screen.getByText('No matches')).toHaveClass(
      'text-xs',
      'leading-5',
      'font-normal',
      'text-muted-foreground',
    );
  });
});
