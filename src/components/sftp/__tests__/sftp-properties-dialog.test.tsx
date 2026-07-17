import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SftpPropertiesDialog } from '@/components/sftp/sftp-properties-dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    locale: 'zh-CN',
    t: (key: string) => key,
  }),
}));

describe('SftpPropertiesDialog', () => {
  it('uses a restrained radius for the inner property content', () => {
    render(
      <SftpPropertiesDialog
        entry={{
          name: 'notes.txt',
          path: '/tmp/notes.txt',
          kind: 'file',
          size: 12,
          modifiedAt: 0,
        }}
        open
        onClose={vi.fn()}
      />,
    );

    expect(
      document.querySelector('[data-slot="properties-content"]'),
    ).toHaveClass('rounded-md');
  });
});
