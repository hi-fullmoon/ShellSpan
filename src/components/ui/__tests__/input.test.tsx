import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from '../input';

describe('Input', () => {
  it('renders without shadow utilities', () => {
    render(<Input placeholder="Test input" />);
    const input = screen.getByPlaceholderText('Test input');
    expect(input).not.toHaveClass('shadow-sm');
    expect(input).not.toHaveClass('shadow');
    expect(input).not.toHaveClass('shadow-md');
    expect(input).not.toHaveClass('shadow-lg');
  });

  it('uses a single focus ring', () => {
    render(<Input placeholder="Test input" />);
    const input = screen.getByPlaceholderText('Test input');
    expect(input).toHaveClass('focus-visible:ring-1');
    expect(input).not.toHaveClass('focus-visible:ring-2');
  });

  it('disables browser autocomplete by default', () => {
    render(<Input placeholder="Test input" />);

    expect(screen.getByPlaceholderText('Test input')).toHaveAttribute(
      'autocomplete',
      'off',
    );
  });
});
