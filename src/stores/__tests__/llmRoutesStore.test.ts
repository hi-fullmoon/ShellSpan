import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteSnapshot } from '@/types/ai';

const mocks = vi.hoisted(() => ({
  listRoutes: vi.fn(),
  listModels: vi.fn(),
  saveRoutes: vi.fn(),
}));
vi.mock('@/lib/ipc/tauri', () => ({
  invokeListAiRoutes: mocks.listRoutes,
  invokeListAiRouteModels: mocks.listModels,
  invokeSaveAiRoutes: mocks.saveRoutes,
}));

import { useLlmRoutesStore } from '../llmRoutesStore';

const snapshot = (revision: number): RouteSnapshot => ({
  schemaVersion: 1,
  revision,
  defaultSelection: { routeId: 'route-a', modelId: 'model-a' },
  routes: [{
    id: 'route-a', revision, displayName: 'Connection A', adapterId: 'chat-completions',
    baseUrl: 'https://example.com', auth: { kind: 'none' }, replayDomainId: 'domain-a',
    models: undefined, modelOverrides: undefined, presetId: 'generic',
    defaults: { routeId: 'route-a', modelId: 'model-a' },
    retryPolicy: { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4_000, maxServerDelayMs: 30_000, jitterRatio: 0.2 },
    timeouts: { requestHeadersMs: 30_000, firstByteMs: 30_000, streamIdleMs: 300_000 },
  }],
});

describe('llmRoutesStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLlmRoutesStore.setState({ snapshot: undefined, status: 'idle', error: undefined, modelsByRoute: {} });
  });

  it('uses the backend effective list even when the route has no explicit models map', async () => {
    mocks.listRoutes.mockResolvedValue(snapshot(4));
    mocks.listModels.mockResolvedValue({ revision: 4, models: [{ routeId: 'route-a', modelId: 'model-a' }, { routeId: 'route-a', modelId: 'model-b' }] });
    await useLlmRoutesStore.getState().hydrate();
    expect(useLlmRoutesStore.getState().modelsByRoute['route-a'].map(model => model.modelId)).toEqual(['model-a', 'model-b']);
    expect(mocks.listModels).toHaveBeenCalledWith('route-a');
  });

  it('keeps the last valid snapshot visible when optimistic save fails', async () => {
    useLlmRoutesStore.setState({ snapshot: snapshot(7), status: 'ready' });
    mocks.saveRoutes.mockRejectedValue(new Error('REVISION_CONFLICT'));
    await expect(useLlmRoutesStore.getState().save(snapshot(7).routes, snapshot(7).defaultSelection)).rejects.toThrow('REVISION_CONFLICT');
    expect(useLlmRoutesStore.getState().snapshot?.revision).toBe(7);
    expect(useLlmRoutesStore.getState()).toMatchObject({ status: 'error', error: 'Error: REVISION_CONFLICT' });
  });

  it('does not publish model responses bound to an older route snapshot', async () => {
    mocks.listRoutes.mockResolvedValueOnce(snapshot(5)).mockResolvedValueOnce(snapshot(6));
    mocks.listModels.mockResolvedValueOnce({ revision: 4, models: [{ routeId: 'route-a', modelId: 'stale' }] })
      .mockResolvedValueOnce({ revision: 6, models: [{ routeId: 'route-a', modelId: 'current' }] });
    await useLlmRoutesStore.getState().hydrate();
    expect(useLlmRoutesStore.getState().snapshot?.revision).toBe(6);
    expect(useLlmRoutesStore.getState().modelsByRoute['route-a'].map(model => model.modelId)).toEqual(['current']);
  });

  it('bounds revision mismatch retries and deduplicates concurrent hydrate calls', async () => {
    mocks.listRoutes.mockResolvedValue(snapshot(5));
    mocks.listModels.mockResolvedValue({ revision: 4, models: [{ routeId: 'route-a', modelId: 'stale' }] });
    await Promise.all([
      useLlmRoutesStore.getState().hydrate(),
      useLlmRoutesStore.getState().hydrate(),
    ]);
    expect(mocks.listRoutes).toHaveBeenCalledTimes(4);
    expect(useLlmRoutesStore.getState()).toMatchObject({ status: 'error', error: 'Error: ROUTE_REVISION_MISMATCH' });
  });

  it('starts a fresh hydrate on save revision mismatch instead of reusing a stale in-flight hydrate', async () => {
    useLlmRoutesStore.setState({ snapshot: snapshot(5), status: 'ready' });
    let resolveStale!: (value: RouteSnapshot) => void;
    const staleRoutes = new Promise<RouteSnapshot>(resolve => { resolveStale = resolve; });
    mocks.listRoutes
      .mockReturnValueOnce(staleRoutes)
      .mockResolvedValueOnce(snapshot(7));
    mocks.saveRoutes.mockResolvedValueOnce(snapshot(6));
    mocks.listModels
      .mockResolvedValueOnce({ revision: 7, models: [{ routeId: 'route-a', modelId: 'newer' }] })
      .mockResolvedValueOnce({ revision: 7, models: [{ routeId: 'route-a', modelId: 'newer' }] })
      .mockResolvedValueOnce({ revision: 5, models: [{ routeId: 'route-a', modelId: 'stale' }] });

    const staleHydrate = useLlmRoutesStore.getState().hydrate();
    const saved = await useLlmRoutesStore.getState().save(snapshot(5).routes, snapshot(5).defaultSelection);
    resolveStale(snapshot(5));
    await staleHydrate;

    expect(saved.revision).toBe(7);
    expect(useLlmRoutesStore.getState().snapshot?.revision).toBe(7);
    expect(useLlmRoutesStore.getState().modelsByRoute['route-a'].map(m => m.modelId)).toEqual(['newer']);
  });
});
