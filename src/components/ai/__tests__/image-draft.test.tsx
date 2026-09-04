import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useImageDraft } from '../workspace/use-image-draft';
import type { ImageDraft } from '@/lib/ai/image-drafts';
import { requireVision } from '@/lib/vision-contract';
import { providerCapabilities } from '@/lib/provider-contract';
import { initI18n } from '@/locales';
import { useToastStore } from '@/stores/toastStore';

const mock = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), prepare: vi.fn(), cancel: vi.fn() }));
vi.mock('@/lib/ai/image-drafts', () => ({ readImageDraft: mock.read, writeImageDraft: mock.write }));
vi.mock('@/lib/tauri', () => ({ invokePrepareAgentImages: mock.prepare, invokeCancelAgentImageSubmission: mock.cancel }));
const image = { name: 'fixture.png', mediaType: 'image/png', data: 'aGVsbG8=' };
const draft = (owner: string): ImageDraft => ({ owner, revision: 1, text: 'text', images: [image] });
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const file = { name: 'fixture.png', size: 5, type: 'image/png', arrayBuffer: async () => new TextEncoder().encode('hello').buffer } as File;
beforeEach(async () => {
  await initI18n('en-US');
  useToastStore.setState({ toasts: [] });
  vi.stubGlobal('indexedDB', {});
  mock.read.mockReset().mockImplementation(async owner => draft(owner));
  mock.write.mockReset().mockResolvedValue(undefined);
  mock.prepare.mockReset().mockResolvedValue([image]); mock.cancel.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllGlobals());

describe('image draft count limit', () => {
  it.each([0, 19])('accepts exactly 20 images when the draft already has %i', async count => {
    mock.read.mockResolvedValue({ ...draft('A'), images: Array(count).fill(image) });
    mock.prepare.mockImplementation(async uploads => uploads);
    const hook = renderHook(() => useImageDraft('A', 'text', vi.fn()));
    await waitFor(() => expect(hook.result.current.draft).not.toBeNull());

    await act(async () => hook.result.current.add(Array(20 - count).fill(file)));

    expect(hook.result.current.draft?.images).toHaveLength(20);
    expect(mock.write).toHaveBeenLastCalledWith(expect.objectContaining({ images: Array(20).fill(image) }), 1);
    expect(hook.result.current.error).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it.each([
    [0, 'en-US', 'You can add up to 20 images'],
    [19, 'en-US', 'You can add up to 20 images'],
    [20, 'zh-CN', '最多添加 20 张图片'],
  ] as const)('rejects a batch exceeding 20 with %i existing images and a %s toast', async (count, locale, message) => {
    await initI18n(locale);
    const previous = { ...draft('A'), images: Array(count).fill(image) };
    mock.read.mockResolvedValue(previous);
    const hook = renderHook(() => useImageDraft('A', 'text', vi.fn()));
    await waitFor(() => expect(hook.result.current.draft).toBe(previous));

    await act(async () => hook.result.current.add(Array(21 - count).fill(file)));

    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.write).not.toHaveBeenCalled();
    expect(hook.result.current.draft).toBe(previous);
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ variant: 'error', message })]);
  });

  it('can add another image after removing one from a full draft', async () => {
    mock.read.mockResolvedValue({ ...draft('A'), images: Array(20).fill(image) });
    const hook = renderHook(() => useImageDraft('A', 'text', vi.fn()));
    await waitFor(() => expect(hook.result.current.draft?.images).toHaveLength(20));
    await act(async () => hook.result.current.add([file]));
    expect(mock.prepare).not.toHaveBeenCalled();

    await act(async () => hook.result.current.remove(0));
    await act(async () => hook.result.current.add([file]));

    expect(hook.result.current.draft?.images).toHaveLength(20);
    expect(mock.prepare).toHaveBeenCalledOnce();
    expect(hook.result.current.error).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});

describe('image draft ownership and transaction boundaries', () => {
  it('shows pending previews before file reading finishes and keeps saved images intact', async () => {
    const bytes = deferred<ArrayBuffer>();
    const hook = renderHook(() => useImageDraft('A', 'text', vi.fn()));
    await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    const pendingFile = { ...file, arrayBuffer: () => bytes.promise } as File;
    let adding!: Promise<void>;
    act(() => { adding = hook.result.current.add([pendingFile]); });
    expect(hook.result.current.pendingFiles).toEqual([pendingFile]);
    expect(hook.result.current.draft?.images).toEqual([image]);
    expect(mock.prepare).not.toHaveBeenCalled();

    await act(async () => { bytes.resolve(new TextEncoder().encode('hello').buffer); await adding; });
    expect(hook.result.current.pendingFiles).toEqual([]);
    expect(hook.result.current.draft?.images).toEqual([image, image]);
  });

  it('cancels a pending preview without letting the old import clear a newer one', async () => {
    const first = deferred<typeof image[]>();
    const second = deferred<typeof image[]>();
    mock.prepare.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const hook = renderHook(() => useImageDraft('A', 'text', vi.fn()));
    await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    let oldImport!: Promise<void>;
    act(() => { oldImport = hook.result.current.add([file]); });
    await waitFor(() => expect(mock.prepare).toHaveBeenCalledTimes(1));
    await act(async () => hook.result.current.cancel());
    expect(hook.result.current.pendingFiles).toEqual([]);

    const nextFile = { ...file, name: 'next.png' } as File;
    let nextImport!: Promise<void>;
    act(() => { nextImport = hook.result.current.add([nextFile]); });
    await act(async () => { first.resolve([image]); await oldImport; });
    expect(hook.result.current.pendingFiles).toEqual([nextFile]);
    expect(hook.result.current.busy).toBe(true);
    expect(hook.result.current.draft?.images).toEqual([image]);

    await act(async () => { second.resolve([image]); await nextImport; });
    expect(hook.result.current.pendingFiles).toEqual([]);
    expect(hook.result.current.draft?.images).toHaveLength(2);
  });

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
    expect(hook.result.current.pendingFiles).toEqual([]);
    await act(async () => { prepare.resolve([image]); await pending; }); expect(hook.result.current.draft?.images).toHaveLength(1);
    expect(hook.result.current.pendingFiles).toEqual([]);
  });
});
it('vision uses exact shared models and profile/protocol, including model-specific context', () => {
  const provider = { id: 'test', kind: 'openAiCompatible' as const, baseUrl: 'https://proxy.example', profile: 'qwen' as const, model: 'qwen3-vl-plus', requiresApiKey: false };
  expect(() => requireVision(provider)).not.toThrow(); expect(providerCapabilities(provider).contextWindow).toBe(128000);
  for (const model of ['qwen3-vl-plus-unknown', 'qwen-plus', 'deepseek-chat', 'MiniMax-M2.7']) expect(() => requireVision({ ...provider, model })).toThrow('UNSUPPORTED');
  expect(() => requireVision({ ...provider, profile: 'generic' })).toThrow('UNSUPPORTED');
  expect(() => requireVision({ ...provider, kind: 'ollama' })).toThrow('UNSUPPORTED');
});
