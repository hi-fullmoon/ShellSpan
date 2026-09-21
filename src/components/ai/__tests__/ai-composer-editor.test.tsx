import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent, { selectEditorText } from '@/test/composer-editor-user';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { builtinSkillPreview } from '@/lib/ai/builtin-skills';
import { createAiComposerState } from '@/lib/ai/composer-machine';

beforeEach(async () => { await initI18n('en-US'); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

describe('composer layout', () => {
  it('keeps image drafts flush with the top edge in every phase', () => {
    const imageControls = <div>image preview</div>;
    const { container, rerender } = render(
      <AiComposerSeat phase="hero" status="idle" imageControls={imageControls} />,
    );
    const card = container.querySelector('[data-composer-card]');
    expect(card).not.toHaveClass('pt-1.5', 'pt-2.5');
    expect(card).toHaveClass('gap-0');
    expect(card).not.toHaveClass('gap-3');
    expect(container.querySelector('.ai-composer-toolbar')).toHaveClass('mt-3');

    rerender(<AiComposerSeat phase="active" status="idle" imageControls={imageControls} />);
    expect(container.querySelector('[data-composer-card]')).not.toHaveClass('pt-1.5', 'pt-2.5');
  });

  it('restores phase-specific top padding when there is no image draft', () => {
    const { container, rerender } = render(<AiComposerSeat phase="hero" status="idle" />);
    expect(container.querySelector('[data-composer-card]')).toHaveClass('pt-1.5');
    expect(container.querySelector('[data-composer-card]')).not.toHaveClass('pt-2.5');

    rerender(<AiComposerSeat phase="active" status="idle" />);
    expect(container.querySelector('[data-composer-card]')).toHaveClass('pt-2.5');
    expect(container.querySelector('[data-composer-card]')).not.toHaveClass('pt-1.5');
  });
});

describe('rich composer commands', () => {
  it('highlights directory references while keeping following prose editable', async () => {
    const user = userEvent.setup();
    render(<AiComposerSeat phase="hero" status="idle" defaultDraft={'/system-status @zhengbiwen/.nvm/'} />);
    const editor = screen.getByRole('textbox');
    expect(editor.querySelector('[data-composer-directory]')).toHaveClass('ai-composer-command', 'ai-composer-directory-reference');
    expect(editor.querySelector('[data-composer-directory]')).toHaveTextContent('@zhengbiwen/.nvm/');
    await user.click(editor);
    await act(async () => selectEditorText(editor, editor.textContent!.length, editor.textContent!.length));
    await user.type(editor, 'cache/');
    expect(editor.textContent).toBe('/system-status @zhengbiwen/.nvm/cache/');
    expect(editor.querySelector('[data-composer-directory]')).toHaveTextContent('@zhengbiwen/.nvm/');
    await act(async () => selectEditorText(editor, editor.textContent!.length - 1, editor.textContent!.length));
    await user.keyboard('{Backspace}');
    expect(editor.textContent).toBe('/system-status @zhengbiwen/.nvm/cache');
  });

  it.each(['@.abu/skills/', '@"space dir/skills/"'])('deletes the whole directory %s and restores it with undo', async reference => {
    const user = userEvent.setup();
    const draft = `before ${reference} after`;
    render(<AiComposerSeat phase="hero" status="idle" defaultDraft={draft} />);
    const editor = screen.getByRole('textbox');
    await user.click(editor);
    const end = 'before '.length + reference.length;
    await act(async () => selectEditorText(editor, end - 1, end));
    await user.keyboard('{Backspace}');
    expect(editor.textContent).toBe('before  after');
    expect(editor.querySelector('[data-composer-directory]')).toBeNull();
    await user.keyboard('{Control>}z{/Control}');
    expect(editor.textContent).toBe(draft);
    expect(editor.querySelector('[data-composer-directory]')).toHaveTextContent(reference);
  });

  it('highlights quoted directory paths without decorating ordinary paths or email addresses', () => {
    render(<AiComposerSeat phase="hero" status="idle" defaultDraft={'/var/log/ person@example.com/ @"project files/source/'} />);
    const editor = screen.getByRole('textbox');
    expect(editor.querySelectorAll('[data-composer-directory]')).toHaveLength(1);
    expect(editor.querySelector('[data-composer-directory]')).toHaveTextContent('@"project files/source/');
  });

  it.each(['session', 'workspace'] as const)('isolates undo and redo when the %s changes', async kind => {
    const user = userEvent.setup();
    const props = (owner: string, draft: string) => ({
      phase: 'active' as const, status: 'idle' as const,
      composerState: createAiComposerState({ sessionId: kind === 'session' ? owner : null, draft }),
      skillsScopeKey: kind === 'workspace' ? owner : undefined,
    });
    const { rerender } = render(<AiComposerSeat {...props('A', 'draft A')} />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, ' extra');
    await user.keyboard('{Control>}z{/Control}');
    expect(editor.textContent).toBe('draft A');

    rerender(<AiComposerSeat {...props('B', 'draft B')} />);
    await user.keyboard('{Control>}z{/Control}{Control>}{Shift>}z{/Shift}{/Control}');
    expect(editor.textContent).toBe('draft B');
    await user.type(editor, ' new');
    expect(editor.textContent).toBe('draft B new');
    await user.keyboard('{Control>}z{/Control}');
    expect(editor.textContent).toBe('draft B');
  });

  it('clears history even when two owners have identical draft text', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AiComposerSeat phase="hero" status="idle" skillsScopeKey="A" draft="same" />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, ' old');
    await user.keyboard('{Control>}z{/Control}');
    rerender(<AiComposerSeat phase="hero" status="idle" skillsScopeKey="B" draft="same" />);
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(editor.textContent).toBe('same');
  });

  it('renders selected commands as tokens, then submits the unchanged plain-text draft', async () => {
    const user = userEvent.setup(), submit = vi.fn();
    render(<AiComposerSeat phase="hero" status="idle" onListSkills={async () => builtinSkillPreview} onSubmit={submit} />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, '/sys');
    await user.click(await screen.findByRole('option', { name: /system-status/ }));
    expect(editor.tagName).toBe('DIV');
    expect(editor.querySelector('[data-composer-command="system-status"]')).toHaveTextContent('/system-status');
    await user.type(editor, '检查服务');
    await user.keyboard('{Enter}');
    expect(submit).toHaveBeenCalledExactlyOnceWith('/system-status 检查服务');
  });

  it('deletes a selected command and restores it with undo', async () => {
    const user = userEvent.setup();
    render(<AiComposerSeat phase="hero" status="idle" defaultDraft="before /system-status after" />);
    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await act(async () => selectEditorText(editor, 'before '.length, 'before /system-status'.length));
    await user.keyboard('{Backspace}');
    expect(editor.textContent).toBe('before  after');
    await user.keyboard('{Control>}z{/Control}');
    expect(editor.textContent).toBe('before /system-status after');
    expect(editor.querySelector('[data-composer-command]')).not.toBeNull();
  });

  it('does not decorate paths, URLs or unknown commands', () => {
    render(<AiComposerSeat phase="hero" status="idle" defaultDraft="/var/log https://example.com/system-status /unknown /system-status " />);
    const editor = screen.getByRole('textbox');
    expect(editor.querySelectorAll('[data-composer-command]')).toHaveLength(1);
    expect(editor.textContent).toBe('/var/log https://example.com/system-status /unknown /system-status ');
  });

  it('preserves multiline text and supports completion after a line break', async () => {
    const user = userEvent.setup(), submit = vi.fn();
    render(<AiComposerSeat phase="hero" status="idle" onListSkills={async () => builtinSkillPreview} onSubmit={submit} />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, 'first\n/sys');
    await user.click(await screen.findByRole('option', { name: /system-status/ }));
    await user.keyboard('{Enter}');
    expect(submit).toHaveBeenCalledExactlyOnceWith('first\n/system-status ');
  });
});
