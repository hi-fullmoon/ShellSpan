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

  it('renders the profile list when profiles exist', () => {
    render(
      <ConnectionList
        profiles={[makeProfile()]}
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
