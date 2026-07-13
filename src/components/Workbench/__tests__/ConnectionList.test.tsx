import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionList } from '../ConnectionList';
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
});
