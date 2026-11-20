import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSnippetStore } from '@/stores/snippetStore';
import { useToastStore } from '@/stores/toastStore';
import type { CommandSnippet } from '@/lib/terminal/snippet-template';
import { SnippetsPanel } from '../snippets-panel';

const ipcMocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<CommandSnippet[]>>(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => (
      values ? `${key}:${JSON.stringify(values)}` : key
    ),
  }),
}));

vi.mock('@/lib/ipc/tauri', () => ({
  invokeListCommandSnippets: ipcMocks.list,
  invokeSaveCommandSnippet: ipcMocks.save,
  invokeDeleteCommandSnippet: ipcMocks.remove,
}));

const sampleSnippet: CommandSnippet = {
  id: 'snip-1',
  name: 'Tail Logs',
  groupName: 'Kubernetes',
  tags: ['k8s', 'logs'],
  description: 'Follow pod logs',
  commandTemplate: 'kubectl logs -f {{pod}} -n {{namespace:default}}',
  createdAt: 1,
  updatedAt: 1,
};

describe('SnippetsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    useSnippetStore.setState({ snippets: [], loading: false });
    ipcMocks.list.mockResolvedValue([]);
    ipcMocks.save.mockImplementation(async (id, input) => ({
      id: id ?? 'snip-new',
      ...input,
      createdAt: 1,
      updatedAt: 2,
    }));
    ipcMocks.remove.mockResolvedValue(undefined);
  });

  it('uses PanelLoadingState while loading and PanelEmptyState when empty', async () => {
    let resolveList!: (value: CommandSnippet[]) => void;
    ipcMocks.list.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));

    const { container } = render(<SnippetsPanel />);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();

    resolveList([]);
    const emptyRegion = await waitFor(() => {
      const slot = container.querySelector('[data-slot="panel-empty-state"]');
      expect(slot).toBeInTheDocument();
      return slot as HTMLElement;
    });

    expect(within(emptyRegion).getByText('terminal.snippets.empty')).toBeInTheDocument();
    expect(within(emptyRegion).getByText('terminal.snippets.emptyDescription')).toBeInTheDocument();
    expect(within(emptyRegion).getByRole('button', { name: 'terminal.snippets.add' })).toBeInTheDocument();
    expect(screen.getByText('terminal.snippets.count:{"count":0,"total":0}')).toBeInTheDocument();
  });

  it('renders ResponsiveCardGrid cards with badges, code preview, copy/edit/delete actions, and search clear', async () => {
    ipcMocks.list.mockResolvedValueOnce([sampleSnippet]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    const { container } = render(<SnippetsPanel />);
    await screen.findByText('Tail Logs');

    const grid = container.querySelector('.grid') as HTMLElement;
    expect(grid).toHaveStyle({ gap: '0.75rem' });
    expect(screen.getByText('Kubernetes').closest('[data-slot="badge"]')).not.toBeNull();
    expect(screen.getByText('k8s').closest('[data-slot="badge"]')).not.toBeNull();
    expect(screen.getByText('logs').closest('[data-slot="badge"]')).not.toBeNull();
    expect(container.querySelector('pre')).toHaveTextContent(sampleSnippet.commandTemplate);

    const cardAction = container.querySelector('[data-slot="card-action"]') as HTMLElement;
    expect(within(cardAction).getByRole('button', { name: 'terminal.snippets.copyTemplate' })).toBeInTheDocument();
    expect(within(cardAction).getByRole('button', { name: 'common.edit' })).toBeInTheDocument();
    expect(within(cardAction).getByRole('button', { name: 'common.delete' })).toBeInTheDocument();

    fireEvent.click(within(cardAction).getByRole('button', { name: 'terminal.snippets.copyTemplate' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(sampleSnippet.commandTemplate));

    const search = screen.getByRole('textbox', { name: 'terminal.snippets.search' });
    await userEvent.type(search, 'nomatch');
    expect(screen.getByText('terminal.snippets.filteredCount:{"count":0,"total":1}')).toBeInTheDocument();
    expect(screen.getByText('terminal.snippets.noMatches')).toBeInTheDocument();
    expect(screen.getByText('common.noSearchResults')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'common.clear' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('Tail Logs')).toBeInTheDocument();
  });

  it('uses CompactDialogBody and FieldError in EditSnippet and submits with form Enter', async () => {
    ipcMocks.list.mockResolvedValueOnce([]);
    render(<SnippetsPanel />);

    const header = await screen.findByRole('banner');
    await userEvent.click(within(header).getByRole('button', { name: 'terminal.snippets.add' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.overflow-y-auto.overscroll-contain')).toBeInTheDocument();
    expect(dialog.querySelector('[data-slot="scroll-area"]')).toBeNull();

    const nameInput = within(dialog).getByLabelText('terminal.snippets.name');
    const commandInput = within(dialog).getByLabelText('terminal.snippets.template');
    await userEvent.type(nameInput, 'Disk Usage');
    fireEvent.change(commandInput, { target: { value: 'df {{broken' } });

    expect(within(dialog).getByRole('alert')).toHaveTextContent('terminal.snippets.invalid');
    const saveButton = within(dialog).getByRole('button', { name: 'common.save' });
    expect(saveButton).toBeDisabled();

    fireEvent.change(commandInput, { target: { value: 'df -h {{path:/}}' } });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(saveButton).toBeEnabled();

    fireEvent.submit(commandInput.closest('form')!);
    await waitFor(() => expect(ipcMocks.save).toHaveBeenCalledWith(undefined, {
      name: 'Disk Usage',
      groupName: '',
      description: '',
      commandTemplate: 'df -h {{path:/}}',
      tags: [],
    }));
    const toasts = useToastStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.message).toBe('terminal.snippets.saved');
  });
});
