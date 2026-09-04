import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useImageDraft } from '../workspace/use-image-draft';
import type { ImageDraft } from '@/lib/ai/image-drafts';
import { requireVision } from '@/lib/vision-contract';
import { providerCapabilities } from '@/lib/provider-contract';

const mock = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), prepare: vi.fn(), cancel: vi.fn() }));
vi.mock('@/lib/ai/image-drafts', () => ({ readImageDraft: mock.read, writeImageDraft: mock.write }));
vi.mock('@/lib/tauri', () => ({ invokePrepareAgentImages: mock.prepare, invokeCancelAgentImageSubmission: mock.cancel }));
const image = { name: 'fixture.png', mediaType: 'image/png', data: 'aGVsbG8=' };
const draft = (owner: string): ImageDraft => ({ owner, revision: 1, text: 'text', images: [image] });
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const file = { name: 'fixture.png', size: 5, type: 'image/png', arrayBuffer: async () => new TextEncoder().encode('hello').buffer } as File;
beforeEach(() => {
  vi.stubGlobal('indexedDB', {});
  mock.read.mockReset().mockImplementation(async owner => draft(owner));
  mock.write.mockReset().mockResolvedValue(undefined);
  mock.prepare.mockReset().mockResolvedValue([image]); mock.cancel.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllGlobals());

describe('image draft ownership and transaction boundaries', () => {
  it.each(['resolve', 'reject'] as const)('old remove %s cannot unlock or alter B, including A→B→A', async outcome => {
    const write = deferred<void>(); mock.write.mockImplementationOnce(() => write.promise);
    const hook = renderHook(({ owner }) => useImageDraft(owner, 'text', vi.fn()), { initialProps: { owner: 'A' } });
    await waitFor(() => expect(hook.result.current.draft?.owner).toBe('A'));
    let pending!: Promise<void>; act(() => { pending = hook.result.current.remove(0); });
    hook.rerender({ owner: 'B' }); await waitFor(() => expect(hook.result.current.draft?.owner).toBe('B'));
    hook.rerender({ owner: 'A' }); await waitFor(() => expect(hook.result.current.draft?.owner).toBe('A'));
    const prepare = deferred<typeof image[]>(); mock.prepare.mockImplementationOnce(() => prepare.promise);
    let adding!: Promise<void>; act(() => { adding = hook.result.current.add([file]); });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));
    await act(async () => { if (outcome === 'resolve') write.resolve(); else write.reject(new Error('old write failure')); await pending; });
    expect(hook.result.current.busy).toBe(true); expect(hook.result.current.error).toBeNull(); expect(hook.result.current.draft?.images).toHaveLength(1);
    await act(async () => { prepare.resolve([image]); await adding; });
    expect(hook.result.current.draft?.images).toHaveLength(2);
  });
  it('old text persistence failure never leaks into a new target', async () => {
    const hook = renderHook(({ owner, text }) => useImageDraft(owner, text, vi.fn()), { initialProps: { owner: 'A', text: 'text' } });
    await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    const write = deferred<void>(); mock.write.mockImplementationOnce(() => write.promise);
    hook.rerender({ owner: 'A', text: 'changed' }); await waitFor(() => expect(mock.write).toHaveBeenCalled());
    hook.rerender({ owner: 'B', text: 'text' }); await waitFor(() => expect(hook.result.current.draft?.owner).toBe('B'));
    await act(async () => write.reject(new Error('old text failure')));
    expect(hook.result.current.error).toBeNull(); expect(hook.result.current.draft?.text).toBe('text');
  });
  it.each([false, true, 'failure'] as const)('old cancel (%s) cannot cancel a new import after ABA navigation', async outcome => {
    mock.read.mockResolvedValueOnce({ ...draft('A'), operation: { id: 'old', sessionId: 'old-session', mode: 'start' } });
    const hook = renderHook(({ owner }) => useImageDraft(owner, 'text', vi.fn()), { initialProps: { owner: 'A' } });
    await waitFor(() => expect(hook.result.current.locked).toBe(true));
    const cancel = deferred<boolean>(); mock.cancel.mockImplementationOnce(() => cancel.promise);
    let pending!: Promise<void>; act(() => { pending = hook.result.current.cancel(); });
    hook.rerender({ owner: 'B' }); await waitFor(() => expect(hook.result.current.draft?.owner).toBe('B'));
    hook.rerender({ owner: 'A' }); await waitFor(() => expect(hook.result.current.locked).toBe(false));
    const prepare = deferred<typeof image[]>(); mock.prepare.mockImplementationOnce(() => prepare.promise);
    let adding!: Promise<void>; act(() => { adding = hook.result.current.add([file]); });
    await waitFor(() => expect(mock.prepare).toHaveBeenCalled());
    await act(async () => { if (outcome === 'failure') cancel.reject(new Error('old cancel failure')); else cancel.resolve(outcome); await pending; });
    expect(hook.result.current.busy).toBe(true); expect(hook.result.current.error).toBeNull();
    await act(async () => { prepare.resolve([image]); await adding; }); expect(hook.result.current.draft?.images).toHaveLength(2);
  });
  it('cannot create/send before durable intent, retains failed draft and reuses its operation', async () => {
    const hook = renderHook(() => useImageDraft('A', 'text', vi.fn())); await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    const write = deferred<void>(); mock.write.mockImplementationOnce(() => write.promise);
    const bind = vi.fn(async () => ({ id: 'same-operation', sessionId: 'fixed-session', mode: 'start' as const }));
    const submit = vi.fn().mockRejectedValueOnce(new Error('lost IPC response')).mockResolvedValue(undefined); const accepted = vi.fn();
    let pending!: Promise<void>; act(() => { pending = hook.result.current.send(bind, submit, accepted); });
    await waitFor(() => expect(mock.write).toHaveBeenCalled()); expect(submit).not.toHaveBeenCalled();
    await act(async () => { write.resolve(); await pending; });
    expect(hook.result.current.locked).toBe(true); expect(hook.result.current.draft?.images).toHaveLength(1); expect(accepted).not.toHaveBeenCalled();
    await act(async () => hook.result.current.send(bind, submit, accepted));
    expect(bind).toHaveBeenCalledTimes(1); expect(submit.mock.calls.map(c => c[0].operation.id)).toEqual(['same-operation', 'same-operation']); expect(accepted).toHaveBeenCalledOnce();
  });
  it('write failure admits no message, and navigation during native import discards stale results', async () => {
    const hook = renderHook(({ owner }) => useImageDraft(owner, 'text', vi.fn()), { initialProps: { owner: 'A' } }); await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    mock.write.mockRejectedValueOnce(new Error('disk full')); const submit = vi.fn();
    await act(async () => hook.result.current.send(async () => ({ id: 'op', sessionId: 's', mode: 'start' }), submit, vi.fn())); expect(submit).not.toHaveBeenCalled(); expect(hook.result.current.draft?.images).toHaveLength(1);
    const prepare = deferred<typeof image[]>(); mock.prepare.mockImplementationOnce(() => prepare.promise);
    let pending!: Promise<void>; act(() => { pending = hook.result.current.add([file]); }); await waitFor(() => expect(mock.prepare).toHaveBeenCalled());
    hook.rerender({ owner: 'B' }); await waitFor(() => expect(hook.result.current.draft?.owner).toBe('B'));
    await act(async () => { prepare.resolve([image]); await pending; }); expect(hook.result.current.draft?.images).toHaveLength(1);
  });
});
it('vision uses exact shared models and profile/protocol, including model-specific context', () => {
  const provider = { id: 'test', kind: 'openAiCompatible' as const, baseUrl: 'https://proxy.example', profile: 'qwen' as const, model: 'qwen3-vl-plus', requiresApiKey: false };
  expect(() => requireVision(provider)).not.toThrow(); expect(providerCapabilities(provider).contextWindow).toBe(128000);
  for (const model of ['qwen3-vl-plus-unknown', 'qwen-plus', 'deepseek-chat', 'MiniMax-M2.7']) expect(() => requireVision({ ...provider, model })).toThrow('UNSUPPORTED');
  expect(() => requireVision({ ...provider, profile: 'generic' })).toThrow('UNSUPPORTED');
  expect(() => requireVision({ ...provider, kind: 'ollama' })).toThrow('UNSUPPORTED');
});
