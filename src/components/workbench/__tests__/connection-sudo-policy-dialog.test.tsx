import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionSudoPolicyDialog } from '../connection-sudo-policy-dialog';

vi.mock('@/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ipc/tauri', async (original) => ({
  ...await original<typeof import('@/lib/ipc/tauri')>(),
  invokeGetProfileSudoPolicy: vi.fn().mockResolvedValue({
    profileBinding: 'binding',
    host: '175.178.66.45',
    port: 22,
    username: 'ops',
    revision: null,
    runner: null,
    operations: [],
  }),
  invokeSaveProfileSudoPolicy: vi.fn(),
}));

describe('ConnectionSudoPolicyDialog', () => {
  it('renders localized placeholders for restricted runner and operation inputs', async () => {
    render(<ConnectionSudoPolicyDialog profileId="profile-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'connection.sudo.manage' }));
    const runnerSwitch = await screen.findByRole('switch', { name: 'connection.sudo.runnerEnabled' });
    fireEvent.click(runnerSwitch);

    expect(screen.getByLabelText('connection.sudo.runnerPort')).toHaveAttribute(
      'placeholder',
      'connection.sudo.runnerPortPlaceholder',
    );
    expect(screen.getByLabelText('connection.sudo.runnerUser')).toHaveAttribute(
      'placeholder',
      'connection.sudo.runnerUserPlaceholder',
    );
    expect(screen.getByLabelText('connection.sudo.runnerKey')).toHaveAttribute(
      'placeholder',
      'connection.sudo.runnerKeyPlaceholder',
    );

    fireEvent.click(screen.getByRole('button', { name: 'connection.sudo.add' }));

    expect(screen.getByLabelText('connection.sudo.field.id')).toHaveAttribute(
      'placeholder',
      'connection.sudo.field.idPlaceholder',
    );
    expect(screen.getByLabelText('connection.sudo.field.label')).toHaveAttribute(
      'placeholder',
      'connection.sudo.field.labelPlaceholder',
    );
    expect(screen.getByLabelText('connection.sudo.field.command')).toHaveAttribute(
      'placeholder',
      'connection.sudo.field.commandPlaceholder',
    );
  });
});
