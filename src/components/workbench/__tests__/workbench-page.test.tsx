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

  it('aligns title help popover triggers with 4px icon spacing and optical vertical centering', () => {
    const { getByRole } = render(
      <WorkbenchPageHeader
        icon={ServerIcon}
        title="Credentials"
        titleMeta={<button type="button" data-slot="popover-trigger">Help</button>}
      />,
    );

    const titleRow = getByRole('heading', { level: 1 }).parentElement;
    expect(titleRow).toHaveClass(
      'h-5',
      'items-center',
      'gap-2',
      '[&>[data-slot=popover-trigger]]:-ml-2',
      '[&>[data-slot=popover-trigger]]:size-5',
      '[&>[data-slot=popover-trigger]]:shrink-0',
      '[&>[data-slot=popover-trigger]_svg]:-translate-y-[0.5px]',
    );
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
