import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ServerIcon } from 'lucide-react';
import {
  WorkbenchPageContent,
  WorkbenchPageHeader,
  WorkbenchPageToolbar,
} from '../workbench-page';

describe('WorkbenchPageContent', () => {
  it('fills the available workbench width by default', () => {
    const { getByRole } = render(
      <WorkbenchPageContent>Content</WorkbenchPageContent>,
    );

    const content = getByRole('main');
    expect(content).toHaveClass('w-full');
    expect(content).not.toHaveClass('max-w-screen-2xl');
  });

  it('allows individual pages to opt into a narrower content width', () => {
    const { getByRole } = render(
      <WorkbenchPageContent className="max-w-4xl">Content</WorkbenchPageContent>,
    );

    expect(getByRole('main')).toHaveClass('mx-auto', 'max-w-4xl');
  });

  it('keeps page padding on the compact 10px grid', () => {
    const { getByRole } = render(
      <WorkbenchPageContent>Content</WorkbenchPageContent>,
    );

    const content = getByRole('main');
    expect(content).toHaveClass('p-2.5', 'gap-3');
    expect(content).not.toHaveClass('p-3', 'sm:p-4');
  });
});

describe('WorkbenchPageHeader', () => {
  it('only lowers the single-row threshold for pages with compact actions', () => {
    const { container, rerender } = render(<WorkbenchPageHeader icon={ServerIcon} title="Connections" actions={<button>New</button>} />);
    const row = () => container.querySelector('header > div');
    expect(row()).toHaveClass('@min-[64rem]:flex-row');
    rerender(<WorkbenchPageHeader compactActions icon={ServerIcon} title="Connections" actions={<button>New</button>} />);
    expect(row()).toHaveClass('@min-[48rem]:flex-row');
    expect(row()).not.toHaveClass('@min-[64rem]:flex-row');
    expect(container.querySelector('[data-slot="workbench-page-header-actions"]')).toHaveClass('@min-[48rem]:h-8');
    rerender(<WorkbenchPageHeader compactActions={false} icon={ServerIcon} title="Logs" actions={<button>Refresh</button>} />);
    expect(row()).toHaveClass('@min-[64rem]:flex-row', '@min-[64rem]:items-center', '@min-[64rem]:justify-between');
    expect(row()).not.toHaveClass('@min-[48rem]:flex-row');
    expect(container.querySelector('[data-slot="workbench-page-header-copy"]')).toHaveClass('@min-[64rem]:flex-1');
    expect(container.querySelector('[data-slot="workbench-page-header-actions"]')).toHaveClass(
      '@min-[64rem]:m-0', '@min-[64rem]:h-8', '@min-[64rem]:shrink-0',
      '@min-[64rem]:overflow-visible', '@min-[64rem]:p-0', '@min-[64rem]:justify-end',
    );
    expect(container.querySelector('header')).not.toHaveAttribute('compactActions');
  });
  it('aligns with page content on the 10px grid and uses a compact title block', () => {
    const { container, getByRole } = render(
      <WorkbenchPageHeader icon={ServerIcon} title="Connections" />,
    );

    const header = getByRole('banner');
    expect(header).toHaveClass('px-2.5', 'py-1.5');
    expect(getByRole('heading', { level: 1 })).toHaveClass('text-sm');
    expect(container.querySelector('[data-slot="workbench-page-header-copy"] .size-8')).not.toBeNull();
    expect(container.querySelector('.size-9')).toBeNull();
  });
});

describe('WorkbenchPageToolbar', () => {
  it('keeps the toolbar row compact on the 10px grid', () => {
    const { container } = render(
      <WorkbenchPageToolbar>Filters</WorkbenchPageToolbar>,
    );

    const toolbar = container.querySelector('[data-slot="workbench-page-toolbar"]');
    expect(toolbar).toHaveClass('px-2.5', 'py-1');
  });
});
