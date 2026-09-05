import { selectEditorText } from '@/test/composer-editor-user';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { builtinSkillPreview } from '@/lib/ai/builtin-skills';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { SkillUserList } from '@/types/agent-skill';

beforeEach(async () => { Element.prototype.scrollIntoView = vi.fn(); useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

describe('slash skill menu', () => {
  it('lists without a directory, filters locally, inserts with keyboard and sends only after selection', async () => {
    const user = userEvent.setup(); const query = vi.fn(async () => builtinSkillPreview); const submit = vi.fn();
    render(<AiComposerSeat phase="hero" status="idle" skillsNeedsRoot onListSkills={query} onSubmit={submit} />);
    expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull();
    const editor = screen.getByRole('textbox');
    await user.type(editor, '/');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(5));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(query).toHaveBeenCalledWith();
    await user.type(editor, 'net');
    expect(screen.getAllByRole('option')).toHaveLength(1); expect(query).toHaveBeenCalledTimes(1);
    await user.keyboard('{Enter}');
    expect(editor.textContent).toBe('/network-diagnosis '); expect(submit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}'); expect(submit).toHaveBeenCalledExactlyOnceWith('/network-diagnosis ');
  });
  it('replaces the token at the caret and keeps surrounding text and paths', async () => {
    const user = userEvent.setup(); const query = vi.fn(async () => builtinSkillPreview);
    render(<AiComposerSeat phase="hero" status="idle" defaultDraft="check /syszzz then /var/log" onListSkills={query} />);
    const editor = screen.getByRole('textbox') as HTMLDivElement;
    await user.click(editor); await act(async () => selectEditorText(editor, 10, 10));
    await user.click(await screen.findByRole('option', { name: /system-status/ }));
    expect(editor.textContent).toBe('check /system-status then /var/log');
    expect(screen.queryByRole('listbox')).toBeNull();
    await act(async () => selectEditorText(editor, editor.textContent!.length, editor.textContent!.length));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('supports arrow keys, Tab, Escape and reopening after editing', async () => {
    const user = userEvent.setup(); render(<AiComposerSeat phase="hero" status="idle" onListSkills={async () => builtinSkillPreview} />);
    const editor = screen.getByRole('textbox'); await user.type(editor, '/'); await screen.findByRole('option', { name: /system-status/ });
    await user.keyboard('{ArrowDown}{Tab}'); expect(editor.textContent).toBe('/service-diagnosis ');
    await user.clear(editor); await user.type(editor, '/'); await screen.findByRole('listbox');
    await user.keyboard('{Escape}'); expect(screen.queryByRole('listbox')).toBeNull();
    await user.clear(editor); await user.type(editor, '/'); expect(await screen.findByRole('listbox')).toBeVisible();
  });
  it('does not send while loading, on empty results or during IME', async () => {
    let resolve!: (value: SkillUserList) => void;
    const pending = new Promise<SkillUserList>(done => { resolve = done; });
    const user = userEvent.setup(); const submit = vi.fn();
    render(<AiComposerSeat phase="hero" status="idle" onListSkills={() => pending} onSubmit={submit} />);
    const editor = screen.getByRole('textbox'); await user.type(editor, '/missing'); await user.keyboard('{Enter}');
    expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionStart(editor); fireEvent.keyDown(editor, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(submit).not.toHaveBeenCalled(); fireEvent.compositionEnd(editor);
    await act(async () => resolve(builtinSkillPreview)); await screen.findByText('No matching skills');
    await user.keyboard('{Enter}'); expect(submit).not.toHaveBeenCalled();
  });
  it('drops old results across scope changes including A to B to A', async () => {
    const calls: ((value: SkillUserList) => void)[] = [];
    const query = vi.fn(() => new Promise<SkillUserList>(resolve => calls.push(resolve)));
    const user = userEvent.setup(); const { rerender } = render(<AiComposerSeat phase="hero" status="idle" skillsScopeKey="A" onListSkills={query} />);
    await user.type(screen.getByRole('textbox'), '/'); await waitFor(() => expect(calls).toHaveLength(1));
    rerender(<AiComposerSeat phase="hero" status="idle" skillsScopeKey="B" onListSkills={query} />); await waitFor(() => expect(calls).toHaveLength(2));
    rerender(<AiComposerSeat phase="hero" status="idle" skillsScopeKey="A" onListSkills={query} />); await waitFor(() => expect(calls).toHaveLength(3));
    await act(async () => { calls[0](builtinSkillPreview); calls[1](builtinSkillPreview); });
    expect(screen.queryByRole('option')).toBeNull();
    await act(async () => calls[2]({ ...builtinSkillPreview, entries: [] }));
    expect(await screen.findByText('No matching skills')).toBeVisible();
  });
  it('searches Chinese descriptions and preserves file completion', async () => {
    useAppStore.setState({ locale: 'zh-CN' }); await initI18n('zh-CN');
    const user = userEvent.setup(); const files = vi.fn(async () => ({ status: 'ready' as const, scope: null, code: null, excluded: 0, entries: [{ path: 'log.txt', kind: 'file' as const }] }));
    render(<AiComposerSeat phase="hero" status="idle" onListSkills={async () => builtinSkillPreview} onListFileReferences={files} />);
    const editor = screen.getByRole('textbox'); await user.type(editor, '/磁盘');
    await user.click(await screen.findByRole('option', { name: /disk-cleanup/ }));
    expect(editor.textContent).toBe('/disk-cleanup ');
    await user.type(editor, '@log'); await user.click(await screen.findByRole('option', { name: 'log.txt' }));
    expect(editor.textContent).toBe('/disk-cleanup @log.txt ');
  });
});
