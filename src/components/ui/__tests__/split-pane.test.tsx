import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SplitPane } from '../split-pane';

describe('SplitPane', () => {
  it('renders left and right content', () => {
    const { container } = render(
      <SplitPane
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
      />,
    );
    expect(screen.getByTestId('left')).toBeInTheDocument();
    expect(screen.getByTestId('right')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="split-pane-divider"]')).toHaveClass(
      'border-l',
      'border-app-border',
      'shadow-none',
    );
    expect(container.querySelector('[data-slot="split-pane-handle"]')).toHaveClass(
      'w-[3px]',
      'bg-transparent',
      'shadow-none',
    );
    expect(
      container.querySelector('[data-slot="split-pane-indicator"]'),
    ).toHaveClass('w-px', 'bg-transparent', 'shadow-none');
  });
});
