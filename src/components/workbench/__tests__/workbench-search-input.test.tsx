import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchSearchInput } from '../workbench-page';

describe('WorkbenchSearchInput', () => {
  it('uses the shared input-group focus treatment', () => {
    render(<WorkbenchSearchInput aria-label="Search" value="" onChange={() => {}} />);

    const group = screen.getByRole('textbox', { name: 'Search' }).parentElement;
    expect(group).toHaveClass(
      'h-8',
      'has-[[data-slot=input-group-control]:focus-visible]:border-input',
      'has-[[data-slot=input-group-control]:focus-visible]:ring-1',
      'has-[[data-slot=input-group-control]:focus-visible]:ring-ring',
    );
    expect(group).not.toHaveClass(
      'has-[[data-slot=input-group-control]:focus-visible]:border-ring',
      'has-[[data-slot=input-group-control]:focus-visible]:ring-3',
    );
  });

  it('keeps the optional clear action inside the shared focus container', () => {
    const onClear = vi.fn();
    render(
      <WorkbenchSearchInput
        aria-label="Search"
        value="term"
        onChange={() => {}}
        onClear={onClear}
        clearLabel="Clear search"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(onClear).toHaveBeenCalledOnce();
  });
});
