import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from '../input';
import { InputGroup, InputGroupInput } from '../input-group';
import { Textarea } from '../textarea';

describe('Input', () => {
  it('renders without shadow utilities', () => {
    render(<Input placeholder="Test input" />);
    const input = screen.getByPlaceholderText('Test input');
    expect(input).not.toHaveClass('shadow-sm');
    expect(input).not.toHaveClass('shadow');
    expect(input).not.toHaveClass('shadow-md');
    expect(input).not.toHaveClass('shadow-lg');
  });

  it('uses the shared input surface and border for single-line and multiline fields', () => {
    render(<><Input aria-label="Name" /><Textarea aria-label="Notes" /></>);

    for (const input of screen.getAllByRole('textbox')) {
      expect(input).toHaveClass('bg-input-surface', 'border-input');
    }
  });

  it('keeps the disabled input group border and dimming without a light fill', () => {
    render(<InputGroup><InputGroupInput aria-label="Name" disabled /></InputGroup>);

    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled();
    const group = screen.getByRole('group');
    expect(group).toHaveClass('border-input', 'has-[[data-slot=input-group-control]:disabled]:opacity-50');
    expect(group).not.toHaveClass('has-[[data-slot=input-group-control]:disabled]:bg-input/50');
  });

  it('disables browser autocomplete by default', () => {
    render(<Input placeholder="Test input" />);

    expect(screen.getByPlaceholderText('Test input')).toHaveAttribute(
      'autocomplete',
      'off',
    );
  });
});
