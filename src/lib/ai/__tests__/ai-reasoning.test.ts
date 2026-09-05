import { loadResolvedModel } from '@/lib/ai/provider-contract';
vi.mock('@tauri-apps/api/core', async () => ({ invoke: (await import('@/test/llm-resolver-fixture')).fixtureResolve }));
import { describe, expect, it, vi } from 'vitest';
import {
  effectiveReasoningEffort,
  reasoningCapability,
  reasoningEffortOptions,
} from '@/lib/ai/ai-reasoning';
import type { AiProviderProfile } from '@/types/ai';

async function provider(overrides: Partial<AiProviderProfile> = {}): Promise<AiProviderProfile> {
  const config: AiProviderProfile = {
    id: 'provider',
    name: 'Provider',
    kind: 'openAiCompatible',
    preset: 'custom',
    baseUrl: 'https://example.com',
    model: 'model',
    requiresApiKey: true,
    ...overrides,
  };
  await loadResolvedModel(config).catch(() => {});
  return config;
}

describe('AI reasoning capabilities', async () => {
  it('exposes only the effort levels supported by Kimi K3 and DeepSeek V4', async () => {
    expect(reasoningEffortOptions(await provider({
      preset: 'kimi',
      baseUrl: 'https://api.kimi.com/coding',
      model: 'k3',
    }))).toEqual(['low', 'high', 'max']);

    expect(reasoningEffortOptions(await provider({
      preset: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    }))).toEqual(['off', 'low', 'high', 'max']);
  });

  it('exposes a MiniMax M3 thinking toggle without inventing effort levels for M2.x', async () => {
    expect(reasoningCapability(await provider({
      preset: 'minimax',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
    }))).toEqual({ kind: 'toggle', options: ['off', 'on'] });

    expect(reasoningEffortOptions(await provider({
      preset: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M2.7',
    }))).toEqual([]);
  });

  it('uses the official Qwen and GLM compatible-API reasoning controls', async () => {
    expect(reasoningCapability(await provider({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-max',
    }))).toEqual({ kind: 'toggle', options: ['off', 'on'] });
    expect(reasoningEffortOptions(await provider({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-235b-a22b-thinking-2507',
    }))).toEqual([]);

    expect(reasoningCapability(await provider({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.7',
    }))).toEqual({ kind: 'toggle', options: ['off', 'on'] });
    expect(reasoningEffortOptions(await provider({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.2',
    }))).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('uses model-specific OpenAI effort levels', async () => {
    expect(reasoningEffortOptions(await provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.4-mini',
    }))).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);

    expect(reasoningEffortOptions(await provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.2',
    }))).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);

    expect(reasoningEffortOptions(await provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.3-codex-spark',
    }))).toEqual(['low', 'medium', 'high', 'xhigh']);

    expect(reasoningEffortOptions(await provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.6-sol',
    }))).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('distinguishes Ollama thinking toggles from adjustable GPT-OSS effort', async () => {
    const qwen = await provider({
      kind: 'ollama',
      preset: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
    });
    const gptOss = { ...qwen, model: 'gpt-oss:20b' };
    await loadResolvedModel(gptOss);

    expect(reasoningCapability(qwen)).toEqual({ kind: 'toggle', options: ['off', 'on'] });
    expect(reasoningCapability(gptOss)).toEqual({
      kind: 'effort',
      options: ['low', 'medium', 'high'],
    });
  });

  it('omits unsupported or stale settings instead of sending them optimistically', async () => {
    expect(effectiveReasoningEffort(await provider({ reasoningEffort: 'max' }))).toBeUndefined();
    expect(effectiveReasoningEffort(await provider({
      kind: 'openAi',
      preset: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5.1',
      reasoningEffort: 'xhigh',
    }))).toBeUndefined();
  });
});
