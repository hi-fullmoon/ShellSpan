import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionList } from '../connection-list';
import type { ConnectionProfile } from '@/types';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';

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
    useRecentProfilesStore.setState({ recentIds: [], initialized: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an empty state with a new-connection button when there are no profiles', () => {
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

    expect(screen.getByText('workbench.connections.empty')).toBeInTheDocument();
    expect(
      screen.getByText('workbench.connections.emptyDescription'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'workbench.connections.new' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'workbench.connections.import' }),
    ).toHaveTextContent('workbench.connections.import');
    expect(
      screen.getByRole('button', { name: 'workbench.connections.export' }),
    ).toHaveTextContent('workbench.connections.export');
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

  it('keeps the shared search field at a fixed width', () => {
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
    expect(search.parentElement).toHaveAttribute('data-slot', 'input-group');
    expect(search.parentElement).toHaveClass(
      'min-w-0',
      'w-72',
      'max-w-full',
      'flex-none',
    );
  });

  it('renders the profile list in a grid capped at three columns', () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1200,
      height: 0,
      x: 0,
      y: 0,
      top: 0,
      right: 1200,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    });
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
    expect(
      screen.queryByText('workbench.connections.empty'),
    ).not.toBeInTheDocument();

    const grid = container.querySelector('[style*="grid-template-columns"]');
    expect(grid).toHaveStyle({
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    });
    expect(grid).not.toHaveClass('items-start');
    rectSpy.mockRestore();
  });

  it('keeps connection-card actions aligned at the bottom of equal-height rows', () => {
    render(
      <ConnectionList
        profiles={[
          makeProfile({ id: 'with-notes', name: 'Host with notes', notes: 'Personal host' }),
          makeProfile({ id: 'without-notes', name: 'Host without notes' }),
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
    expect(terminalActions).toHaveLength(2);
    terminalActions.forEach((action) => {
      expect(action.closest('.mt-auto')).not.toBeNull();
    });
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
      'remoteHealth.open',
      'portForward.open',
      'hostQuickActions.open',
      'hostOverview.open',
      'workbench.connections.favorite',
      'common.edit',
      'common.duplicate',
      'common.delete',
    ];

    for (const name of menuActionNames) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });
});
