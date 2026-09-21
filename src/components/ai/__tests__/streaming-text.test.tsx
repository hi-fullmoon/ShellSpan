import { StrictMode } from 'react';
import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '../assistant-message-content';
import { StreamingText, StreamingTextContext } from '../streaming-text';

function Text({ text, streaming = true }: { text: string; streaming?: boolean }) {
  return <StrictMode><StreamingTextContext.Provider value={streaming}>
    <StreamingText>{text}</StreamingText>
  </StreamingTextContext.Provider></StrictMode>;
}

describe('streaming text reveal', () => {
  it('staggers a large arrival in bounded, stable runs without changing copied text', () => {
    const text = readFileSync('AGENTS.md', 'utf8');
    const { container, rerender } = render(<Text text={text} />);
    const runs = [...container.querySelectorAll('.ai-stream-text-run')];
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.length).toBeLessThanOrEqual(8);
    expect(container.textContent).toBe(text);
    expect(runs[runs.length - 1]).toHaveStyle({ animationDelay: `${(runs.length - 1) * 24}ms` });
    rerender(<Text text={text} streaming={false} />);
    expect([...container.querySelectorAll('.ai-stream-text-run')]).toEqual(runs);
    expect(container.querySelector('.ai-stream-text-fragment')).toHaveAttribute('data-reveal');
    expect(container.textContent).toBe(text);
  });

  it('animates first arrival and appended text while preserving previous fragment nodes', () => {
    const { container, rerender } = render(<Text text="Shell" />);
    const initial = container.querySelector('span');
    expect(initial).toHaveTextContent('Shell');
    expect(initial).toHaveAttribute('data-streaming');
    rerender(<Text text="ShellSpan" />);
    const first = container.querySelectorAll('span')[1];
    expect(first).toHaveTextContent('Span');
    rerender(<Text text="ShellSpan 中文 👩‍💻" />);
    expect(container.firstChild?.textContent).toBe('Shell');
    expect(container.querySelector('span')).toBe(initial);
    expect(container.querySelectorAll('span')[1]).toBe(first);
    expect(container.textContent).toBe('ShellSpan 中文 👩‍💻');
    expect(container.querySelectorAll('span')).toHaveLength(3);
  });

  it('shows final text immediately and never animates history or replacements', () => {
    const { container, rerender } = render(<Text text="Shell" />);
    rerender(<Text text="ShellSpan" />);
    const fragments = [...container.querySelectorAll('span')];
    rerender(<Text text="ShellSpan complete" streaming={false} />);
    expect(container.textContent).toBe('ShellSpan complete');
    expect([...container.querySelectorAll('span')].slice(0, 2)).toEqual(fragments);
    expect(container.querySelector('[data-streaming]')).toBeNull();
    rerender(<Text text="Replaced" />);
    expect(container.textContent).toBe('Replaced');
    expect(container.querySelector('span')).toBeNull();
    rerender(<Text text="Replaced again" />);
    expect(container.querySelector('span')?.textContent).toBe(' again');
    rerender(<Text text="" />);
    expect(container.textContent).toBe('');
  });

  it.each(['ShellSpan', 'ShellSpan complete'])('preserves a native selection on completion: %s', (finalText) => {
    const { container, rerender } = render(<Text text="Shell" />);
    rerender(<Text text="ShellSpan" />);
    const textNode = container.querySelectorAll('span')[1].firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe('Span');
    rerender(<Text text={finalText} streaming={false} />);
    expect(selection.toString()).toBe('Span');
    expect(selection.anchorNode).toBe(textNode);
    selection.removeAllRanges();
  });

  it('does not animate a historical message on mount', () => {
    const { container } = render(<Text text="ShellSpan" streaming={false} />);
    expect(container.textContent).toBe('ShellSpan');
    expect(container.querySelector('span')).toBeNull();
  });

  it('animates new paragraphs and list items on first arrival without remounting the heading', () => {
    const markdown = (text: string) => (
      <StreamingTextContext.Provider value>
        <MarkdownContent copiedLabel="Copied" copyLabel="Copy" showCodeBlockActions={false}>
          {text}
        </MarkdownContent>
      </StreamingTextContext.Provider>
    );
    const { container, rerender } = render(markdown('# ShellSpan'));
    const heading = container.querySelector('h1 span');
    expect(heading).toHaveAttribute('data-streaming');
    rerender(markdown('# ShellSpan\n\nTerminal workspace.\n\n- SSH\n- SFTP'));
    expect(container.querySelector('h1 span')).toBe(heading);
    expect(container.querySelector('p span')).toHaveAttribute('data-streaming');
    expect(container.querySelectorAll('li span[data-streaming]')).toHaveLength(2);
  });

  it('bounds fragment nodes during a long uninterrupted stream without losing text', () => {
    const { container, rerender } = render(<Text text="" />);
    let text = '';
    for (let index = 0; index < 200; index += 1) {
      text += `${index} `;
      rerender(<Text text={text} />);
      expect(container.textContent).toBe(text);
      expect(container.querySelectorAll('span').length).toBeLessThanOrEqual(24);
    }
  });

  it.each([
    ['👩', '👩‍💻'],
    ['e', 'e\u0301'],
    ['\ud83d', '😀'],
    ['🇨', '🇨🇳'],
  ])('keeps a grapheme completed across deltas in one text node: %s', (start, completed) => {
    const { container, rerender } = render(<Text text={start} />);
    rerender(<Text text={completed} />);
    expect(container.textContent).toBe(completed);
    expect(container.querySelector('span')).toBeNull();
    expect(container.childNodes).toHaveLength(1);
    rerender(<Text text={`${completed} ShellSpan`} />);
    expect(container.querySelector('span')?.textContent).toBe(' ShellSpan');
  });

  it('preserves parsed emphasis and settles incomplete Markdown without replaying old text', () => {
    const markdown = (text: string, streaming = true) => (
      <StreamingTextContext.Provider value={streaming}>
        <MarkdownContent copiedLabel="Copied" copyLabel="Copy" showCodeBlockActions={false}>
          {text}
        </MarkdownContent>
      </StreamingTextContext.Provider>
    );
    const { container, rerender } = render(markdown('**Shell'));
    rerender(markdown('**ShellSpan**'));
    expect(container.querySelector('strong')).toHaveTextContent('ShellSpan');
    expect(container.querySelector('.ai-stream-text-fragment')).toBeNull();
    rerender(markdown('**ShellSpan terminal**'));
    expect(container.querySelector('strong .ai-stream-text-fragment')?.textContent).toBe(' terminal');
    rerender(markdown('**ShellSpan terminal**', false));
    expect(container.querySelector('strong')).toHaveTextContent('ShellSpan terminal');
    expect(container.querySelector('.ai-stream-text-fragment')).toBeInTheDocument();
    expect(container.querySelector('.ai-stream-text-fragment')).not.toHaveAttribute('data-streaming');
  });
});
