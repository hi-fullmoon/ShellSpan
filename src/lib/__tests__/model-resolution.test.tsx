import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fixtureResolve } from '@/test/llm-resolver-fixture';
import { loadResolvedModel, modelResolution, providerCapabilities, useResolvedModel, type ResolvedModel } from '../provider-contract';
import { sessionProviderConfig } from '../ai/session-settings';
import type { AiProviderConfig } from '@/types/ai';

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const provider = (id: string): AiProviderConfig => ({ id, profile: 'qwen', kind: 'openAiCompatible', baseUrl: 'https://proxy.example/v1', model: 'qwen3-vl-plus', requiresApiKey: true });
async function dto(p: AiProviderConfig) { return await fixtureResolve('ai_resolve_model', { provider: p }) as ResolvedModel; }

describe('backend model resolution', () => {
  it('clears facts immediately and ignores an older connection completion after selection changes', async () => {
    const first = provider('race');
    const second = { ...first, baseUrl: 'https://second.example/v1', model: 'qwen3-235b-a22b-instruct-2507' };
    const a = deferred<ResolvedModel>(); const b = deferred<ResolvedModel>();
    mock.invoke.mockImplementation((_command, args) => args.provider.baseUrl === first.baseUrl ? a.promise : b.promise);
    const hook = renderHook(({ p }) => useResolvedModel(p), { initialProps: { p: first } });
    hook.rerender({ p: second });
    expect(hook.result.current.status).toBe('loading');
    expect(providerCapabilities(second).contextWindow).toBeUndefined();
    await act(async () => { a.resolve(await dto(first)); });
    expect(hook.result.current.status).toBe('loading');
    expect(providerCapabilities(second).vision).toBeUndefined();
    await act(async () => { b.resolve(await dto(second)); });
    expect(hook.result.current).toMatchObject({ status: 'ready', model: { modelId: second.model, imageInput: 'unsupported' } });
    hook.unmount();
  });

  it('deduplicates requests, exposes errors, retries, and never sends credentials to capability IPC', async () => {
    const p = provider('retry'); const pending = deferred<ResolvedModel>();
    mock.invoke.mockReturnValueOnce(pending.promise);
    const first = loadResolvedModel(p); const same = loadResolvedModel(p);
    expect(first).toBe(same);
    pending.reject(new Error('resolver unavailable'));
    await expect(first).rejects.toThrow('resolver unavailable');
    expect(modelResolution(p)).toMatchObject({ status: 'error' });
    expect(providerCapabilities(p).reasoningOptions).toEqual([]);
    mock.invoke.mockResolvedValueOnce(await dto(p));
    await loadResolvedModel(p, true);
    expect(modelResolution(p).status).toBe('ready');
    const sent = mock.invoke.mock.calls[mock.invoke.mock.calls.length - 1]?.[1].provider;
    expect(sent).not.toHaveProperty('apiKey');
    expect(sent).not.toHaveProperty('reasoningEffort');
  });

  it('rejects identity mismatches and accepts catalog string reasoning IDs', async () => {
    const p = provider('invalid');
    mock.invoke.mockResolvedValueOnce({ ...await dto(p), modelId: 'wrong' });
    await expect(loadResolvedModel(p)).rejects.toThrow('identity mismatch');
    mock.invoke.mockResolvedValueOnce({ ...await dto(p), reasoning: [{ id: 'ultra', displayName: 'Ultra' }] });
    await expect(loadResolvedModel(p, true)).resolves.toMatchObject({ reasoning: [{ id: 'ultra' }] });
    expect(providerCapabilities(p).reasoningOptions).toEqual(['ultra']);
  });

  it('resolves v5 selections only against the exact route and model', async () => {
    const p = provider('restore'); const model = await dto(p);
    const definition = { contextWindow: model.contextWindow, maxOutputTokens: 8192, toolCalling: model.toolCalling,
      textInput: model.textInput, imageInput: model.imageInput, reasoning: model.reasoning, compat: model.compat, vision: model.vision };
    const stored = { ...p, modelDefinition: definition };
    const selection = { routeId: p.id, modelId: p.model };
    expect(sessionProviderConfig(selection, [stored]).modelDefinition).toEqual(definition);
    for (const changed of [{ ...stored, baseUrl: 'https://other.example' }, { ...stored, model: p.model.toUpperCase() }, { ...stored, id: 'other' }]) {
      if (changed.id === p.id && changed.model === p.model) expect(sessionProviderConfig(selection, [changed])).toMatchObject(changed);
      else expect(() => sessionProviderConfig(selection, [changed])).toThrow('INVALID_MODEL_SELECTION');
    }
    expect(() => sessionProviderConfig({ ...selection, routeRevision: 2 }, [{ ...stored, routeRevision: 3 }]))
      .toThrow('INVALID_MODEL_SELECTION');
  });
});
