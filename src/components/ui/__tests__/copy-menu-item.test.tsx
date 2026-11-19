import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CopyMenuItem } from '../copy-menu-item';
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from '../context-menu';

vi.mock('@/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

describe('copy menu feedback', () => {
  it('keeps labels aligned with adjacent menu rows before and after copying', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ContextMenu defaultOpen>
      <ContextMenuTrigger>Menu</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem>Open</ContextMenuItem>
          <CopyMenuItem text="complete text" label="Copy text" errorLabel="Copy failed" />
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>);
    const copy = screen.getByRole('menuitem', { name: 'Copy text' });
    const labels = [screen.getByText('Open'), screen.getByText('Copy text').parentElement];
    for (const label of labels) expect(label).toHaveClass('relative', 'top-px');
    await act(async () => { fireEvent.click(copy); });
    expect(copy).toHaveAccessibleName('common.copied');
    expect(screen.getByText('common.copied').parentElement).toBe(labels[1]);
    expect(labels[1]).toHaveClass('relative', 'top-px');
    expect(writeText).toHaveBeenCalledExactlyOnceWith('complete text');
    expect(screen.getByRole('menu')).toBeVisible();
  });
});
