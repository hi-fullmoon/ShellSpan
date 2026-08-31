import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PanelEmptyState } from '../empty-state';

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
});
