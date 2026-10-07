import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiSandboxSettings } from '../workspace/ai-sandbox-settings';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { AiSessionHeader } from '../workspace/ai-session-header';
import { AgentExecutionSurfaceSelector } from '../agent-execution-surface-selector';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { useRemoteSandboxVerification } from '../workspace/use-remote-sandbox-verification';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { initI18n, t } from '@/locales';
import { sandboxPolicyLabels } from '@/lib/ai/sandbox-presentation';
import { useAppStore } from '@/stores/appStore';
import type { AgentSandboxCapability, AgentSandboxPolicy, AgentSessionTarget } from '@/types/agent-session';
import '@/styles/base.css';
import '../styles/styles.css';

const locale = new URLSearchParams(location.search).get('locale') === 'en-US' ? 'en-US' : 'zh-CN';
useAppStore.setState({ locale });
await initI18n(locale);
const native = new URLSearchParams(location.search).has('native')
  ? await fetch('/native-sandbox-evidence').then(response => response.json()) as { capability: AgentSandboxCapability; target: AgentSessionTarget } : undefined;
const remoteTarget = new URLSearchParams(location.search).has('remote')
  ? await fetch('/native-remote-target').then(response => response.json()) as AgentSessionTarget : undefined;

function Preview() {
  const [policy, setPolicy] = useState<AgentSandboxPolicy>('workspace');
  const [target, setTarget] = useState(remoteTarget ?? native?.target);
  const [rootRequest, setRootRequest] = useState(0);
  const remote = useRemoteSandboxVerification(target, policy, JSON.stringify(target), Boolean(remoteTarget));
  return <div className="ai-panel-shell ai-workspace-root @container/ai-workspace flex h-screen min-w-0 flex-col">
    <AiSessionHeader title="Agent" context="Terminal" status="idle" policySummary={`${t(sandboxPolicyLabels[policy])} · ${t(policy === 'host' ? 'agent.sandbox.notIsolated' : native ? 'agent.sandbox.partial' : 'agent.sandbox.unavailable')}`} onNewSession={() => {}}
      settingsControl={<AiSandboxSettings policy={policy} existing={false} surface={native || remoteTarget ? 'direct' : 'boundTerminal'} capability={native?.capability} target={target} onPolicyChange={setPolicy}
        onChooseProjectRoot={() => setRootRequest(value => value + 1)} onVerifyRemote={remoteTarget ? remote.verify : undefined} remoteVerificationBusy={remote.busy} remoteVerificationError={remote.error} />} />
    <div className="min-h-0 flex-1" />
    <AiComposerSeat mode="agent" phase="active" status="idle"
      projectRootRequest={rootRequest} onSelectProjectRoot={async root => { if (target) setTarget(target.kind === 'local' ? {...target,cwd:root,localRoot:root} : {...target,rootPath:root}); }}
      permissionControl={<AgentPermissionSelector sessionId="preview" variant="composer" mode="requestApproval" />}
      executionSurfaceControl={
        <AgentExecutionSurfaceSelector surface={native ? 'direct' : 'boundTerminal'} boundTerminalDisabled={policy !== 'host'} disabled={!native && policy !== 'host'} />
      }
    />
  </div>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Preview />);

// Static menu layout review has no connection, approval handler, or runtime authority.
export function showApprovalMenu() {
  root.render(<div className="ai-panel-shell ai-workspace-root @container/ai-workspace flex h-screen items-end p-3">
    <DropdownMenu open>
      <DropdownMenuTrigger render={<Button variant="ghost" size="xs" />}>{t('agent.permission.approval')}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="ai-permission-menu w-[240px] max-w-[calc(100vw-16px)] p-[3px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px]">{t('agent.permission.approval')}</DropdownMenuLabel>
          {(['agent.permission.composer.readOnly', 'agent.permission.requestApproval', 'agent.permission.composer.fullAccess'] as const).map(key => <DropdownMenuItem key={key} disabled>{t(key)}</DropdownMenuItem>)}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>);
}
