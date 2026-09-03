import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMessageContent } from '../assistant-message-content';

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
