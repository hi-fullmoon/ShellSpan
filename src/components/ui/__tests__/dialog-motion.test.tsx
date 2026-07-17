import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('DialogContent motion', () => {
  it('uses opacity-only animation by default', () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).toHaveClass(
      'data-open:animate-[dialog-fade-in_150ms_ease-out]',
      'data-closed:animate-[dialog-fade-out_150ms_ease-in]',
    );
    expect(content).not.toHaveClass('data-open:animate-in', 'data-closed:animate-out');
  });
});
