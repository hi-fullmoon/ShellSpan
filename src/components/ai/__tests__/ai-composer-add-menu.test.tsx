import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { builtinSkills } from '@/lib/ai/builtin-skills';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('composer grouped add menu', () => {
  it('shows a search hint and only requests history after entering a keyword', async () => {
    const user = userEvent.setup();
    let refreshes = 0;
    render(<AiComposerSeat phase="active" status="idle" sessionsLoading onRefreshSessions={() => { refreshes++; }} />);
    await user.click(screen.getByRole('button', { name: 'Add file or folder' }));
    expect(await screen.findByText('Type @ followed by a keyword in the message input to search skills or chats')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Search skills or chats' })).toBeNull();
    expect(screen.queryByText('Loading conversations…')).toBeNull();
    expect(refreshes).toBe(0);
    await user.keyboard('{Escape}');
    const search = screen.getByRole('textbox');
    await user.type(search, '@');
    expect(refreshes).toBe(0);
    await user.type(search, 'network');
    expect(refreshes).toBe(1);
    expect(screen.getByText('Loading conversations…')).toBeVisible();
    expect(search).toHaveFocus();
  });

  it('searches the builtin catalog and inserts a skill without submitting', async () => {
    const user = userEvent.setup();
    let submissions = 0;
    render(<AiComposerSeat phase="active" status="idle" defaultDraft="Inspect this host" onSubmit={() => { submissions++; }} />);
    await user.click(screen.getByRole('button', { name: 'Add file or folder' }));
    expect((await screen.findAllByRole('menuitem')).length).toBe(builtinSkills.length + 2);
    for (const item of screen.getAllByRole('menuitem')) expect(item).toHaveClass('min-h-7', 'gap-1.5');
    await user.click(screen.getByRole('menuitem', { name: '/network-diagnosis' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByRole('textbox')).toHaveTextContent('Inspect this host /network-diagnosis');
    expect(submissions).toBe(0);
  });

  it('shows an empty search and restores the plus button on Escape', async () => {
    const user = userEvent.setup();
    render(<AiComposerSeat phase="active" status="idle" />);
    const trigger = screen.getByRole('button', { name: 'Add file or folder' });
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveClass('h-[360px]', 'max-h-(--available-height)', 'w-(--anchor-width)', 'min-h-0', 'flex-col', 'overflow-hidden');
    expect(menu.querySelector('[data-composer-menu-scroll]')).toHaveClass('min-h-0', 'flex-1');
    expect(menu).toHaveClass('text-muted-foreground');
    expect(menu.querySelector('input')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.type(screen.getByRole('textbox'), '@zzzzzz');
    expect(await screen.findByText('No matching items')).toBeVisible();
    expect(screen.getByRole('listbox').closest('[data-mention-completion]')).toHaveClass('text-muted-foreground');
  });

  it('keeps Ask menus focused on available files and chat history', async () => {
    const user = userEvent.setup();
    const listFiles = vi.fn();
    const listSkills = vi.fn();
    render(<AiComposerSeat mode="ask" phase="active" status="idle" onListFileReferences={listFiles} onListSkills={listSkills} />);
    await user.click(screen.getByRole('button', { name: 'Add file or folder' }));
    const menu = await screen.findByRole('menu');
    expect(menu).not.toHaveClass('h-[360px]');
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: 'Add file' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Add folder' })).toBeNull();
    expect(screen.queryByText('Skills')).toBeNull();
    expect(screen.getByText('Chat history')).toBeVisible();
    await user.keyboard('{Escape}');
    const editor = screen.getByRole('textbox');
    await user.type(editor, '@');
    expect(screen.getByRole('option', { name: 'Upload local files' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Skills' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Project files and folders' })).toBeNull();
    expect(screen.getByText('Type @ followed by a keyword in the message input to search chats')).toBeVisible();
    expect(listFiles).not.toHaveBeenCalled();
    await user.clear(editor);
    await user.type(editor, '/');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(listSkills).not.toHaveBeenCalled();
  });
});
