import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ConnectionSandboxDialog } from '../connection-sandbox-dialog';
import type { SandboxTestResult } from '@/types';

vi.mock('@/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/ipc/tauri', async original => ({
  ...await original<typeof import('@/lib/ipc/tauri')>(),
  invokeGetProfileSandbox: vi.fn().mockResolvedValue({ binding: 'binding', policy: { mode: 'readOnly', workspace: '/srv/shellspan-workspaces/example' } }),
  invokeDeployProfileSandbox: vi.fn(),
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
    expect(screen.getByText('connection.sandbox.descriptionClientReadOnly')).toBeInTheDocument();
    expect(screen.getByText('connection.sandbox.workspaceHintClientReadOnly')).toBeInTheDocument();

    const input = screen.getByLabelText('connection.sandbox.workspace');
    fireEvent.change(input, { target: { value: '/var/log/../etc' } });
    expect(screen.getByRole('alert')).toHaveTextContent('connection.sandbox.workspaceInvalidClientReadOnly');
    expect(save).toBeDisabled();
  });

  it('shows inline validation error when an L3 Bubblewrap workspace path is outside /srv/shellspan-workspaces', async () => {
    render(<ConnectionSandboxDialog profileId="profile" />);
    fireEvent.click(screen.getByRole('button', { name: 'connection.sandbox.manage' }));
    const input = await screen.findByLabelText('connection.sandbox.workspace');
    const save = screen.getByRole('button', { name: 'common.save' });
    await waitFor(() => expect(save).toBeEnabled());

    fireEvent.change(input, { target: { value: '/tmp/not-allowed' } });
    expect(screen.getByRole('alert')).toHaveTextContent('connection.sandbox.workspaceInvalid');
    expect(save).toBeDisabled();
  });

  it('confirms and runs online L3 deployment, then renders output and refreshed report', async () => {
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
    vi.mocked(tauri.invokeDeployProfileSandbox).mockResolvedValueOnce({
      succeeded: true,
      rootRequired: false,
      cancelled: false,
      exitCode: 0,
      output: 'installed shellspan-bwrap-v1\n',
      report: {
        ssh: { operationId: 'deploy', status: 'passed', checkedAt: 0, steps: [] },
        steps: [['executorProtocol', 'passed']],
        protocolVersion: 1,
        passed: true,
        cancelled: false,
        packageMissing: false,
        installCommand: null,
      },
    });

    render(<ConnectionSandboxDialog profileId="profile" />);
    fireEvent.click(screen.getByRole('button', { name: 'connection.sandbox.manage' }));
    const test = await screen.findByRole('button', { name: 'connection.sandbox.test' });
    await waitFor(() => expect(test).toBeEnabled());
    fireEvent.click(test);

    fireEvent.click(await screen.findByTestId('connection-sandbox-deploy-now'));
    fireEvent.click(await screen.findByRole('button', { name: 'connection.sandbox.deployConfirmAction' }));

    await waitFor(() => {
      expect(tauri.invokeDeployProfileSandbox).toHaveBeenCalledWith(
        'profile',
        'binding',
        { mode: 'readOnly', workspace: '/srv/shellspan-workspaces/example' },
        expect.stringMatching(/^sandbox-deploy-/),
      );
    });
    expect(await screen.findByTestId('connection-sandbox-deploy-result')).toHaveTextContent(
      'connection.sandbox.deploySuccess',
    );
    expect(screen.getByText(/installed shellspan-bwrap-v1/)).toBeInTheDocument();
  });

  it('prefills a valid default workspace directory when enabling sandbox from off and updates it across modes until customized', async () => {
    const user = userEvent.setup();
    const tauri = await import('@/lib/ipc/tauri');
    vi.mocked(tauri.invokeGetProfileSandbox).mockResolvedValueOnce({
      binding: 'binding',
      policy: null,
    });

    render(<ConnectionSandboxDialog profileId="profile" />);
    await user.click(screen.getByRole('button', { name: 'connection.sandbox.manage' }));
    const modeSelect = await screen.findByRole('combobox', { name: 'connection.sandbox.mode' });
    await waitFor(() => expect(modeSelect).toBeEnabled());

    await user.click(modeSelect);
    await user.click(await screen.findByRole('option', { name: 'connection.sandbox.mode.workspaceWrite' }));

    const input = await screen.findByLabelText('connection.sandbox.workspace');
    expect(input).toHaveValue('/srv/shellspan-workspaces/default');
    expect(screen.getByRole('button', { name: 'connection.sandbox.test' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'common.save' })).toBeEnabled();

    await user.click(modeSelect);
    await user.click(await screen.findByRole('option', { name: 'connection.sandbox.mode.clientReadOnly' }));
    expect(input).toHaveValue('/var/log');

    await user.click(modeSelect);
    await user.click(await screen.findByRole('option', { name: 'connection.sandbox.mode.readOnly' }));
    expect(input).toHaveValue('/srv/shellspan-workspaces/default');

    fireEvent.change(input, { target: { value: '/srv/shellspan-workspaces/custom-app' } });
    await user.click(modeSelect);
    await user.click(await screen.findByRole('option', { name: 'connection.sandbox.mode.workspaceWrite' }));
    expect(input).toHaveValue('/srv/shellspan-workspaces/custom-app');
  });
});
