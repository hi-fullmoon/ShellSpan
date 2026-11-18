import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchSearchInput } from '../workbench-page';

describe('WorkbenchSearchInput', () => {
  it('wraps the search field in the shared compact input group', () => {
    render(<WorkbenchSearchInput aria-label="Search" value="" onChange={() => {}} />);

    const group = screen.getByRole('textbox', { name: 'Search' }).parentElement;
    expect(group).toHaveAttribute('data-slot', 'input-group');
    expect(group).toHaveClass('h-8');
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
