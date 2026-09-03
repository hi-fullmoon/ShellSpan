import { describe, expect, it } from 'vitest';
import {
  effectiveReasoningEffort,
  reasoningCapability,
  reasoningEffortOptions,
} from '@/lib/ai-reasoning';
import type { AiProviderProfile } from '@/types/ai';

function provider(overrides: Partial<AiProviderProfile> = {}): AiProviderProfile {
  return {
    id: 'provider',
    name: 'Provider',
    kind: 'openAiCompatible',
    preset: 'custom',
    baseUrl: 'https://example.com',
    model: 'model',
    requiresApiKey: true,
    ...overrides,
  };
}

describe('AI reasoning capabilities', () => {
  it('exposes only the effort levels supported by Kimi K3 and DeepSeek V4', () => {
    expect(reasoningEffortOptions(provider({
      preset: 'kimi',
      baseUrl: 'https://api.kimi.com/coding',
      model: 'k3',
    }))).toEqual(['low', 'high', 'max']);

    expect(reasoningEffortOptions(provider({
      preset: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    }))).toEqual(['off', 'low', 'high', 'max']);
  });

  it('exposes a MiniMax M3 thinking toggle without inventing effort levels for M2.x', () => {
    expect(reasoningCapability(provider({
      preset: 'minimax',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
    }))).toEqual({ kind: 'toggle', options: ['off', 'on'] });

    expect(reasoningEffortOptions(provider({
      preset: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M2.7',
    }))).toEqual([]);
  });

  it('uses the official Qwen and GLM compatible-API reasoning controls', () => {
    expect(reasoningCapability(provider({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-max',
    }))).toEqual({ kind: 'toggle', options: ['off', 'on'] });
    expect(reasoningEffortOptions(provider({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-235b-a22b-thinking-2507',
    }))).toEqual([]);

    expect(reasoningCapability(provider({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.7',
    }))).toEqual({ kind: 'toggle', options: ['off', 'on'] });
    expect(reasoningEffortOptions(provider({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.2',
    }))).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('uses model-specific OpenAI effort levels', () => {
    expect(reasoningEffortOptions(provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.4-mini',
    }))).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);

    expect(reasoningEffortOptions(provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.2',
    }))).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);

    expect(reasoningEffortOptions(provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.3-codex-spark',
    }))).toEqual(['low', 'medium', 'high', 'xhigh']);

    expect(reasoningEffortOptions(provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.6-sol',
    }))).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('distinguishes Ollama thinking toggles from adjustable GPT-OSS effort', () => {
    const qwen = provider({
      kind: 'ollama',
      preset: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
    });
    const gptOss = { ...qwen, model: 'gpt-oss:20b' };

    expect(reasoningCapability(qwen)).toEqual({ kind: 'toggle', options: ['off', 'on'] });
    expect(reasoningCapability(gptOss)).toEqual({
      kind: 'effort',
      options: ['low', 'medium', 'high'],
    });
  });

  it('omits unsupported or stale settings instead of sending them optimistically', () => {
    expect(effectiveReasoningEffort(provider({ reasoningEffort: 'max' }))).toBeUndefined();
    expect(effectiveReasoningEffort(provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.1',
      reasoningEffort: 'xhigh',
    }))).toBeUndefined();
  });
});
