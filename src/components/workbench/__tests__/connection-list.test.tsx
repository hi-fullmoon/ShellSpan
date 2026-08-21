import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionList } from '../connection-list';
import type { ConnectionProfile } from '@/types';

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
      />,
    );

    expect(screen.getByText('workbench.connections.empty')).toBeInTheDocument();
    expect(
      screen.getByText('workbench.connections.emptyDescription'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'workbench.connections.new' }),
    ).toBeInTheDocument();
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
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'workbench.connections.new' }),
    );

    expect(onAdd).toHaveBeenCalledTimes(1);
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
    rectSpy.mockRestore();
  });

  it('debounces repeated clicks on every profile-card action', () => {
    vi.useFakeTimers();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onConnectTerminal = vi.fn();
    const onConnectSftp = vi.fn();
    const onDuplicate = vi.fn();
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
      />,
    );

    const actions = [
      ['workbench.connections.connectTerminal', onConnectTerminal],
      ['workbench.connections.connectSftp', onConnectSftp],
      ['common.edit', onEdit],
      ['common.duplicate', onDuplicate],
      ['common.delete', onDelete],
    ] as const;

    for (const [accessibleName, handler] of actions) {
      const button = screen.getByRole('button', { name: accessibleName });
      fireEvent.click(button);
      vi.advanceTimersByTime(100);
      fireEvent.click(button);
      expect(handler).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(400);
      fireEvent.click(button);
      expect(handler).toHaveBeenCalledTimes(2);
    }
    vi.useRealTimers();
  });
});
