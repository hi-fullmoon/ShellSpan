import { useRef, useState } from 'react';
import { readdir } from 'node:fs/promises';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import userEvent from '@/test/composer-editor-user';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { FileReferenceList } from '@/types/agent-file-reference';
import { AiComposerEditor } from '../workspace/ai-composer-editor';
import { AiCompletionPopover } from '../workspace/ai-completion-popover';
import { useFileCompletion } from '../workspace/use-file-completion';

async function listProjectFiles(): Promise<FileReferenceList> {
  const entries = await readdir(process.cwd(), { withFileTypes: true });
  return { entries: entries.map(entry => ({ path: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })),
    scope: null, status: 'ready', code: null, excluded: 0 };
}

function FileCompletion() {
  const [text, setText] = useState('');
  const anchor = useRef<HTMLDivElement>(null);
  const completion = useFileCompletion({ text, update: setText, query: listProjectFiles, disabled: false });
  return <div ref={anchor}>
    <AiComposerEditor {...completion.editorProps} value={text} onChange={setText} placeholder="" commandNames={[]} />
    <AiCompletionPopover anchor={anchor} onDismiss={completion.dismiss}>{completion.panel}</AiCompletionPopover>
  </div>;
}

afterEach(cleanup);

it.each([
  ['zh-CN', '仅引用路径，文件内容不会自动附加到对话。'],
  ['en-US', 'Only the path is added, without file contents.'],
] as const)('uses the shared compact info notice for file references in %s', async (locale, hint) => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const user = userEvent.setup();
  render(<FileCompletion />);
  await user.type(screen.getByRole('textbox'), '@');
  await screen.findAllByRole('option');
  const notice = screen.getByRole('note');
  expect(notice).toHaveAttribute('data-slot', 'alert');
  expect(notice).toHaveAttribute('data-size', 'sm');
  expect(notice).toHaveClass('bg-primary/10', 'border-primary/30');
  expect(notice.querySelector('[data-slot="alert-description"]')).toHaveTextContent(hint);
  const icon = notice.querySelector(':scope > svg');
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon).not.toHaveAttribute('class', expect.stringContaining('mt-'));
});
