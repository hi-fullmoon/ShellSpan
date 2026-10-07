import { useEffect, useRef, useState } from 'react';
import { invokeVerifyRemoteSandboxTarget } from '@/lib/ipc/tauri';
import type { RemoteSandboxVerification } from '@/types/agent-execution';
import type { AgentSandboxPolicy, AgentSessionTarget } from '@/types/agent-session';

/** Verification belongs to one source generation, target, root and policy. It grants no resources. */
export function useRemoteSandboxVerification(target: AgentSessionTarget | undefined, policy: AgentSandboxPolicy, sourceIdentity: string, enabled: boolean) {
  const key = JSON.stringify([sourceIdentity, target, policy, enabled]);
  const current = useRef(key);
  current.current = key;
  const request = useRef(0);
  const pending = useRef<string | null>(null);
  const [state, setState] = useState<{ key: string; busy: boolean; result?: RemoteSandboxVerification; error?: boolean }>();
  const visible = state?.key === key ? state : undefined;
  useEffect(() => {
    if (!visible?.result) return;
    const timer = setTimeout(() => setState(previous => previous?.key === key ? undefined : previous), 30_000);
    return () => clearTimeout(timer);
  }, [key, visible?.result]);
  useEffect(() => () => { current.current = ''; request.current++; }, []);
  return {
    result: visible?.result,
    busy: visible?.busy ?? false,
    error: visible?.error ?? false,
    verify: async () => {
      if (!enabled || target?.kind !== 'remote' || !target.rootPath || policy === 'host' || pending.current === key) return;
      const identity = key;
      const sequence = ++request.current;
      pending.current = identity;
      setState({ key: identity, busy: true });
      try {
        const result = await invokeVerifyRemoteSandboxTarget(target, policy);
        if (current.current !== identity || sequence !== request.current) return;
        if (result.policy !== policy || result.executionSurface !== 'direct'
          || result.target.kind !== 'remote' || result.target.targetId !== target.targetId || result.target.sessionId !== target.sessionId
          || result.target.profileId !== target.profileId || result.target.host !== target.host
          || result.target.port !== target.port || result.target.username !== target.username
          || result.target.rootPath !== target.rootPath
          || !result.canonicalRoot || !result.sourceBindingDigest || !result.sshHostKeySha256) {
          setState({ key: identity, busy: false, error: true });
          return;
        }
        setState({ key: identity, busy: false, result });
      } catch {
        if (current.current === identity && sequence === request.current) setState({ key: identity, busy: false, error: true });
      } finally {
        if (pending.current === identity) pending.current = null;
      }
    },
  };
}
