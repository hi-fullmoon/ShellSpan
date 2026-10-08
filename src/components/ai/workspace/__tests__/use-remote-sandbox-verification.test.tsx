import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRemoteSandboxVerification } from '../use-remote-sandbox-verification';
import { invokeVerifyRemoteSandboxTarget } from '@/lib/ipc/tauri';
import type { RemoteSandboxVerification } from '@/types/agent-execution';
import type { AgentSandboxPolicy, AgentSessionTarget } from '@/types/agent-session';

vi.mock('@/lib/ipc/tauri', () => ({ invokeVerifyRemoteSandboxTarget: vi.fn() }));
const verify = vi.mocked(invokeVerifyRemoteSandboxTarget);
const target: AgentSessionTarget = { kind: 'remote', targetId: 'remote', sessionId: 'ssh', host: 'fixture', port: 22, username: 'operator', rootPath: '/project' };
const result: RemoteSandboxVerification = {
  target, policy: 'workspace', executionSurface: 'direct', canonicalRoot: '/project',
  remoteUid: 501, sshHostKeySha256: 'host-key', sourceBindingDigest: 'binding',
  capability: { status: 'partial', files: true, network: true, processLifecycle: false, gaps: [] },
};
const defaults = { target, policy: 'workspace' as AgentSandboxPolicy, source: 'source', enabled: true };
function setup() {
  return renderHook(props => useRemoteSandboxVerification(props.target, props.policy, props.source, props.enabled), { initialProps: defaults });
}
function deferred() {
  let resolve!: (value: RemoteSandboxVerification) => void;
  const promise = new Promise<RemoteSandboxVerification>(accept => { resolve = accept; });
  return { promise, resolve };
}
beforeEach(() => { verify.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('verifies successfully after Strict Mode effect replay', async () => {
  verify.mockResolvedValue(result);
  const hook = renderHook(() => useRemoteSandboxVerification(target, 'workspace', 'source', true), {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
  await act(async () => { await hook.result.current.verify(); });
  expect(hook.result.current.result).toEqual(result);
  expect(hook.result.current.busy).toBe(false);
});

it.each(['target', 'policy', 'source', 'enabled'] as const)('discards completed verification permanently when %s changes and returns', async field => {
  verify.mockResolvedValue(result);
  const hook = setup();
  await act(async () => { await hook.result.current.verify(); });
  const changed = { ...defaults };
  if (field === 'target') changed.target = { ...target, rootPath: '/other' };
  if (field === 'policy') changed.policy = 'readOnly';
  if (field === 'source') changed.source = 'other';
  if (field === 'enabled') changed.enabled = false;
  hook.rerender(changed);
  expect(hook.result.current.result).toBeUndefined();
  hook.rerender(defaults);
  expect(hook.result.current.result).toBeUndefined();
});

it('rejects an old response after returning to a target and preserves the newer pending request', async () => {
  const old = deferred();
  const fresh = deferred();
  verify.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const hook = setup();
  let oldRun!: Promise<void>;
  act(() => { oldRun = hook.result.current.verify(); });
  hook.rerender({ ...defaults, target: { ...target, rootPath: '/other' } });
  hook.rerender(defaults);
  let freshRun!: Promise<void>;
  act(() => { freshRun = hook.result.current.verify(); });
  await act(async () => { old.resolve(result); await oldRun; });
  expect(hook.result.current.result).toBeUndefined();
  expect(hook.result.current.busy).toBe(true);
  await act(async () => { await hook.result.current.verify(); });
  expect(verify).toHaveBeenCalledTimes(2);
  await act(async () => { fresh.resolve(result); await freshRun; });
  expect(hook.result.current.result).toEqual(result);
});

it('expires verification after thirty seconds', async () => {
  vi.useFakeTimers();
  verify.mockResolvedValue(result);
  const hook = setup();
  await act(async () => { await hook.result.current.verify(); });
  act(() => { vi.advanceTimersByTime(29_999); });
  expect(hook.result.current.result).toEqual(result);
  act(() => { vi.advanceTimersByTime(1); });
  expect(hook.result.current.result).toBeUndefined();
});

it('rejects verification with a different SSH identity', async () => {
  verify.mockResolvedValue({ ...result, target: { ...target, username: 'other' } });
  const hook = setup();
  await act(async () => { await hook.result.current.verify(); });
  expect(hook.result.current.result).toBeUndefined();
  expect(hook.result.current.error).toBe(true);
});

it('does not dispatch when disabled, using host policy, or missing a remote root', async () => {
  const hook = setup();
  hook.rerender({ ...defaults, enabled: false });
  await act(async () => { await hook.result.current.verify(); });
  hook.rerender({ ...defaults, policy: 'host' });
  await act(async () => { await hook.result.current.verify(); });
  hook.rerender({ ...defaults, target: { ...target, rootPath: undefined } });
  await act(async () => { await hook.result.current.verify(); });
  hook.rerender({ ...defaults, target: { kind: 'local', targetId: 'local', sessionId: 'local' } });
  await act(async () => { await hook.result.current.verify(); });
  expect(verify).not.toHaveBeenCalled();
});

it('does not publish an in-flight result after unmount', async () => {
  const pending = deferred();
  verify.mockReturnValue(pending.promise);
  const hook = setup();
  let run!: Promise<void>;
  act(() => { run = hook.result.current.verify(); });
  hook.unmount();
  await act(async () => { pending.resolve(result); await run; });
  expect(hook.result.current.result).toBeUndefined();
});
