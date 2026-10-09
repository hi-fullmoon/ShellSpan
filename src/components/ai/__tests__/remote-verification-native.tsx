import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { invokeGetAgentRuntimeSession } from '@/lib/ipc/tauri';
import { useRemoteSandboxVerification } from '../workspace/use-remote-sandbox-verification';
import type { AgentSandboxPolicy } from '@/types/agent-session';

const sessionId = new URLSearchParams(location.search).get('session');
if (!sessionId) throw new Error('Real native Session required');
const initial = await invokeGetAgentRuntimeSession({ sessionId });

function Regression() {
  const [policy, setPolicy] = useState<AgentSandboxPolicy>('workspace');
  const verification = useRemoteSandboxVerification(initial.header.target, policy, sessionId!, true);
  const latest = useRef(verification);
  latest.current = verification;
  const started = useRef(false);
  useEffect(() => {
    // Start after StrictMode's real setup/cleanup cycle. Never replace IPC.
    const timer = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      void run();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function rendered() {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }
  async function roundtrip() {
    flushSync(() => setPolicy('readOnly'));
    await rendered();
    flushSync(() => setPolicy('workspace'));
    await rendered();
  }
  async function run() {
    await latest.current.verify();
    await rendered();
    const firstVerified = latest.current.result?.capability.status === 'partial';
    await roundtrip();
    const completedPolicyRoundtripDiscarded = latest.current.result === undefined;
    const inFlight = latest.current.verify();
    await roundtrip();
    await inFlight;
    await rendered();
    const inFlightPolicyRoundtripDiscarded = latest.current.result === undefined;
    await latest.current.verify();
    await rendered();
    await invoke('sandbox_settings_review_verification_result', { checks: {
      firstVerified,
      completedPolicyRoundtripDiscarded,
      inFlightPolicyRoundtripDiscarded,
      freshVerificationSucceeds: latest.current.result?.capability.status === 'partial',
    } });
  }
  return <p>Real SSH verification regression running</p>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Regression /></StrictMode>);
