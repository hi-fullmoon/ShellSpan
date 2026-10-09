import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiSandboxSettings } from '../workspace/ai-sandbox-settings';
import { AiWorkspaceController } from '../workspace/ai-workspace-controller';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { useRemoteSandboxVerification } from '../workspace/use-remote-sandbox-verification';
import { invokeGetAgentRuntimeSession, invokeSandboxSettingsReviewSource } from '@/lib/ipc/tauri';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import { sandboxDefaultScope, useSandboxDefaultsStore } from '@/stores/sandboxDefaultsStore';
import type { AgentSandboxPolicy } from '@/types/agent-session';
import '@/styles/base.css';
import '../styles/styles.css';

const sessionId=new URLSearchParams(location.search).get('session');
const rootEntry=new URLSearchParams(location.search).has('root-entry');
if (!sessionId && !rootEntry) throw new Error('Actual settings review session required');
useAppStore.setState({locale:'zh-CN'});await initI18n('zh-CN');
const initial=sessionId ? await invokeGetAgentRuntimeSession({sessionId}) : undefined;
await useSandboxDefaultsStore.getState().load();
if (rootEntry) {
  const source=await invokeSandboxSettingsReviewSource();
  useTerminalStore.getState().addSession(source, source.profileId);
  if (source.profileId) await useProfileStore.getState().hydrateFromDb();
  useTerminalStore.getState().setStatus(source.sessionId,{sessionId:source.sessionId,status:source.status});
  useAgentPermissionStore.getState().setExecutionSurface(source.sessionId,'direct');
  await useLlmRoutesStore.getState().hydrate();
}
function Acceptance() {
  const [policy,setPolicy]=useState<AgentSandboxPolicy>('workspace');
  const target=initial?.header.target;
  const verification=useRemoteSandboxVerification(target,policy,JSON.stringify(target),true);
  const defaults=useSandboxDefaultsStore(state=>state.defaults);
  const scope=sandboxDefaultScope(target);
  return <div className="ai-panel-shell ai-workspace-root flex h-screen flex-col gap-3 p-3">
    <AiSandboxSettings policy={policy} target={verification.result && target ? {...target,rootPath:verification.result.canonicalRoot} : target} surface="direct" existing={false}
      capability={verification.result?.capability} backendCapability={verification.result?.capability}
      onVerifyRemote={verification.verify} remoteVerificationBusy={verification.busy} remoteVerificationError={verification.error}
      defaultsReady={useSandboxDefaultsStore.getState().initialized && !useSandboxDefaultsStore.getState().loadError}
      defaultConfiguration={scope ? defaults[scope] : undefined} canRememberDefault={Boolean(scope)}
      onRememberDefault={async directories => { if (scope) await useSandboxDefaultsStore.getState().remember(scope,{policy,cacheDirectories:directories}); }}
      onForgetDefault={async () => { if (scope) await useSandboxDefaultsStore.getState().remember(scope,null); }}
      onPolicyChange={setPolicy} />
  </div>;
}
function RootAcceptance() {
  const [locale,setLocale]=useState<'zh-CN'|'en-US'>('zh-CN');
  return <div className="ai-panel-shell flex h-screen min-h-0 flex-col">
    <div className="flex shrink-0 justify-end p-2"><Button size="sm" variant="outline" onClick={() => {
      const next=locale==='zh-CN' ? 'en-US' : 'zh-CN';
      void initI18n(next).then(() => {useAppStore.setState({locale:next});setLocale(next);});
    }}>{locale==='zh-CN' ? 'English' : '中文'}</Button></div>
    <AiWorkspaceController scope="terminal" />
  </div>;
}
createRoot(document.getElementById('root')!).render(<>{rootEntry ? <RootAcceptance /> : <Acceptance />}<Toaster /></>);
