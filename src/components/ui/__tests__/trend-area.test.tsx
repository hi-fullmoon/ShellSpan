import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrendArea } from '../trend-area';

describe('TrendArea', () => {
  it('renders an svg with a line and an area path for two or more points', () => {
    const { container } = render(<TrendArea data={[10, 20, 15]} aria-label="Memory trend" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('path').length).toBe(2);
    expect(screen.getByRole('img', { name: /Memory trend/i })).toBe(svg);
  });

  it('applies the provided color class', () => {
    const { container } = render(
      <TrendArea data={[10, 20, 15]} className="text-app-primary" />,
    );
    expect(container.querySelector('svg')).toHaveClass('text-app-primary');
  });

  it('renders a placeholder instead of an svg with fewer than two points', () => {
    const { container } = render(<TrendArea data={[10]} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('···');
  });
});
