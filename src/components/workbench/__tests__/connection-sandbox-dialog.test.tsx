import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ConnectionSandboxDialog } from '../connection-sandbox-dialog';
import type { SandboxTestResult } from '@/types';

vi.mock('@/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ipc/tauri', async original => ({
  ...await original<typeof import('@/lib/ipc/tauri')>(),
  invokeGetProfileSandbox: vi.fn().mockResolvedValue({ binding: 'binding', policy: { mode: 'readOnly', workspace: '/srv/shellspan-workspaces/example' } }),
  invokeTestProfileSandbox: vi.fn().mockResolvedValue({
    ssh: { operationId: 'test', status: 'passed', checkedAt: 0, steps: [] },
    steps: [['bubblewrap', 'failed']], protocolVersion: null, passed: false,
    cancelled: false, packageMissing: true, installCommand: 'apk add bubblewrap',
  } satisfies SandboxTestResult),
}));

describe('sandbox installation copy', () => {
  it('shows confirmation on the install button without a success toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ConnectionSandboxDialog profileId="profile" />);
    fireEvent.click(screen.getByRole('button', { name: 'connection.sandbox.manage' }));
    const test = await screen.findByRole('button', { name: 'connection.sandbox.test' });
    await waitFor(() => expect(test).toBeEnabled());
    fireEvent.click(test);
    fireEvent.click(await screen.findByRole('button', { name: 'connection.sandbox.copyInstall' }));
    const copied = await screen.findByRole('button', { name: 'common.copied' });
    expect(copied.querySelector('.lucide-check')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('apk add bubblewrap');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows and copies the L3 deployment guide script when executor test fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const tauri = await import('@/lib/ipc/tauri');
    vi.mocked(tauri.invokeTestProfileSandbox).mockResolvedValueOnce({
      ssh: { operationId: 'test', status: 'passed', checkedAt: 0, steps: [] },
      steps: [['executorProtocol', 'failed']],
      protocolVersion: null,
      passed: false,
      cancelled: false,
      packageMissing: false,
      installCommand: null,
      deployScript: '#!/usr/bin/env bash\n# Subsystem shellspan-bwrap-v1',
    });

    render(<ConnectionSandboxDialog profileId="profile" />);
    fireEvent.click(screen.getByRole('button', { name: 'connection.sandbox.manage' }));
    const test = await screen.findByRole('button', { name: 'connection.sandbox.test' });
    await waitFor(() => expect(test).toBeEnabled());
    fireEvent.click(test);

    const copyScript = await screen.findByRole('button', { name: 'connection.sandbox.copyDeployScript' });
    fireEvent.click(copyScript);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('#!/usr/bin/env bash\n# Subsystem shellspan-bwrap-v1');
  });

  it('allows arbitrary safe absolute paths when configured in L1 clientReadOnly mode', async () => {
    const tauri = await import('@/lib/ipc/tauri');
    vi.mocked(tauri.invokeGetProfileSandbox).mockResolvedValueOnce({
      binding: 'binding',
      policy: { mode: 'clientReadOnly', workspace: '/var/log/nginx' },
    });

    render(<ConnectionSandboxDialog profileId="profile" />);
    fireEvent.click(screen.getByRole('button', { name: 'connection.sandbox.manage' }));
    const save = await screen.findByRole('button', { name: 'common.save' });
    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.getByText('connection.sandbox.workspaceHintClientReadOnly')).toBeInTheDocument();
  });
});
