import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../copy-button';

vi.mock('@/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

describe('CopyButton', () => {
  it('centers active icon and label over a hidden sizing mirror before and after copying', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<CopyButton text="raw log" label="Copy" copiedLabel="Copied" size="xs" />);

    const button = screen.getByRole('button', { name: 'Copy' });
    const grid = button.firstElementChild as HTMLElement;
    expect(grid).toHaveClass('grid', 'place-items-center');
    expect(button.querySelector('.lucide-copy')).toBeInTheDocument();
    expect(button.querySelector('.lucide-check')).not.toBeInTheDocument();

    const [activeIdle, mirrorIdle] = Array.from(grid.children) as HTMLElement[];
    expect(activeIdle).toHaveClass('col-start-1', 'row-start-1', 'inline-flex', 'items-center', 'gap-1');
    expect(activeIdle).toHaveTextContent('Copy');
    expect(mirrorIdle).toHaveClass('invisible', 'col-start-1', 'row-start-1', 'inline-flex', 'items-center', 'gap-1');
    expect(mirrorIdle).toHaveAttribute('aria-hidden', 'true');
    expect(mirrorIdle).toHaveTextContent('Copied');

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledExactlyOnceWith('raw log');
    expect(button).toHaveAccessibleName('Copied');
    expect(button.querySelector('.lucide-check')).toBeInTheDocument();
    expect(button.querySelector('.lucide-copy')).not.toBeInTheDocument();

    const [activeCopied, mirrorCopied] = Array.from(grid.children) as HTMLElement[];
    expect(activeCopied).toHaveTextContent('Copied');
    expect(mirrorCopied).toHaveTextContent('Copy');
  });
});
