import { useEffect, useRef, useState } from 'react';
import { invokeVerifyRemoteSandboxTarget } from '@/lib/ipc/tauri';
import type { RemoteSandboxVerification } from '@/types/agent-execution';
import type { AgentSandboxPolicy, AgentSessionTarget } from '@/types/agent-session';

/** Verification belongs to one source generation, target, root and policy. It grants no resources. */
export function useRemoteSandboxVerification(target: AgentSessionTarget | undefined, policy: AgentSandboxPolicy, sourceIdentity: string, enabled: boolean) {
  const key = JSON.stringify([sourceIdentity, target, policy, enabled]);
  // Returning to an identical target/policy must never revive an old result.
  const current = useRef({ key });
  if (current.current.key !== key) current.current = { key };
  const epoch = current.current;
  const mounted = useRef(false);
  const request = useRef(0);
  const pending = useRef<typeof epoch | null>(null);
  const [state, setState] = useState<{ epoch: typeof epoch; busy: boolean; result?: RemoteSandboxVerification; error?: boolean }>();
  const visible = state?.epoch === epoch ? state : undefined;
  useEffect(() => {
    if (!visible?.result) return;
    const timer = setTimeout(() => setState(previous => previous?.epoch === epoch ? undefined : previous), 30_000);
    return () => clearTimeout(timer);
  }, [epoch, visible?.result]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; };
  }, []);
  return {
    result: visible?.result,
    busy: visible?.busy ?? false,
    error: visible?.error ?? false,
    verify: async () => {
      if (!mounted.current || current.current !== epoch || !enabled || target?.kind !== 'remote' || !target.rootPath || policy === 'host' || pending.current === epoch) return;
      const identity = epoch;
      const sequence = ++request.current;
      pending.current = identity;
      setState({ epoch: identity, busy: true });
      try {
        const result = await invokeVerifyRemoteSandboxTarget(target, policy);
        if (!mounted.current || current.current !== identity || sequence !== request.current) return;
        if (result.policy !== policy || result.executionSurface !== 'direct'
          || result.target.kind !== 'remote' || result.target.targetId !== target.targetId || result.target.sessionId !== target.sessionId
          || result.target.profileId !== target.profileId || result.target.host !== target.host
          || result.target.port !== target.port || result.target.username !== target.username
          || result.target.rootPath !== target.rootPath
          || !result.canonicalRoot || !result.sourceBindingDigest || !result.sshHostKeySha256) {
          setState({ epoch: identity, busy: false, error: true });
          return;
        }
        setState({ epoch: identity, busy: false, result });
      } catch {
        if (mounted.current && current.current === identity && sequence === request.current) setState({ epoch: identity, busy: false, error: true });
      } finally {
        if (pending.current === identity) pending.current = null;
      }
    },
  };
}
