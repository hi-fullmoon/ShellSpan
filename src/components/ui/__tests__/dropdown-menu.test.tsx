import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CopyIcon } from 'lucide-react';
import { ContextMenuItem } from '../context-menu';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuCheckboxItem, DropdownMenuShortcut,
} from '../dropdown-menu';

describe('menu text alignment', () => {
  it('shares compact typography and spacing with context menu rows', () => {
    render(<DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuItem>Default</DropdownMenuItem>
          <DropdownMenuItem size="sm">Compact</DropdownMenuItem>
          <ContextMenuItem>Context</ContextMenuItem>
          <DropdownMenuItem size="sm" variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>);
    for (const name of ['Compact', 'Context', 'Delete']) {
      expect(screen.getByRole('menuitem', { name })).toHaveClass('text-xs', 'leading-4', 'px-2.5', 'py-1.5');
    }
    expect(screen.getByRole('menuitem', { name: 'Default' })).toHaveClass('text-sm');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-variant', 'destructive');
  });

  it('adjusts text once while preserving icons, composed content and accessible names', () => {
    render(<DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuItem><CopyIcon />Copy<DropdownMenuShortcut aria-hidden>⌘C</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuItem><CopyIcon /><span className="relative top-px">Existing</span></DropdownMenuItem>
          <DropdownMenuItem><span className="flex flex-col"><span>Title</span><span>Description</span></span></DropdownMenuItem>
          <DropdownMenuCheckboxItem checked><CopyIcon />Checked</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="one">
            <DropdownMenuRadioItem value="one"><CopyIcon />One</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>);
    for (const name of ['Copy', 'Checked', 'One']) {
      const label = screen.getByText(name);
      expect(label).toHaveAttribute('data-slot', 'menu-item-label');
      expect(label).toHaveClass('relative', 'top-px');
    }
    expect(screen.getByRole('menuitem', { name: 'Copy' }).querySelector('svg')).not.toHaveClass('top-px');
    expect(screen.getByText('⌘C')).toHaveClass('top-px');
    expect(screen.getByText('Existing').parentElement).toHaveAttribute('role', 'menuitem');
    expect(screen.getByText('Title').parentElement).not.toHaveClass('top-px');
  });
});
