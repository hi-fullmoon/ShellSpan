import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionPreflightDialog } from '../connection-preflight-dialog';
import type { ConnectionPreflightResult } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

const unknownKeyResult: ConnectionPreflightResult = {
  operationId: 'connection-preflight-test',
  status: 'attention',
  checkedAt: 1,
  steps: [
    {
      id: 'hostKey',
      status: 'warning',
      detail: 'Unknown host key',
      host: 'server.example.com',
      port: 22,
      fingerprint: 'SHA256:abc',
      trustable: true,
    },
    {
      id: 'authentication',
      status: 'blocked',
      detail: 'Authentication was not attempted.',
      trustable: false,
    },
  ],
};

describe('ConnectionPreflightDialog', () => {
  it('shows authentication as blocked and requires explicit host-key trust', () => {
    const onTrust = vi.fn();
    render(
      <ConnectionPreflightDialog
        open={true}
        result={unknownKeyResult}
        checking={false}
        onClose={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onTrust={onTrust}
      />,
    );

    expect(screen.getByText('connection.preflight.status.blocked')).toBeInTheDocument();
    expect(screen.getByText('Authentication was not attempted.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'connection.preflight.trust' }));
    expect(onTrust).toHaveBeenCalledWith(
      'server.example.com',
      22,
      'SHA256:abc',
    );
  });

  it('offers cancellation while a check is running', () => {
    const onCancel = vi.fn();
    render(
      <ConnectionPreflightDialog
        open={true}
        checking={true}
        onClose={vi.fn()}
        onCancel={onCancel}
        onRetry={vi.fn()}
        onTrust={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
