/// <reference types="node" />
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { selectEditorText } from '@/test/composer-editor-user';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { readdir } from 'node:fs/promises';

beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);
describe('grouped mention completion', () => {
  it('hides every empty group when a search has no matches', async () => {
    const user = userEvent.setup();
    render(<AiComposerSeat phase="active" status="idle" />);
    await user.type(screen.getByRole('textbox'), '@Move');
    expect(screen.getByRole('listbox')).toBeVisible();
    expect(within(screen.getByRole('listbox')).queryAllByRole('group')).toHaveLength(0);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-activedescendant');
  });
  it('lists actual project files with their target and inserts a relative reference', async () => {
    const user = userEvent.setup();
    const root = process.cwd();
    render(<AiComposerSeat phase="active" status="idle" projectTargetLabel="Repository (local)" onListFileReferences={async (query, signal) => {
      signal.throwIfAborted();
      const entries = await readdir(root, { withFileTypes: true });
      return { status: 'ready', code: null, excluded: 0,
        entries: entries.filter(entry => entry.name.includes(query)).map(entry => ({ path: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })),
        scope: { root, rootIdentity: root, target: { kind: 'local', targetId: 'repository', sessionId: 'repository', label: 'Repository (local)', cwd: root } },
      };
    }} />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, '@package.json');
    const file = await screen.findByRole('option', { name: 'package.json' });
    expect(file).toHaveAttribute('aria-description', 'Local project · Repository (local)');
    expect(screen.getByText(root)).toBeVisible();
    await user.click(file);
    expect(editor.textContent).toBe('@package.json ');
  });
  it('opens without a project and keeps focus in the editor while selecting a skill', async () => {
    const user = userEvent.setup();
    let submitted = '';
    render(<AiComposerSeat phase="active" status="idle" onSubmit={value => { submitted = value; }} />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, 'hello @');
    expect(await screen.findByRole('option', { name: 'Upload local files' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('group', { name: 'Skills' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Chat history' })).toBeNull();
    expect(screen.getByText('Type @ followed by a keyword in the message input to search skills or chats')).toBeVisible();
    expect(editor).toHaveFocus();
    expect(screen.queryByText('Keep typing to search · ↑↓ to choose · Enter to insert · Esc to close')).toBeNull();
    expect(screen.getByRole('listbox')).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(screen.getByRole('listbox').firstElementChild).toHaveClass('p-2');
    expect(screen.getByRole('listbox').closest('[data-slot="popover-content"]')).toHaveClass('h-[360px]', 'overflow-hidden');
    await user.type(editor, 'network');
    expect(screen.queryByRole('group', { name: 'Add' })).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(editor.textContent).toBe('hello /network-diagnosis '));
    expect(submitted).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not open for email addresses and replaces only the active mention', async () => {
    const user = userEvent.setup();
    render(<AiComposerSeat phase="active" status="idle" defaultDraft="a@b.com @network suffix" />);
    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await act(async () => selectEditorText(editor, 3));
    expect(screen.queryByRole('listbox')).toBeNull();
    await act(async () => selectEditorText(editor, 16));
    await user.click(await screen.findByRole('option', { name: /Diagnose DNS/ }));
    expect(editor.textContent).toBe('a@b.com /network-diagnosis suffix');
  });
});
