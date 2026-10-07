import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiSandboxSettings } from '../workspace/ai-sandbox-settings';
import { invokeGetAgentRuntimeSession, invokeRevokeSandboxReads } from '@/lib/ipc/tauri';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '../styles/styles.css';

const sessionId = new URLSearchParams(location.search).get('session');
if (!sessionId) throw new Error('Native acceptance session required');
useAppStore.setState({ locale: 'zh-CN' });
await initI18n('zh-CN');
const initial = await invokeGetAgentRuntimeSession({ sessionId });

function Acceptance() {
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function revoke() {
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(await invokeRevokeSandboxReads(initial.header.sessionId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return <div className="ai-panel-shell ai-workspace-root flex h-screen flex-col gap-3 p-3">
    <AiSandboxSettings existing policy={snapshot.header.sandboxPolicy} capability={snapshot.sandboxCapability}
      sessionId={snapshot.header.sessionId} revision={snapshot.header.sandboxBindingRevision}
      target={snapshot.header.target} surface={snapshot.header.executionSurface ?? 'direct'}
      onPolicyChange={() => {}} onRevokeReads={() => { void revoke(); }} revokeBusy={busy} />
    {error && <p role="alert">{error}</p>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Acceptance />);
