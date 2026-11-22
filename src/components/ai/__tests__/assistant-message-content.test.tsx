import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { getPlatform } from '@/lib/platform';
import { AiTerminalInsertContext, AssistantMessageContent } from '../assistant-message-content';

const { invokeOpenPath, invokeOpenUrl, invokeRevealPath, invokeReadLocalFileText } = vi.hoisted(() => ({
  invokeOpenPath: vi.fn().mockResolvedValue(undefined),
  invokeOpenUrl: vi.fn().mockResolvedValue(undefined),
  invokeRevealPath: vi.fn().mockResolvedValue(undefined),
  invokeReadLocalFileText: vi.fn().mockResolvedValue('Complete file contents\n第二行'),
}));

vi.mock('@/lib/platform', () => ({ getPlatform: vi.fn(() => 'windows') }));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ipc/tauri')>(),
  invokeOpenPath,
  invokeOpenUrl,
  invokeRevealPath,
  invokeReadLocalFileText,
  isTauriRuntime: () => true,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => {
      if (!variables) return key;
      if ('target' in variables) return `${key}:${variables.target}`;
      return `${key}:${variables.seconds}`;
    },
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

describe('AssistantMessageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeOpenPath.mockClear();
    vi.mocked(getPlatform).mockReturnValue('windows');
  });

  it('opens an explicit file link on Windows or from the context menu', async () => {
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: '[Todo](file:///C:/Users/tester/todo.html)' }]}
        streaming={false}
      />,
    );

    const path = screen.getByRole('link', { name: 'Todo' });
    expect(path).toHaveClass('ai-markdown-local-path');
    expect(path).toHaveAttribute('role', 'link');
    expect(path).toHaveAttribute('tabindex', '0');
    expect(path).not.toHaveAttribute('title');
    fireEvent.click(path);
    expect(invokeOpenPath).toHaveBeenCalledWith('C:/Users/tester/todo.html');
    invokeOpenPath.mockClear();
    fireEvent.keyDown(path, { key: 'Enter' });
    expect(invokeOpenPath).toHaveBeenCalledWith('C:/Users/tester/todo.html');
    invokeOpenPath.mockClear();
    fireEvent.contextMenu(path, { clientX: 120, clientY: 80 });
    await screen.findByRole('menu', { name: 'ai.path.menu' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ai.path.revealExplorer' }));
    expect(invokeRevealPath).toHaveBeenCalledWith('C:/Users/tester/todo.html');

    fireEvent.contextMenu(path, { clientX: 120, clientY: 80 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ai.path.open' }));
    expect(invokeOpenPath).toHaveBeenCalledWith('C:/Users/tester/todo.html');
  });

  it('uses Finder wording for explicit file links on macOS', async () => {
    vi.mocked(getPlatform).mockReturnValue('macos');
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: '[Todo](file:///Users/tester/todo.html)' }]}
        streaming={false}
      />,
    );

    const path = screen.getByRole('link', { name: 'Todo' });
    expect(path).not.toHaveAttribute('title');
    fireEvent.contextMenu(path);
    expect(await screen.findByRole('menuitem', { name: 'ai.path.revealFinder' })).toBeInTheDocument();
  });

  it('keeps ordinary inline code non-interactive', () => {
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: 'Run `pnpm test`.' }]}
        streaming={false}
      />,
    );

    const code = screen.getByText('pnpm test');
    expect(code).not.toHaveClass('ai-markdown-local-path');
    expect(code).not.toHaveAttribute('tabindex');
  });

  it('opens a link from its right-click menu and copies its address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: 'Visit http://localhost:8000 for the preview.' }]}
        streaming={false}
      />,
    );

    const link = screen.getByRole('link', { name: 'http://localhost:8000' });
    fireEvent.contextMenu(link, { clientX: 120, clientY: 80 });
    const openItem = await screen.findByRole('menuitem', { name: 'ai.link.open' });
    expect(openItem).toHaveAttribute('data-slot', 'dropdown-menu-item');
    expect(openItem).toHaveClass('text-xs', 'leading-4', 'px-2.5', 'py-1.5');
    expect(screen.getByRole('menu')).toHaveClass('bg-popover', 'shadow-md');
    expect(screen.getByRole('separator')).toHaveClass('mx-0', 'my-0.5');
    fireEvent.click(openItem);
    expect(invokeOpenUrl).toHaveBeenCalledWith('http://localhost:8000');

    fireEvent.contextMenu(link, { clientX: 120, clientY: 80 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ai.link.copyAddress' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://localhost:8000'));
    const copied = await screen.findByRole('menuitem', { name: 'common.copied' });
    expect(copied.querySelector('.lucide-check')).toBeInTheDocument();
    expect(screen.getByRole('menu')).toBeVisible();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('menuitem', { name: 'ai.link.copyText' })).not.toBeInTheDocument();
  });

  it('offers the visible text separately when a link has a label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: '[Preview](https://example.com/preview)' }]}
        streaming={false}
      />,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ai.link.copyText' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Preview'));
    expect(await screen.findByRole('menuitem', { name: 'common.copied' })).toBeVisible();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each([
    ['ai.path.copy', 'C:/Users/tester/todo.html'],
    ['ai.path.copyContents', 'Complete file contents\n第二行'],
  ])('shows feedback inside the %s menu item', async (label, expected) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<AssistantMessageContent blocks={[{ type: 'text', text: '[Todo](file:///C:/Users/tester/todo.html)' }]} streaming={false} />);
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Todo' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: label }));
    const copied = await screen.findByRole('menuitem', { name: 'common.copied' });
    expect(copied.querySelector('.lucide-check')).toBeInTheDocument();
    expect(screen.getByRole('menu')).toBeVisible();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(copied).toHaveAccessibleName(label), { timeout: 2_000 });
  });

  it('renders an empty structured stream without parsing text for reasoning', () => {
    const { rerender } = render(
      <AssistantMessageContent blocks={[]} streaming />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('ai.thinking.inProgress');

    rerender(
      <AssistantMessageContent
        blocks={[{ type: 'reasoning', text: 'Check the terminal state.' }]}
        streaming
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('ai.thinking.inProgress');
    expect(screen.queryByText('Check the terminal state.')).not.toBeInTheDocument();
  });

  it('consumes ordered text blocks and leaves reasoning to the Turn Process renderer', () => {
    render(
      <AssistantMessageContent
        blocks={[
          { type: 'reasoning', text: 'Check the terminal state.' },
          { type: 'text', text: 'First ' },
          { type: 'toolCall', call: { callId: 'call-1', name: 'read_file', arguments: {} } },
          { type: 'text', text: '**answer**.' },
        ]}
        streaming={false}
      />,
    );

    expect(screen.getByText('answer').tagName).toBe('STRONG');
    expect(screen.getByText('answer').closest('.ai-assistant-answer')).toHaveTextContent('First answer.');
    expect(screen.queryByText('Check the terminal state.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /thinking/u })).not.toBeInTheDocument();
  });

  it('does not treat think tags in a durable text block as structured reasoning', () => {
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: '<think>Provider text</think>\n\nFinal answer.' }]}
        streaming={false}
      />,
    );

    expect(screen.getByText('Final answer.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /thinking/u })).not.toBeInTheDocument();
  });

  it('copies fenced code blocks', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: 'Run:\n```bash\ndf -h\n```' }]}
        streaming={false}
      />,
    );

    const copyButton = screen.getByRole('button', { name: 'common.copy' });
    expect(copyButton).toHaveClass('ai-markdown-code-copy', 'absolute');
    expect(copyButton.parentElement).toHaveClass('relative');
    expect(copyButton.parentElement).toHaveAttribute('data-ai-copy-region');
    expect(copyButton.parentElement).toContainElement(copyButton.closest('.ai-code-block')?.querySelector('pre') ?? null);
    expect(copyButton.closest('.ai-code-block')?.querySelector('.ai-markdown-code-toolbar')).not.toContainElement(copyButton);
    expect(copyButton.textContent).toBe('');
    expect(copyButton.querySelector('svg')).toBeInTheDocument();
    expect(copyButton.closest('.ai-code-block')).toHaveAttribute('data-language', 'bash');

    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith('df -h');
    const copiedButton = await screen.findByRole('button', { name: 'common.copied' });
    expect(copiedButton.textContent).toBe('');
    expect(copiedButton).not.toHaveAttribute('title');
  });

  it('renders fenced code blocks without actions when disabled', () => {
    const { container } = render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: 'Review:\n```bash\ndf -h\n```' }]}
        streaming={false}
        showCodeBlockActions={false}
      />,
    );

    expect(container.querySelector('pre code')).toHaveTextContent('df -h');
    expect(screen.queryByRole('button', { name: 'common.copy' })).not.toBeInTheDocument();
  });

  it('highlights recognized languages and copies raw source rather than markup', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const source = 'const count: number = 42;\nconsole.log(count);';
    const { container } = render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: `\`\`\`typescript\n${source}\n\`\`\`` }]}
        streaming={false}
      />,
    );

    const code = container.querySelector('.ai-markdown-code-block pre code');
    expect(code).toHaveAttribute('data-highlighted', 'true');
    expect(code?.querySelector('.hljs-keyword')).toHaveTextContent('const');
    expect(code?.querySelector('.hljs-number')).toHaveTextContent('42');

    fireEvent.click(screen.getByRole('button', { name: 'common.copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  });

  it('keeps unknown languages, unlabelled blocks, and oversized blocks as plain text', () => {
    const oversized = `const value = "${'a'.repeat(33 * 1024)}";`;
    const { container } = render(
      <AssistantMessageContent
        blocks={[{
          type: 'text',
          text: [
            '```unknownlang\nconst x = 1;\n```',
            '```\nconst y = 2;\n```',
            `\`\`\`typescript\n${oversized}\n\`\`\``,
          ].join('\n\n'),
        }]}
        streaming={false}
      />,
    );

    const codes = container.querySelectorAll('.ai-markdown-code-block pre code');
    expect(codes).toHaveLength(3);
    for (const code of codes) {
      expect(code).not.toHaveAttribute('data-highlighted');
      expect(code.querySelector('[class*="hljs-"]')).toBeNull();
    }
  });

  it('does not inject highlight markup while a fenced block is still open during streaming, then highlights in place once closed', () => {
    const openMarkdown = '```typescript\nconst count: number = 42;\n';
    const { container, rerender } = render(
      <AssistantMessageContent blocks={[{ type: 'text', text: openMarkdown }]} streaming />,
    );

    const pre = container.querySelector('.ai-markdown-code-block pre');
    expect(pre?.querySelector('code')).not.toHaveAttribute('data-highlighted');
    expect(pre?.querySelector('.hljs-keyword')).toBeNull();

    rerender(
      <AssistantMessageContent blocks={[{ type: 'text', text: `${openMarkdown}\`\`\`` }]} streaming />,
    );

    expect(container.querySelector('.ai-markdown-code-block pre')).toBe(pre);
    expect(pre?.querySelector('code')).toHaveAttribute('data-highlighted', 'true');
    expect(pre?.querySelector('.hljs-keyword')).toHaveTextContent('const');
  });

  it('defers highlight DOM replacement while text inside a streaming code block is selected', () => {
    const openMarkdown = '```typescript\nconst count: number = 42;\n';
    const { container, rerender } = render(
      <AssistantMessageContent blocks={[{ type: 'text', text: openMarkdown }]} streaming />,
    );

    const pre = container.querySelector('.ai-markdown-code-block pre')!;
    const textNode = pre.querySelector('code')!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    rerender(
      <AssistantMessageContent blocks={[{ type: 'text', text: `${openMarkdown}\`\`\`` }]} streaming={false} />,
    );

    expect(pre.querySelector('code')).not.toHaveAttribute('data-highlighted');
    expect(pre.querySelector('code')?.firstChild).toBe(textNode);

    selection.removeAllRanges();
    fireEvent(document, new Event('selectionchange'));

    expect(pre.querySelector('code')).toHaveAttribute('data-highlighted', 'true');
    expect(pre.querySelector('.hljs-keyword')).toHaveTextContent('const');
  });

  it('renders Markdown while streaming', () => {
    const content = '## Run\n\n```bash\ndf -h\n```';
    render(
      <AssistantMessageContent blocks={[{ type: 'text', text: content }]} streaming />,
    );

    expect(screen.getByRole('heading', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.copy' })).toBeInTheDocument();
    expect(screen.queryByText(/```bash/)).not.toBeInTheDocument();
  });

  it('preserves code and table elements and focus while the same Markdown chunk grows', () => {
    const content = '```bash\npnpm test\n```\n\n| Command | Purpose |\n| --- | --- |\n| pnpm test | Tests |\n';
    const { container, rerender } = render(
      <AssistantMessageContent blocks={[{ type: 'text', text: content }]} streaming />,
    );
    const code = container.querySelector('pre');
    const table = container.querySelector<HTMLDivElement>('.ai-markdown-table-scroll')!;
    table.focus();
    rerender(<AssistantMessageContent blocks={[{ type: 'text', text: content + '| pnpm build | Build |\n' }]} streaming />);
    expect(container.querySelector('pre')).toBe(code);
    expect(container.querySelector('.ai-markdown-table-scroll')).toBe(table);
    expect(table).toHaveFocus();
    expect(table).toHaveTextContent('pnpm build');
  });

  it('preserves a large loose list across streaming render chunks', () => {
    const content = `${Array.from(
      { length: 120 },
      (_, index) => `${index + 1}. Item ${index + 1}\n\n`,
    ).join('')}After the list.\n`;
    const { container } = render(
      <AssistantMessageContent blocks={[{ type: 'text', text: content }]} streaming />,
    );

    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(120);
    expect(screen.getByText('After the list.')).toBeInTheDocument();
  });

  it('offers single-line shell command insertion with target name in regular replies and hides it for multiline, non-shell, or unavailable terminals', () => {
    const insert = vi.fn(() => true);
    const markdown = [
      '```bash\nkubectl get pods -n prod\n```',
      '```\nuptime\n```',
      '```bash\necho first\necho second\n```',
      '```typescript\nconst ok = true;\n```',
    ].join('\n\n');

    const { rerender } = render(
      <AiTerminalInsertContext.Provider value={{ targetName: 'prod-web-01', insert }}>
        <AssistantMessageContent blocks={[{ type: 'text', text: markdown }]} streaming={false} />
      </AiTerminalInsertContext.Provider>,
    );

    const insertButtons = screen.getAllByRole('button', { name: 'ai.workspace.question.actionInsertCommandToTarget:prod-web-01' });
    expect(insertButtons).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'common.copy' })).toHaveLength(4);

    fireEvent.click(insertButtons[0]);
    expect(insert).toHaveBeenCalledExactlyOnceWith('kubectl get pods -n prod');
    expect(insertButtons[0]).toHaveAccessibleName('ai.workspace.question.actionInsertedCommand');

    rerender(
      <AiTerminalInsertContext.Provider value={undefined}>
        <AssistantMessageContent blocks={[{ type: 'text', text: markdown }]} streaming={false} />
      </AiTerminalInsertContext.Provider>,
    );

    expect(screen.queryByRole('button', { name: /actionInsertCommand/ })).not.toBeInTheDocument();
  });
});
