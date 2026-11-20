import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SshInteractiveAuthPrompt } from '@/lib/ipc/tauri';
import { SshInteractiveAuthDialogHost } from '../ssh-interactive-auth-dialog';

const ipcMocks = vi.hoisted(() => ({
  respond: vi.fn(),
  onPrompt: undefined as ((event: { payload: SshInteractiveAuthPrompt }) => void) | undefined,
  onClosed: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => (
      values ? `${key}:${JSON.stringify(values)}` : key
    ),
  }),
}));

vi.mock('@/lib/ipc/tauri', () => ({
  isTauriRuntime: () => true,
  invokeRespondToSshInteractiveAuth: ipcMocks.respond,
  listenToSshInteractiveAuthPrompt: vi.fn(async (cb: (event: { payload: SshInteractiveAuthPrompt }) => void) => {
    ipcMocks.onPrompt = cb;
    return () => { ipcMocks.onPrompt = undefined; };
  }),
  listenToSshInteractiveAuthClosed: vi.fn(async (cb: (event: { payload: string }) => void) => {
    ipcMocks.onClosed = cb;
    return () => { ipcMocks.onClosed = undefined; };
  }),
}));

describe('SshInteractiveAuthDialogHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.respond.mockReset();
    ipcMocks.onPrompt = undefined;
    ipcMocks.onClosed = undefined;
  });

  it('renders CompactDialogBody, echo/password inputs, styled instructions, and a spinner while submitting', async () => {
    let resolveResponse!: () => void;
    ipcMocks.respond.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveResponse = resolve; }));

    render(<SshInteractiveAuthDialogHost />);
    await waitFor(() => expect(ipcMocks.onPrompt).toBeTypeOf('function'));

    act(() => {
      ipcMocks.onPrompt!({
        payload: {
          operationId: 'op-1',
          promptId: 'prompt-1',
          host: 'bastion.example.com',
          username: 'ops',
          instructions: 'Enter your authenticator token and PIN.',
          prompts: [
            { text: 'Verification code', echo: true },
            { text: 'PIN', echo: false },
          ],
        },
      });
    });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.overflow-y-auto.overscroll-contain')).toBeInTheDocument();
    expect(dialog.querySelector('[data-slot="scroll-area"]')).toBeNull();
    expect(screen.getByText('Enter your authenticator token and PIN.')).toHaveClass('border', 'rounded-md');

    const codeInput = screen.getByLabelText('Verification code');
    const pinInput = screen.getByLabelText('PIN');
    expect(codeInput).toHaveAttribute('type', 'text');
    expect(pinInput).toHaveAttribute('type', 'password');

    await userEvent.type(codeInput, '123456');
    await userEvent.type(pinInput, '9999');

    const submit = screen.getByRole('button', { name: 'connection.interactive.submit' });
    fireEvent.click(submit);

    expect(submit).toBeDisabled();
    expect(submit.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(ipcMocks.respond).toHaveBeenCalledWith('op-1', 'prompt-1', ['123456', '9999']);

    await act(async () => { resolveResponse(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('submits null when cancelled', async () => {
    ipcMocks.respond.mockResolvedValueOnce(undefined);
    render(<SshInteractiveAuthDialogHost />);
    await waitFor(() => expect(ipcMocks.onPrompt).toBeTypeOf('function'));

    act(() => {
      ipcMocks.onPrompt!({
        payload: {
          operationId: 'op-2',
          promptId: 'prompt-2',
          host: 'bastion.example.com',
          username: 'ops',
          instructions: '',
          prompts: [{ text: 'Token', echo: false }],
        },
      });
    });

    fireEvent.click(await screen.findByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(ipcMocks.respond).toHaveBeenCalledWith('op-2', 'prompt-2', null));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
