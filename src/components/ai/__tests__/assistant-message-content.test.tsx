import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getPlatform } from '@/lib/platform';
import { AssistantMessageContent } from '../assistant-message-content';

const { invokeOpenPath, invokeOpenUrl, invokeRevealPath } = vi.hoisted(() => ({
  invokeOpenPath: vi.fn().mockResolvedValue(undefined),
  invokeOpenUrl: vi.fn().mockResolvedValue(undefined),
  invokeRevealPath: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/platform', () => ({ getPlatform: vi.fn(() => 'windows') }));

vi.mock('@/lib/ipc/tauri', () => ({
  invokeOpenPath,
  invokeOpenUrl,
  invokeRevealPath,
  isTauriRuntime: () => true,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => (
      variables ? `${key}:${variables.seconds}` : key
    ),
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

describe('AssistantMessageContent', () => {
  it('opens an absolute local path from the inline code context menu', async () => {
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: 'Saved at `C:\\Users\\tester\\todo.html`.' }]}
        streaming={false}
      />,
    );

    const path = screen.getByText('C:\\Users\\tester\\todo.html');
    expect(path).toHaveClass('ai-markdown-local-path');
    expect(path).toHaveAttribute('role', 'link');
    expect(path).toHaveAttribute('tabindex', '0');
    fireEvent.click(path);
    expect(invokeOpenPath).toHaveBeenCalledWith('C:\\Users\\tester\\todo.html');
    invokeOpenPath.mockClear();
    fireEvent.keyDown(path, { key: 'Enter' });
    expect(invokeOpenPath).toHaveBeenCalledWith('C:\\Users\\tester\\todo.html');
    invokeOpenPath.mockClear();
    fireEvent.contextMenu(path, { clientX: 120, clientY: 80 });
    const menu = await screen.findByRole('menu');
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ai.path.revealExplorer' }));
    expect(invokeRevealPath).toHaveBeenCalledWith('C:\\Users\\tester\\todo.html');

    fireEvent.contextMenu(path, { clientX: 120, clientY: 80 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ai.path.open' }));
    expect(invokeOpenPath).toHaveBeenCalledWith('C:\\Users\\tester\\todo.html');
  });

  it('uses Finder wording on macOS', async () => {
    vi.mocked(getPlatform).mockReturnValueOnce('macos');
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: 'Saved at `/Users/tester/todo.html`.' }]}
        streaming={false}
      />,
    );

    fireEvent.contextMenu(screen.getByText('/Users/tester/todo.html'));
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
    expect(copyButton).toHaveClass('ai-code-block-copy');
    expect(copyButton.closest('.ai-code-block')).toHaveAttribute('data-language', 'bash');

    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith('df -h');
    const copiedButton = await screen.findByRole('button', { name: 'common.copied' });
    expect(copiedButton).toHaveTextContent('common.copied');
  });

  it('renders fenced code blocks without actions when disabled', () => {
    render(
      <AssistantMessageContent
        blocks={[{ type: 'text', text: 'Review:\n```bash\ndf -h\n```' }]}
        streaming={false}
        showCodeBlockActions={false}
      />,
    );

    expect(screen.getByText('df -h')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.copy' })).not.toBeInTheDocument();
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
});
