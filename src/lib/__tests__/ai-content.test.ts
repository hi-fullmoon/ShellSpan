import { describe, expect, it } from 'vitest';
import { parseAssistantContent } from '../ai-content';

describe('parseAssistantContent', () => {
  it('separates a completed MiniMax reasoning block from the answer', () => {
    expect(parseAssistantContent(
      '<think>Check the requested language.</think>\n\n你好，有什么可以帮你？',
    )).toEqual({
      answer: '你好，有什么可以帮你？',
      reasoning: 'Check the requested language.',
      reasoningComplete: true,
    });
  });

  it('keeps an unfinished streaming reasoning block out of the answer', () => {
    expect(parseAssistantContent('<think>Still checking')).toEqual({
      answer: '',
      reasoning: 'Still checking',
      reasoningComplete: false,
    });
  });

  it('leaves normal assistant markdown unchanged', () => {
    expect(parseAssistantContent('Use `pnpm test`.')).toEqual({
      answer: 'Use `pnpm test`.',
      reasoning: '',
      reasoningComplete: true,
    });
  });
});
