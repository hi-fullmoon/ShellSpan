import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToggleGroup, ToggleGroupItem } from '../toggle-group';

describe('ToggleGroup', () => {
  it('provides a borderless recessed tray and ring-free active pill for the surface variant', () => {
    render(
      <ToggleGroup aria-label="Editor view" variant="surface" spacing={0.5} value={['edit']} className="h-7">
        <ToggleGroupItem value="edit" className="h-6 px-2.5 text-xs">
          Edit
        </ToggleGroupItem>
        <ToggleGroupItem value="preview" className="h-6 px-2.5 text-xs">
          Preview
        </ToggleGroupItem>
      </ToggleGroup>,
    );

    const group = screen.getByRole('group', { name: 'Editor view' });
    expect(group).toHaveAttribute('data-variant', 'surface');
    expect(group).toHaveClass(
      'data-[variant=surface]:bg-muted/80',
      'data-[variant=surface]:p-0.5',
      'dark:data-[variant=surface]:bg-muted/50',
    );
    expect(group.className).not.toContain('border');

    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit).toHaveAttribute('aria-pressed', 'true');
    expect(edit).toHaveClass('aria-pressed:bg-card', 'dark:aria-pressed:bg-app-button');
    expect(edit.className).not.toContain('aria-pressed:ring-1');
  });
});
