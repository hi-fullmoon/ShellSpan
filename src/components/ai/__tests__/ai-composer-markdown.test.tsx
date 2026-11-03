import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import userEvent, { selectEditorText } from '@/tests/composer-editor-user';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { AiComposerEditor } from '../workspace/ai-composer-editor';
import { markdownSpans } from '../workspace/composer-markdown';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { decodeDocumentMessage } from '@/lib/ai/document-message';
import { builtinSkillPreview } from '@/lib/ai/builtin-skills';

beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

const source = '# Plan\n\n**bold** *italic* ~~removed~~ `inline`\n\n- [x] check\n\n> quote\n\n[link](https://example.com)\n\n```sh\n/system-status @src/components/\n```';

describe('Markdown composer', () => {
  it('recognizes Markdown and GFM syntax without parsing code contents as commands', () => {
    const spans = markdownSpans(source);
    expect(new Set(spans.map(span => span.kind))).toEqual(new Set(['heading', 'marker', 'emphasis', 'strike', 'code', 'quote', 'link']));
    const fence = spans.find(span => span.kind === 'code' && source.slice(span.from, span.to).startsWith('```'))!;
    expect(source.slice(fence.from, fence.to)).toBe('```sh\n/system-status @src/components/\n```');
    expect(spans.filter(span => span.from > fence.from && span.to < fence.to)).toEqual([]);
  });

  it('restores and sends the exact Markdown source', async () => {
    const user = userEvent.setup();
    let sent = '';
    render(<AiComposerSeat phase="active" status="idle" defaultDraft={source} onSubmit={value => { sent = value; }} />);
    const editor = screen.getByRole('textbox');
    expect(editor.querySelector('h1, strong, blockquote, pre, ul')).toBeNull();
    expect(editor.querySelector('[data-composer-command], [data-composer-directory]')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Text formatting' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(decodeDocumentMessage(sent).text).toBe(source);
  });

  it.each([['b', '**word**'], ['i', '*word*'], ['e', '`word`']])('inserts Markdown with Ctrl+%s and supports undo', async (key, expected) => {
    const user = userEvent.setup();
    let sent = '';
    render(<AiComposerSeat phase="active" status="idle" defaultDraft="word" onSubmit={value => { sent = value; }} />);
    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await act(async () => selectEditorText(editor, 0, 4));
    await user.keyboard(`{Control>}${key}{/Control}`);
    expect(editor.textContent).toBe(expected);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(decodeDocumentMessage(sent).text).toBe(expected);
    await user.keyboard('{Control>}z{/Control}');
    expect(editor.textContent).toBe('word');
  });

  it('keeps inline-code references literal while decorating following references', () => {
    render(<AiComposerEditor markdown value={'example `@src/ /system-status ` then @src/ /system-status '}
      placeholder="Message" commandNames={['system-status']} onChange={() => {}} onSelectionChange={() => {}} />);
    const editor = screen.getByRole('textbox');
    expect(editor.querySelectorAll('[data-composer-directory]')).toHaveLength(1);
    expect(editor.querySelectorAll('[data-composer-command]')).toHaveLength(1);
  });

  it('preserves Shift+Enter newlines and Enter submission', async () => {
    const user = userEvent.setup();
    let sent = '';
    render(<AiComposerSeat phase="active" status="idle" onSubmit={value => { sent = value; }} />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, '# Heading');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.paste('- item');
    expect(sent).toBe('');
    await user.keyboard('{Enter}');
    expect(decodeDocumentMessage(sent).text).toBe('# Heading\n- item');
  });

  it('keeps completion closed inside code and restores it after the closing fence', async () => {
    const user = userEvent.setup();
    render(<AiComposerSeat phase="active" status="idle" onListSkills={async () => builtinSkillPreview} />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, '```sh\n/sys');
    expect(screen.queryByRole('option', { name: '/system-status' })).toBeNull();
    await user.paste('\n```\n/sys');
    expect(await screen.findByRole('option', { name: '/system-status' })).toBeVisible();
  });
});
