import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionList } from '../connection-list';
import type { ConnectionProfile } from '@/types';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { saveConnectionSort } from '@/lib/connections/connection-sort';
import {
  readConnectionViewMode,
  saveConnectionViewMode,
} from '@/lib/connections/connection-view';
import { saveLocalState } from '@/lib/preferences/local-state';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

const makeProfile = (overrides?: Partial<ConnectionProfile>): ConnectionProfile => ({
  id: 'p1',
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: 'secret',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe('ConnectionList', () => {
  beforeEach(() => {
    saveConnectionSort('default');
    saveConnectionViewMode('card');
    useRecentProfilesStore.setState({ recentIds: [], initialized: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an empty state with a new-connection button when there are no profiles', () => {
    const onAdd = vi.fn();
    const onImport = vi.fn();
    const onExport = vi.fn();
    render(
      <ConnectionList
        profiles={[]}
        initialized={true}
        onAdd={onAdd}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={onImport}
        onExport={onExport}
      />,
    );

    expect(screen.getByText('workbench.connections.empty')).toBeInTheDocument();
    expect(
      screen.getByText('workbench.connections.emptyDescription'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'workbench.connections.new' }),
    ).toBeInTheDocument();
    const actionNames = [
      'workbench.connections.new',
      'workbench.connections.actions',
    ];
    const more = screen.getByRole('button', { name: 'workbench.connections.actions' });
    const headerActions = more.closest('[data-slot="workbench-page-header-actions"]');
    expect(within(headerActions as HTMLElement).getAllByRole('button')).toEqual(actionNames.map(name => screen.getByRole('button', { name })));
    expect(more).toHaveClass('size-8', 'bg-secondary', 'focus-visible:bg-accent', 'data-popup-open:bg-accent');
    expect(more).toHaveTextContent('');
    expect(more).not.toHaveClass('border', 'bg-background');
    for (const name of actionNames) {
      const button = screen.getByRole('button', { name });
      expect(button.querySelector('[data-icon="inline-start"]')).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'workbench.connections.import' })).not.toBeInTheDocument();
    fireEvent.click(more);
    expect(screen.getByRole('menuitem', { name: 'workbench.connections.import' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'workbench.connections.export' })).toBeInTheDocument();
    expect(screen.getByRole('menu')).toHaveClass('w-max', 'min-w-0');
    fireEvent.click(screen.getByRole('menuitem', { name: 'workbench.connections.import' }));
    expect(onImport).toHaveBeenCalledOnce();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'workbench.connections.export' }));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('falls back to the host for blank names and keeps key authentication separate from group labels', () => {
    render(<ConnectionList
      profiles={[makeProfile({ name: '  ', authMethod: 'key', group: 'Work' })]}
      initialized onAdd={() => {}} onEdit={() => {}} onDelete={() => {}}
      onConnectTerminal={() => {}} onConnectSftp={() => {}} onDuplicate={() => {}}
      onToggleFavorite={() => {}} onImport={() => {}} onExport={() => {}}
    />);
    expect(screen.getByText('192.168.1.1')).toHaveClass('font-medium');
    expect(screen.getByLabelText('connection.form.auth.key').querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('Work').closest('[data-slot="badge"]')).not.toBeNull();
    expect(screen.getByLabelText('connection.form.auth.key').parentElement).toHaveClass('min-w-0', 'flex-nowrap');
    expect(screen.getByLabelText('connection.form.auth.key').parentElement).not.toHaveClass('shrink-0');
  });

  it.each(['default', 'name', 'recent', 'created'] as const)('ignores saved %s sorting and keeps filtering in profile order', async (mode) => {
    saveConnectionSort(mode);
    useRecentProfilesStore.setState({ recentIds: ['a', 'z'] });
    const profiles = [
      makeProfile({ id: 'z', name: 'Zulu', favorite: true, group: 'team', createdAt: 10 }),
      makeProfile({ id: 'a', name: 'Alpha', favorite: true, group: 'team', createdAt: 30 }),
      makeProfile({ id: 'b', name: 'Beta', group: 'other', createdAt: 20 }),
    ];
    const onConnectTerminal = vi.fn();
    const onConnectSftp = vi.fn();
    const { container } = render(<ConnectionList
      profiles={profiles} initialized onAdd={() => {}} onEdit={() => {}} onDelete={() => {}}
      onConnectTerminal={onConnectTerminal} onConnectSftp={onConnectSftp} onDuplicate={() => {}}
      onToggleFavorite={() => {}} onImport={() => {}} onExport={() => {}}
    />);
    const names = () => Array.from(container.querySelectorAll('[data-connection-text="name"]')).map(el => el.textContent);
    expect(screen.queryByRole('button', { name: 'workbench.connections.sortLabel' })).not.toBeInTheDocument();
    expect(names()).toEqual(['Zulu', 'Alpha', 'Beta']);
    const groupTrigger = screen.getByRole('combobox', { name: 'workbench.connections.groupFilter' });
    expect(groupTrigger).toHaveClass('h-6', 'max-w-40', 'min-w-0', 'gap-1');
    const separator = groupTrigger.previousElementSibling;
    expect(separator).toHaveAttribute('data-slot', 'separator');
    expect(separator).toHaveAttribute('aria-hidden', 'true');
    expect(separator).toHaveClass('mx-0.5', 'h-3', 'data-vertical:self-center');
    expect(groupTrigger).not.toHaveClass('ml-auto', 'w-40', 'border', 'bg-secondary');
    expect(groupTrigger).toHaveTextContent('workbench.connections.allGroups');
    expect(groupTrigger.querySelector('[data-slot="select-value"]')).toHaveClass('truncate');
    expect(groupTrigger.querySelector('[data-icon="inline-start"]')).not.toBeInTheDocument();
    expect(groupTrigger.querySelector('[data-icon="inline-end"]')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'workbench.connections.connectTerminal' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'workbench.connections.connectSftp' })[0]);
    expect(onConnectTerminal).toHaveBeenCalledWith(profiles[0]);
    expect(onConnectSftp).toHaveBeenCalledWith(profiles[0]);
    for (const filter of ['favorites', 'recent']) {
      fireEvent.click(screen.getByRole('button', { name: `workbench.connections.filter.${filter}` }));
      expect(names()).toEqual(['Zulu', 'Alpha']);
    }
    fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.filter.all' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'workbench.connections.groupFilter' }));
    await userEvent.click(await screen.findByRole('option', { name: 'team' }));
    expect(groupTrigger).toHaveTextContent('team');
    expect(groupTrigger).toHaveClass('bg-secondary');
    expect(names()).toEqual(['Zulu', 'Alpha']);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Alpha' } });
    expect(names()).toEqual(['Alpha']);
  });

  it('combines multiple tag alternatives with group, activity and search filters, and clears them', async () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'Alpha', group: 'Work', tags: ['production', 'database'], favorite: true }),
      makeProfile({ id: 'b', name: 'Beta', group: 'Home', tags: ['staging'], favorite: true }),
      makeProfile({ id: 'c', name: 'Gamma', group: 'Work', tags: ['staging'] }),
      makeProfile({ id: 'd', name: 'Delta', group: 'Work' }),
    ];
    const { container, rerender } = render(<ConnectionList
      profiles={profiles} initialized onAdd={() => {}} onEdit={() => {}} onDelete={() => {}}
      onConnectTerminal={() => {}} onConnectSftp={() => {}} onDuplicate={() => {}}
      onToggleFavorite={() => {}} onImport={() => {}} onExport={() => {}}
    />);
    const names = () => Array.from(container.querySelectorAll('[data-connection-text="name"]')).map(el => el.textContent);
    const trigger = screen.getByRole('button', { name: 'workbench.connections.tagFilter' });
    expect(trigger).toHaveClass('h-6', 'max-w-40', 'min-w-0', 'gap-1');
    expect(trigger).not.toHaveClass('border', 'bg-secondary');
    expect(trigger).toHaveTextContent('workbench.connections.allTags');
    await userEvent.click(trigger);
    const productionTag = await screen.findByRole('menuitemcheckbox', { name: 'production' });
    expect(screen.getByRole('menu')).toHaveClass('w-max', 'max-w-[min(16rem,var(--available-width))]');
    expect(within(productionTag).getByTitle('production')).toHaveClass('min-w-0', 'truncate');
    await userEvent.click(productionTag);
    expect(trigger).toHaveTextContent('production');
    expect(trigger).toHaveClass('bg-secondary');
    expect(names()).toEqual(['Alpha']);
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'staging' }));
    expect(trigger).toHaveTextContent('workbench.connections.selectedTags');
    expect(screen.getByRole('menuitemcheckbox', { name: 'production' })).toBeChecked();
    expect(screen.getByRole('menuitemcheckbox', { name: 'staging' })).toBeChecked();
    expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']);
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await userEvent.click(screen.getByRole('combobox', { name: 'workbench.connections.groupFilter' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Work' }));
    expect(names()).toEqual(['Alpha', 'Gamma']);
    await userEvent.click(screen.getByRole('button', { name: 'workbench.connections.filter.favorites' }));
    expect(names()).toEqual(['Alpha']);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Gamma' } });
    expect(names()).toEqual([]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'workbench.connections.filter.all' }));
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'production' }));
    expect(names()).toEqual(['Gamma']);
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'workbench.connections.allTags' }));
    expect(names()).toEqual(['Alpha', 'Gamma', 'Delta']);
    expect(trigger).toHaveTextContent('workbench.connections.allTags');
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'production' }));
    await userEvent.keyboard('{Escape}');
    rerender(<ConnectionList
      profiles={profiles.map(profile => ({ ...profile, tags: undefined }))} initialized
      onAdd={() => {}} onEdit={() => {}} onDelete={() => {}} onConnectTerminal={() => {}}
      onConnectSftp={() => {}} onDuplicate={() => {}} onToggleFavorite={() => {}} onImport={() => {}} onExport={() => {}}
    />);
    expect(screen.queryByRole('button', { name: 'workbench.connections.tagFilter' })).not.toBeInTheDocument();
    expect(names()).toEqual(['Alpha', 'Gamma', 'Delta']);
  });

  it('keeps every advertised search field searchable without changing the selected profile', () => {
    const profile = makeProfile({
      name: 'Production', host: 'server.example.org', username: 'operator', port: 2222,
      group: 'Operations', tags: ['critical'], notes: 'nightly backup',
      jumpHost: { host: 'bastion.example.org', username: 'gateway', port: 22, authMethod: 'password' },
    });
    const onConnectTerminal = vi.fn();
    render(<ConnectionList
      profiles={[profile]} initialized onAdd={() => {}} onEdit={() => {}} onDelete={() => {}}
      onConnectTerminal={onConnectTerminal} onConnectSftp={() => {}} onDuplicate={() => {}}
      onToggleFavorite={() => {}} onImport={() => {}} onExport={() => {}}
    />);
    const search = screen.getByRole('textbox');
    for (const query of ['production', 'SERVER.EXAMPLE', 'operator', '2222', 'bastion', 'gateway', 'Operations', 'critical', 'nightly']) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getByText('Production')).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.connectTerminal' }));
    expect(onConnectTerminal).toHaveBeenCalledWith(profile);
    fireEvent.change(search, { target: { value: 'does not match' } });
    expect(screen.getByText('workbench.connections.filteredEmpty')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByText('Production')).toBeInTheDocument();
  });

  it('calls onAdd when the empty-state new-connection button is clicked', () => {
    const onAdd = vi.fn();
    render(
      <ConnectionList
        profiles={[]}
        initialized={true}
        onAdd={onAdd}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'workbench.connections.new' }),
    );

    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('provides an accessible name for connection search without a native tooltip', () => {
    render(
      <ConnectionList
        profiles={[]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    const search = screen.getByRole('textbox', {
      name: 'workbench.connections.searchPlaceholder',
    });
    expect(search).toHaveAttribute('data-slot', 'input-group-control');
    expect(search.parentElement).toHaveAttribute('data-slot', 'input-group');
    expect(search).not.toHaveAttribute('title');
  });

  it('renders the profile list in an auto-fill grid that scales columns on wide viewports', () => {
    const { container } = render(
      <ConnectionList
        profiles={[makeProfile()]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    expect(screen.getByText('My Server')).toBeInTheDocument();
    expect(screen.getByText('My Server')).toHaveClass('font-medium');
    expect(screen.getByText('root@192.168.1.1:22')).toHaveClass('text-muted-foreground');
    const auth = screen.getByLabelText('connection.form.auth.password');
    expect(auth).toHaveAttribute('tabindex', '0');
    expect(auth.querySelector('svg')).toBeInTheDocument();
    expect(auth).not.toHaveAttribute('data-slot', 'badge');
    expect(
      screen.queryByText('workbench.connections.empty'),
    ).not.toBeInTheDocument();

    const grid = container.querySelector('.grid');
    expect(grid).toHaveClass('w-full', 'grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))]', 'gap-2');
    expect(grid).not.toHaveAttribute('style');
    expect(grid).not.toHaveClass('items-start');
  });

  it('keeps labels on one line and exposes all tags through the overflow popover', async () => {
    const tags = ['Api', 'linux', 'tag', 'test', 'test2', 'test3', 'a-very-long-tag-that-exceeds-the-label-area'];
    const { container } = render(<ConnectionList
      profiles={[makeProfile({ group: 'Development', tags })]} initialized
      onAdd={() => {}} onEdit={() => {}} onDelete={() => {}}
      onConnectTerminal={() => {}} onConnectSftp={() => {}} onDuplicate={() => {}}
      onToggleFavorite={() => {}} onImport={() => {}} onExport={() => {}}
    />);
    expect(container.querySelector('[data-slot="connection-identity"]')).toHaveClass('min-w-[50%]');
    expect(container.querySelector('[data-slot="connection-labels"]')).toHaveClass('flex-nowrap', 'max-w-[45%]');
    expect(screen.getByText('My Server')).toBeInTheDocument();
    expect(screen.getByText('root@192.168.1.1:22')).toBeInTheDocument();
    for (const label of ['Development', tags[0]]) {
      expect(screen.getByText(label)).toHaveClass('truncate');
      expect(screen.getByText(label)).not.toHaveAttribute('title');
      expect(screen.getByText(label).closest('[data-slot="badge"]')).toHaveClass(label === 'Development' ? 'max-w-[min(6rem,40%)]' : 'max-w-24');
    }
    expect(screen.getByText('Development').closest('[data-slot="badge"]')).toHaveClass('shrink-0');
    expect(container.querySelector('.group')).toHaveClass('@container/connection-card');
    expect(screen.getByText(tags[0]).closest('[data-slot="badge"]')).toHaveClass('hidden', '@min-[25rem]/connection-card:inline-flex');
    expect(screen.queryByText('linux')).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: 'workbench.connections.moreTags' });
    expect(within(more).getByText('+7')).toHaveClass('@min-[25rem]/connection-card:hidden');
    expect(within(more).getByText('+6')).toHaveClass('hidden', '@min-[25rem]/connection-card:inline');
    await userEvent.click(more);
    const popover = await screen.findByRole('dialog', { name: 'connection.form.tags' });
    for (const tag of tags) {
      const text = within(popover).getByText(tag);
      expect(text).toHaveClass('truncate');
      expect(text).not.toHaveAttribute('title');
      expect(text.closest('[data-slot="badge"]')).toHaveClass('max-w-24');
    }
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'connection.form.tags' })).not.toBeInTheDocument());
    expect(more).toHaveFocus();
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('keeps connection-card actions aligned at the bottom of equal-height rows', () => {
    render(
      <ConnectionList
        profiles={[
          makeProfile({ id: 'with-notes', name: 'Host with notes', notes: 'Personal host' }),
          makeProfile({ id: 'without-notes', name: 'Host without notes' }),
          makeProfile({ id: 'blank-notes', name: 'Host with blank notes', notes: '   ' }),
        ]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    const terminalActions = screen.getAllByRole('button', {
      name: 'workbench.connections.connectTerminal',
    });
    expect(terminalActions).toHaveLength(3);
    terminalActions.forEach((action) => {
      expect(action.closest('.mt-auto')).not.toBeNull();
    });
    for (const name of ['Host with notes', 'Host without notes', 'Host with blank notes']) {
      const card = screen.getByText(name).closest('.group');
      const notes = card?.querySelector('[data-slot="connection-notes"]');
      expect(notes).toHaveClass('min-h-4');
      if (name !== 'Host with notes') {
        expect(notes).toBeEmptyDOMElement();
        expect(notes?.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
      }
    }
  });

  it('keeps connection notes on one line without a native title tooltip', () => {
    const notes = 'Personal server used for deployment and monitoring';
    render(
      <ConnectionList
        profiles={[makeProfile({ notes })]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    const note = screen.getByText(notes);
    expect(note).toHaveClass('truncate');
    expect(note).not.toHaveClass('line-clamp-2');
    expect(note).not.toHaveAttribute('title');
  });

  it('shows the full connection notes in a tooltip when they overflow', async () => {
    const notes = 'A long operational note that does not fit on one line';
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
      function getScrollWidth(this: HTMLElement) {
        return this.textContent === notes ? 320 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function getClientWidth(this: HTMLElement) {
        return this.textContent === notes ? 120 : 0;
      },
    );

    render(
      <ConnectionList
        profiles={[makeProfile({ notes })]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    await userEvent.hover(screen.getByText(notes));

    await waitFor(() => {
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(notes);
    });
  });

  it('does not show a connection-notes tooltip when the text fits', async () => {
    const notes = 'Short note';
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
      function getScrollWidth(this: HTMLElement) {
        return this.textContent === notes ? 120 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function getClientWidth(this: HTMLElement) {
        return this.textContent === notes ? 120 : 0;
      },
    );

    render(
      <ConnectionList
        profiles={[makeProfile({ notes })]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    await userEvent.hover(screen.getByText(notes));

    expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeInTheDocument();
  });

  it('debounces repeated clicks on every profile-card action', () => {
    vi.useFakeTimers();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onConnectTerminal = vi.fn();
    const onConnectSftp = vi.fn();
    const onDuplicate = vi.fn();
    const onToggleFavorite = vi.fn();
    render(
      <ConnectionList
        profiles={[makeProfile()]}
        initialized={true}
        onAdd={() => {}}
        onEdit={onEdit}
        onDelete={onDelete}
        onConnectTerminal={onConnectTerminal}
        onConnectSftp={onConnectSftp}
        onDuplicate={onDuplicate}
        onToggleFavorite={onToggleFavorite}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    const actions = [
      ['workbench.connections.connectTerminal', onConnectTerminal, false],
      ['workbench.connections.connectSftp', onConnectSftp, false],
      ['common.edit', onEdit, true],
      ['common.duplicate', onDuplicate, true],
      ['workbench.connections.favorite', onToggleFavorite, true],
      ['common.delete', onDelete, true],
    ] as const;

    const clickAction = (accessibleName: string, inMenu: boolean): void => {
      if (!inMenu) {
        fireEvent.click(screen.getByRole('button', { name: accessibleName }));
        return;
      }
      fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.moreActions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: accessibleName }));
    };

    for (const [accessibleName, handler, inMenu] of actions) {
      clickAction(accessibleName, inMenu);
      act(() => vi.advanceTimersByTime(100));
      clickAction(accessibleName, inMenu);
      expect(handler).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(400));
      clickAction(accessibleName, inMenu);
      expect(handler).toHaveBeenCalledTimes(2);
    }
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
  });

  it('filters connection assets by favorite and recent activity', () => {
    useRecentProfilesStore.setState({ recentIds: ['recent'] });
    render(
      <ConnectionList
        profiles={[
          makeProfile({ id: 'favorite', name: 'Favorite Host', favorite: true }),
          makeProfile({ id: 'recent', name: 'Recent Host' }),
        ]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.filter.favorites' }));
    expect(screen.getByText('Favorite Host')).toBeInTheDocument();
    expect(screen.queryByText('Recent Host')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.filter.recent' }));
    expect(screen.queryByText('Favorite Host')).not.toBeInTheDocument();
    expect(screen.getByText('Recent Host')).toBeInTheDocument();
  });

  it('opens a live host overview from the connection card', () => {
    render(
      <ConnectionList
        profiles={[makeProfile()]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.moreActions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'hostOverview.open' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('hostOverview.title')).toBeInTheDocument();
    expect(screen.getByText('My Server · root@192.168.1.1:22')).toBeInTheDocument();
    expect(screen.getByText('hostOverview.forwardsDetail')).toBeInTheDocument();
  });

  it('opens remote health for the exact connection profile', () => {
    const onOpenHealth = vi.fn();
    const profile = makeProfile({ id: 'health-profile' });
    render(
      <ConnectionList
        profiles={[profile]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onOpenHealth={onOpenHealth}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'workbench.connections.moreActions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'remoteHealth.open' }));

    expect(onOpenHealth).toHaveBeenCalledOnce();
    expect(onOpenHealth).toHaveBeenCalledWith(profile);
  });

  it('shows at most two direct action icons and groups the rest under more', () => {
    render(
      <ConnectionList
        profiles={[makeProfile()]}
        initialized={true}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    const card = screen.getByText('My Server').closest('.group');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getAllByRole('button')).toHaveLength(3);
    const terminalButton = within(card as HTMLElement).getByRole('button', {
      name: 'workbench.connections.connectTerminal',
    });
    expect(terminalButton).not.toHaveTextContent('workbench.connections.connectTerminal');
    expect(terminalButton).not.toHaveClass('bg-app-button', 'border');
    expect(within(card as HTMLElement).getByRole('button', {
      name: 'workbench.connections.connectSftp',
    })).not.toHaveTextContent('workbench.connections.connectSftp');

    const moreButton = within(card as HTMLElement).getByRole('button', {
      name: 'workbench.connections.moreActions',
    });
    expect(moreButton).not.toHaveTextContent('workbench.connections.moreActions');
    fireEvent.click(moreButton);

    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass(
      'border-app-border',
      'bg-app-surface',
      'shadow-[var(--shadow-dialog)]',
      'ring-0',
    );
    const separators = menu.querySelectorAll('[data-slot="dropdown-menu-separator"]');
    expect(separators).toHaveLength(2);
    separators.forEach((separator) => {
      expect(separator).toHaveClass('mx-0');
      expect(separator).not.toHaveClass('-mx-1');
    });

    const menuActionNames = [
      'workbench.connections.favorite',
      'common.edit',
      'common.duplicate',
      'remoteHealth.open',
      'portForward.open',
      'hostQuickActions.open',
      'hostOverview.open',
      'common.delete',
    ];

    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(menuActionNames);
    expect(Array.from(menu.querySelectorAll('[data-slot="dropdown-menu-group"]')).map(
      (group) => within(group as HTMLElement).getAllByRole('menuitem').map((item) => item.textContent),
    )).toEqual([menuActionNames.slice(0, 3), menuActionNames.slice(3, 7), menuActionNames.slice(7)]);

    for (const name of menuActionNames) {
      const item = screen.getByRole('menuitem', { name });
      expect(item).toHaveClass('items-center', 'gap-1', "[&_svg:not([class*='size-'])]:size-3.5", '[&>svg]:self-center');
      expect(item).toHaveClass(name === 'common.delete' ? '[&>svg]:translate-y-[0.5px]' : '[&>svg]:translate-y-px');
      expect(item.querySelectorAll(':scope > svg')).toHaveLength(1);
      expect(item.querySelector(':scope > span')).toHaveClass('relative', 'top-px');
    }
    expect(screen.getByRole('menuitem', { name: 'common.delete' })).toHaveAttribute('data-variant', 'destructive');
    expect(screen.queryByRole('menuitem', { name: 'deployment.openForHost' })).not.toBeInTheDocument();
  });

  it('renders the sandbox badge in the card footer row without crowding header labels', () => {
    const { container } = render(
      <ConnectionList
        profiles={[
          makeProfile({
            name: 'Production API',
            group: 'Production',
            tags: ['api', 'critical'],
            sandboxMode: 'workspaceWrite',
            jumpHost: { host: 'bastion.example.com', username: 'jump', port: 22, authMethod: 'agent' },
          }),
        ]}
        initialized
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    const sandboxBadge = container.querySelector('[data-connection-sandbox-mode="workspaceWrite"]');
    expect(sandboxBadge).not.toBeNull();
    expect(sandboxBadge?.closest('[data-slot="connection-labels"]')).toBeNull();
    expect(sandboxBadge?.closest('.mt-auto')).not.toBeNull();
    expect(sandboxBadge).toHaveClass('min-w-0', 'shrink');
    expect(screen.getByText('connection.form.jumpHost', { selector: 'span' }).closest('[data-slot="badge"]')).toHaveClass(
      'hidden',
      '@min-[25rem]/connection-card:inline-flex',
    );
  });

  it('renders distinct translated labels and SVG icons for agent and keyboardInteractive auth methods', () => {
    render(
      <ConnectionList
        profiles={[
          makeProfile({ id: 'p-agent', name: 'Agent Host', authMethod: 'agent' }),
          makeProfile({ id: 'p-kbd', name: 'Interactive Host', authMethod: 'keyboardInteractive' }),
        ]}
        initialized
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    expect(screen.getByLabelText('connection.form.auth.agent').querySelector('svg')).toBeInTheDocument();
    expect(screen.getByLabelText('connection.form.auth.keyboardInteractive').querySelector('svg')).toBeInTheDocument();
  });

  it('switches between card and table views and persists the selection locally', async () => {
    const profiles = [
      makeProfile({
        id: 'p1',
        name: 'Production API',
        host: '10.0.0.10',
        port: 2222,
        username: 'deploy',
        authMethod: 'key',
        favorite: true,
        group: 'Production',
        tags: ['api', 'critical', 'eu-west'],
        notes: 'Primary production gateway',
        sandboxMode: 'workspaceWrite',
        jumpHost: { host: 'bastion.example.com', username: 'jump', port: 22, authMethod: 'agent' },
      }),
      makeProfile({
        id: 'p2',
        name: 'Staging Box',
        host: '10.0.0.2',
        port: 22,
        username: 'root',
        authMethod: 'password',
      }),
    ];
    const onConnectTerminal = vi.fn();
    const onConnectSftp = vi.fn();
    const onEdit = vi.fn();

    const { unmount } = render(
      <ConnectionList
        profiles={profiles}
        initialized
        onAdd={() => {}}
        onEdit={onEdit}
        onDelete={() => {}}
        onConnectTerminal={onConnectTerminal}
        onConnectSftp={onConnectSftp}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    const viewGroup = screen.getByRole('group', { name: 'workbench.connections.viewMode' });
    expect(viewGroup).toHaveClass('ml-auto', 'h-6');
    const cardToggle = within(viewGroup).getByRole('button', { name: 'workbench.connections.view.card' });
    const tableToggle = within(viewGroup).getByRole('button', { name: 'workbench.connections.view.table' });
    expect(cardToggle).toHaveAttribute('aria-pressed', 'true');
    expect(tableToggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await userEvent.click(tableToggle);

    expect(readConnectionViewMode()).toBe('table');
    expect(tableToggle).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table', { name: 'workbench.connections.title' });
    expect(table).toBeInTheDocument();
    expect(table.closest('[data-slot="connection-table"]')).toHaveClass(
      '[&_table]:border-separate',
      '[&_table]:border-spacing-0',
    );
    const tableRows = within(table).getAllByRole('row');
    expect(tableRows).toHaveLength(3);
    expect(tableRows[0]).toHaveClass('bg-muted/75', 'dark:bg-muted/80');
    expect(tableRows[0]).not.toHaveClass('bg-background');
    expect(tableRows[1]).toHaveClass('bg-card', 'dark:bg-background');
    const columnHeaders = within(tableRows[0]).getAllByRole('columnheader');
    expect(columnHeaders[0]).toHaveClass('border-b', 'border-app-border', 'font-semibold', 'text-muted-foreground');
    const firstRowCells = within(tableRows[1]).getAllByRole('cell');
    expect(firstRowCells[0]).toHaveClass('border-b', 'border-app-border/45');
    expect(firstRowCells[firstRowCells.length - 1]).toHaveClass('border-b', 'border-app-border/45');
    expect(table.querySelector('[data-connection-text="address"]')).toHaveTextContent('deploy@10.0.0.10:2222');
    const narrowAddressFallback = within(table).getAllByText('deploy@10.0.0.10:2222').find(
      (element) => element.getAttribute('data-connection-text') !== 'address',
    );
    expect(narrowAddressFallback).toHaveClass('@min-[36rem]:hidden');
    expect(within(table).getByText('connection.form.jumpHost: jump@bastion.example.com:22')).toBeInTheDocument();
    expect(within(table).getByText('connection.form.auth.key')).toBeInTheDocument();
    expect(within(table).getByText('Production')).toBeInTheDocument();
    expect(within(table).getByText('Primary production gateway')).toBeInTheDocument();
    expect(table.querySelector('[data-connection-sandbox-mode="workspaceWrite"]')).not.toBeNull();
    expect(table.querySelector('[title]')).toBeNull();

    // Overflow tags popover works in table view
    const moreTags = within(table).getByRole('button', { name: 'workbench.connections.moreTags' });
    expect(moreTags).toHaveTextContent('+2');
    await userEvent.click(moreTags);
    const tagPopover = await screen.findByRole('dialog', { name: 'connection.form.tags' });
    expect(within(tagPopover).getByText('eu-west')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    // Direct actions and dropdown menu work in table view
    const firstRow = within(table).getAllByRole('row')[1];
    fireEvent.click(within(firstRow).getByRole('button', { name: 'workbench.connections.connectTerminal' }));
    fireEvent.click(within(firstRow).getByRole('button', { name: 'workbench.connections.connectSftp' }));
    expect(onConnectTerminal).toHaveBeenCalledWith(profiles[0]);
    expect(onConnectSftp).toHaveBeenCalledWith(profiles[0]);
    fireEvent.click(within(firstRow).getByRole('button', { name: 'workbench.connections.moreActions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'common.edit' }));
    expect(onEdit).toHaveBeenCalledWith(profiles[0]);

    // Clicking the already-active toggle keeps table mode selected
    await userEvent.click(tableToggle);
    expect(readConnectionViewMode()).toBe('table');
    expect(screen.getByRole('table', { name: 'workbench.connections.title' })).toBeInTheDocument();

    // Remounting restores saved table preference from local state
    unmount();
    render(
      <ConnectionList
        profiles={profiles}
        initialized
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );
    expect(screen.getByRole('table', { name: 'workbench.connections.title' })).toBeInTheDocument();

    // Switching back to card persists 'card'
    await userEvent.click(screen.getByRole('button', { name: 'workbench.connections.view.card' }));
    expect(readConnectionViewMode()).toBe('card');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('sorts table rows by column in three-state cycles and keeps ungrouped rows last', async () => {
    saveConnectionViewMode('table');
    const profiles = [
      makeProfile({ id: 's10', name: 'Server 10', host: '10.0.0.10', group: 'Staging', authMethod: 'password' }),
      makeProfile({ id: 's2', name: 'Server 2', host: '10.0.0.2', authMethod: 'key' }),
      makeProfile({ id: 'alpha', name: 'Alpha', host: '10.0.0.1', group: 'Production', authMethod: 'agent' }),
    ];

    const { container } = render(
      <ConnectionList
        profiles={profiles}
        initialized
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onConnectTerminal={() => {}}
        onConnectSftp={() => {}}
        onDuplicate={() => {}}
        onToggleFavorite={() => {}}
        onImport={() => {}}
        onExport={() => {}}
      />,
    );

    const rowNames = () =>
      Array.from(container.querySelectorAll('[data-connection-text="name"]')).map((el) => el.textContent);

    expect(rowNames()).toEqual(['Server 10', 'Server 2', 'Alpha']);

    // Sort by name: asc -> desc -> none
    const sortButtons = within(screen.getByRole('table')).getAllByRole('button', {
      name: 'workbench.connections.table.sortBy',
    });
    const [nameSortBtn, addressSortBtn, , groupSortBtn] = sortButtons;

    await userEvent.click(nameSortBtn);
    expect(nameSortBtn.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(rowNames()).toEqual(['Alpha', 'Server 2', 'Server 10']);

    await userEvent.click(nameSortBtn);
    expect(nameSortBtn.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(rowNames()).toEqual(['Server 10', 'Server 2', 'Alpha']);

    await userEvent.click(nameSortBtn);
    expect(nameSortBtn.closest('th')).toHaveAttribute('aria-sort', 'none');
    expect(rowNames()).toEqual(['Server 10', 'Server 2', 'Alpha']);

    // Sort by address uses natural numeric sorting
    await userEvent.click(addressSortBtn);
    expect(rowNames()).toEqual(['Alpha', 'Server 2', 'Server 10']);

    // Sort by group keeps ungrouped rows at the bottom in both directions
    await userEvent.click(groupSortBtn);
    expect(rowNames()).toEqual(['Alpha', 'Server 10', 'Server 2']);
    await userEvent.click(groupSortBtn);
    expect(rowNames()).toEqual(['Server 10', 'Alpha', 'Server 2']);
  });

  it('falls back to card view when local view preference is invalid', () => {
    saveLocalState('shellspan.connections.viewMode', 'invalid');
    expect(readConnectionViewMode()).toBe('card');
  });
});
