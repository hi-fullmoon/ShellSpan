import { describe, expect, it } from 'vitest';
import {
  buildMiniMaxLiveEnv,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_MODEL,
  validatedMiniMaxBaseUrl,
} from '../run-agent-provider-acceptance.mjs';

describe('MiniMax live provider acceptance', () => {
  it('uses independent MiniMax defaults and strips OpenAI credentials', () => {
    const env = buildMiniMaxLiveEnv({
      MINIMAX_API_KEY: 'minimax-test-secret',
      OPENAI_API_KEY: 'must-not-cross-provider-boundary',
      OPENAI_BASE_URL: 'https://example.invalid',
    });

    expect(env).toMatchObject({
      SHELLSPAN_M6_MINIMAX_LIVE: '1',
      SHELLSPAN_M6_MINIMAX_BASE_URL: DEFAULT_MINIMAX_BASE_URL,
      SHELLSPAN_M6_MINIMAX_MODEL: DEFAULT_MINIMAX_MODEL,
      MINIMAX_API_KEY: 'minimax-test-secret',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_BASE_URL');
  });

  it('fails before launching the live test when the MiniMax key is absent', () => {
    expect(() => buildMiniMaxLiveEnv({ OPENAI_API_KEY: 'not-a-minimax-key' }))
      .toThrow('MINIMAX_API_KEY is required');
  });

  it('only permits official MiniMax HTTPS service roots', () => {
    expect(validatedMiniMaxBaseUrl('https://api.minimaxi.com/')).toBe(
      'https://api.minimaxi.com',
    );
    expect(validatedMiniMaxBaseUrl('https://api.minimax.io/v1/')).toBe(
      'https://api.minimax.io/v1',
    );
    expect(() => validatedMiniMaxBaseUrl('http://api.minimaxi.com')).toThrow();
    expect(() => validatedMiniMaxBaseUrl('https://compatible.example/v1')).toThrow();
    expect(() => validatedMiniMaxBaseUrl('https://api.minimaxi.com/other')).toThrow();
  });
});
