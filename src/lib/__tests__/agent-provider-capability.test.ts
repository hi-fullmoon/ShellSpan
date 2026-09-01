import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectAgentProviderCapabilityCached,
  resetAgentProviderCapabilityCacheForTests,
} from '../agent-provider-capability';
import type { AiProviderConfig, AiProviderProfile } from '@/types/ai';

function profile(model = 'model-a'): AiProviderProfile {
  return {
    id: 'provider-1',
    name: 'Compatible provider',
    preset: 'custom',
    kind: 'openAiCompatible',
    baseUrl: 'https://provider.example.com/v1',
    model,
    requiresApiKey: true,
  };
}

describe('Agent provider capability cache', () => {
  beforeEach(() => resetAgentProviderCapabilityCacheForTests());

  it('coalesces concurrent probes and reuses the result for the same immutable profile', async () => {
    const detector = vi.fn(async (_provider: AiProviderConfig) => ({
      support: 'supported' as const,
      source: 'chatCompletionsProbe' as const,
    }));
    const current = profile();

    const [first, second] = await Promise.all([
      detectAgentProviderCapabilityCached(current, current, detector),
      detectAgentProviderCapabilityCached(current, current, detector),
    ]);
    const third = await detectAgentProviderCapabilityCached(current, current, detector);

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(detector).toHaveBeenCalledTimes(1);
  });

  it('reprobes when the settings store replaces the provider configuration', async () => {
    const detector = vi.fn(async (_provider: AiProviderConfig) => ({
      support: 'supported' as const,
      source: 'chatCompletionsProbe' as const,
    }));
    const original = profile('model-a');
    const updated = { ...original, model: 'model-b' };

    await detectAgentProviderCapabilityCached(original, original, detector);
    await detectAgentProviderCapabilityCached(updated, updated, detector);

    expect(detector).toHaveBeenCalledTimes(2);
    expect(detector.mock.calls[1]?.[0]).toMatchObject({ model: 'model-b' });
  });
});
