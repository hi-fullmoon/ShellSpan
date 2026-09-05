import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedModel } from '@/lib/ai/provider-contract';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', () => ({
  isTauriRuntime: () => true,
  invokeListAiSessionMigrations: vi.fn().mockResolvedValue([]),
  invokeConvertAiSessionV4: vi.fn(),
  invokeListAgentRuntimeSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  invokeCancelAgentRuntime: vi.fn(),
  invokeArchiveAgentRuntimeSession: vi.fn(),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: mocks.toast, success: mocks.toast }),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../provider-setup-dialog', () => ({
  ProviderSetupDialog: () => null,
}));

import { AiSettingsSection } from '../ai-settings-section';

const compat = {
  protocol: 'openAiCompatible' as const,
  cumulativeStream: false,
  supportsStreamUsage: true,
  nativeReasoning: false,
  splitReasoning: false,
  replayReasoningContent: false,
  thinkTagFallback: false,
  parallelToolCalls: true,
  strictSchema: true,
  preservesReasoningAcrossTurns: false,
  reasoningEncoding: 'effort' as const,
  clearThinking: false,
  defaultThinking: false,
};

function model(modelId: string): ResolvedModel {
  return {
    catalogVersion: 1,
    routeId: 'route-a',
    providerId: 'route-a',
    modelId,
    profile: 'generic',
    kind: 'openAiCompatible',
    source: 'userDeclaration',
    capacityPolicy: 'explicit',
    contextWindow: 8192,
    maxOutputTokens: 1024,
    toolCalling: 'supported',
    textInput: 'supported',
    imageInput: 'unsupported',
    reasoning: [],
    compat,
  };
}

function definition(modelId: string) {
  const resolved = model(modelId);
  return {
    contextWindow: resolved.contextWindow,
    maxOutputTokens: resolved.maxOutputTokens,
    toolCalling: resolved.toolCalling,
    textInput: resolved.textInput,
    imageInput: resolved.imageInput,
    reasoning: resolved.reasoning,
    compat: resolved.compat,
  };
}

describe('route-backed AI settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.save.mockResolvedValue(undefined);
    useLlmRoutesStore.setState({
      snapshot: {
        schemaVersion: 1,
        revision: 8,
        migrationComplete: true,
        migrationIssues: [],
        defaultSelection: { routeId: 'route-a', modelId: 'model-b' },
        routes: [{
          id: 'route-a',
          revision: 4,
          displayName: 'Connection A',
          adapterId: 'chat-completions',
          baseUrl: 'https://example.com',
          auth: { kind: 'none' },
          replayDomainId: 'domain-a',
          presetId: 'custom',
          models: {
            'model-a': definition('model-a'),
            'model-b': definition('model-b'),
          },
          defaults: { routeId: 'route-a', modelId: 'model-b' },
          retryPolicy: { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4000, maxServerDelayMs: 30_000, jitterRatio: 0.2 },
          timeouts: { requestHeadersMs: 30_000, firstByteMs: 30_000, streamIdleMs: 300_000 },
        }],
      },
      status: 'ready',
      error: undefined,
      modelsByRoute: { 'route-a': [model('model-a'), model('model-b')] },
      save: mocks.save,
    });
  });

  it('deletes one explicit model and moves both route defaults to a valid fallback', async () => {
    render(<AiSettingsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove model-b' }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const [routes, defaultSelection] = mocks.save.mock.calls[0];
    expect(Object.keys(routes[0].models)).toEqual(['model-a']);
    expect(routes[0].defaults).toEqual({ routeId: 'route-a', modelId: 'model-a' });
    expect(defaultSelection).toEqual({ routeId: 'route-a', modelId: 'model-a' });
  });
});
