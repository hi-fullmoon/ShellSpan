import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Table } from '../table';

describe('Table', () => {
  it('keeps vertical overflow unchanged unless the caller overrides the container', () => {
    const { rerender } = render(<Table aria-label="Default table" />);

    expect(screen.getByRole('table').parentElement).not.toHaveClass('overflow-y-hidden');

    rerender(<Table aria-label="Scoped table" containerClassName="overflow-y-hidden" />);

    expect(screen.getByRole('table').parentElement).toHaveClass('overflow-y-hidden');
  });
});
