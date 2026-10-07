import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/useToast';
import type { SandboxDefaultConfiguration } from '@/stores/sandboxDefaultsStore';
import { Settings2Icon } from 'lucide-react';
import { invokeGetSandboxAuthorizations } from '@/lib/ipc/tauri';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AiHeaderIconButton } from './ai-header-icon-button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/hooks/useI18n';
import { sandboxGapLabels, sandboxPolicyLabels } from '@/lib/ai/sandbox-presentation';
import type { AgentExecutionSurface, AgentSandboxAuthorizationStatus, AgentSandboxCapability, AgentSandboxPolicy, AgentSessionTarget } from '@/types/agent-session';

export interface AiSandboxSettingsProps {
  readonly defaultConfiguration?: SandboxDefaultConfiguration;
  readonly defaultsReady?: boolean;
  readonly canRememberDefault?: boolean;
  readonly onRememberDefault?: (directories: readonly string[]) => Promise<void>;
  readonly onForgetDefault?: () => Promise<void>;
  readonly onReloadDefaults?: () => Promise<void>;
  readonly onClearDefaults?: () => Promise<void>;
  readonly backendCapability?: AgentSandboxCapability;
  readonly onChooseProjectRoot?: () => void;
  readonly onVerifyRemote?: () => Promise<void>;
  readonly remoteVerificationBusy?: boolean;
  readonly remoteVerificationError?: boolean;
  readonly canSwitchPolicy?: boolean;
  readonly sessionId?: string;
  readonly revision?: number;
  readonly onRevokeReads?: () => void;
  readonly revokeBusy?: boolean;
  readonly policy?: AgentSandboxPolicy;
  readonly capability?: AgentSandboxCapability;
  readonly target?: AgentSessionTarget;
  readonly surface: AgentExecutionSurface;
  readonly existing: boolean;
  readonly disabled?: boolean;
  readonly onPolicyChange: (policy: AgentSandboxPolicy) => void;
}

/** Intent selection never asserts backend enforcement or changes operation approval. */
export function AiSandboxSettings({ policy, capability, target, surface, existing, disabled, onPolicyChange, onRevokeReads, revokeBusy, sessionId, revision, backendCapability, canSwitchPolicy = false, defaultConfiguration, defaultsReady = true, canRememberDefault = false, onRememberDefault, onForgetDefault, onReloadDefaults, onClearDefaults, onChooseProjectRoot, onVerifyRemote, remoteVerificationBusy = false, remoteVerificationError = false }: AiSandboxSettingsProps): React.ReactNode {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [clearDefaultsOpen, setClearDefaultsOpen] = useState(false);
  const defaultsPending = useRef(false);
  const changeDefaults = async (change: () => Promise<void>) => {
    if (defaultsPending.current) return;
    defaultsPending.current = true; setDefaultsBusy(true);
    try { await change(); } catch { toast.error(t('agent.sandbox.defaultsSaveFailed')); }
    finally { defaultsPending.current = false; setDefaultsBusy(false); }
  };
  const [open, setOpen] = useState(false);
  const [authorization, setAuthorization] = useState<{ sessionId: string; status?: AgentSandboxAuthorizationStatus; error?: boolean }>();
  const label = policy ? t(sandboxPolicyLabels[policy]) : t('agent.sandbox.legacy');
  const restricted = policy !== undefined && policy !== 'host';
  useEffect(() => {
    if (!open || !existing || !sessionId || revokeBusy) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const status = await invokeGetSandboxAuthorizations(sessionId);
        if (current) setAuthorization({ sessionId, status });
      } catch {
        if (current) setAuthorization({ sessionId, error: true });
      } finally {
        if (current) timer = setTimeout(() => { void refresh(); }, 2000);
      }
    };
    setAuthorization({ sessionId });
    void refresh();
    return () => { current = false; clearTimeout(timer); };
  }, [open, existing, restricted, sessionId, revision, revokeBusy]);
  const live = !revokeBusy && authorization?.sessionId === sessionId ? authorization : undefined;
  const nativeAvailable = surface === 'direct' && capability?.files === true && capability.network === true && capability.status !== 'unavailable';
  const available = backendCapability ?? capability;
  const canSelectRestricted = surface === 'direct' && (target?.kind === 'remote' && Boolean(onVerifyRemote)
    || available?.files === true && available.network && available.status !== 'unavailable');
  const items = [...(existing && policy === undefined ? [{value:'legacy',label:t('agent.sandbox.legacy')}] : []), ...(['readOnly', 'workspace', 'host'] as const).map(value => ({ value, label: t(sandboxPolicyLabels[value]) }))];
  const host = target?.kind === 'remote'
    ? `${target.username ?? ''}@${target.host ?? ''}:${target.port ?? ''}`
    : target?.kind === 'local' ? t('agent.sandbox.localHost') : t('agent.sandbox.unknown');
  const root = target?.kind === 'local' ? target.localRoot ?? target.rootPath ?? target.cwd : target?.rootPath;
  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverTrigger render={<TooltipTrigger render={<AiHeaderIconButton aria-label={t('agent.sandbox.settings')} />} />}>
          <Settings2Icon data-icon="inline-start" />
        </PopoverTrigger>
        <TooltipContent>{t('agent.sandbox.settings')}</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" className="max-h-(--available-height) max-w-[calc(100vw-16px)] overflow-y-auto">
        <PopoverTitle>{t('agent.sandbox.settings')}</PopoverTitle>
        <Field>
          <FieldLabel>{t('agent.sandbox.intent')}</FieldLabel>
          {existing && !canSwitchPolicy ? <span>{label}</span> : (
            <Select items={items} value={policy ?? (existing ? 'legacy' : undefined)} disabled={disabled || existing && (live?.status?.activeProcesses ?? 0) > 0} onValueChange={value => { if (value === 'host' || canSelectRestricted && (value === 'readOnly' || value === 'workspace')) onPolicyChange(value); }}>
              <SelectTrigger size="sm" aria-label={t('agent.sandbox.intent')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{items.map(item => (
                <SelectItem key={item.value} value={item.value} disabled={item.value === 'legacy' || item.value !== 'host' && !canSelectRestricted}>{item.label}</SelectItem>
              ))}</SelectGroup></SelectContent>
            </Select>
          )}
        </Field>
        {existing && <p>{t(canSwitchPolicy ? 'agent.sandbox.policySwitchNotice' : 'agent.sandbox.newSessionOnly')}</p>}
        {!existing && onChooseProjectRoot && <Button size="sm" variant="outline" disabled={disabled || remoteVerificationBusy} onClick={() => { setOpen(false); onChooseProjectRoot(); }}>{t('ai.workspace.files.chooseRoot')}</Button>}
        {!existing && target?.kind === 'remote' && restricted && onVerifyRemote && <div className="flex flex-col gap-1 text-xs" role="status">
          <p>{t('agent.sandbox.remoteVerificationNotice')}</p>
          {remoteVerificationError && <p>{t('agent.sandbox.remoteVerificationFailed')}</p>}
          <Button size="sm" variant="outline" disabled={disabled || remoteVerificationBusy || !root || surface !== 'direct'} onClick={() => { void onVerifyRemote(); }}>{t(remoteVerificationBusy ? 'common.loading' : 'agent.sandbox.verifyRemote')}</Button>
        </div>}
        {onRememberDefault && <div className="flex min-w-0 flex-col gap-1 text-xs">
          <p>{t('agent.sandbox.defaultsNotice')}</p>
          {defaultConfiguration && <>
            <p>{t('agent.sandbox.savedDefault', { policy:t(sandboxPolicyLabels[defaultConfiguration.policy]) })}</p>
            <ul>{defaultConfiguration.cacheDirectories.map(path => <li key={path} className="break-all">{path}</li>)}</ul>
          </>}
          {!canRememberDefault && <p>{t(defaultsReady ? 'agent.sandbox.defaultsRootRequired' : 'agent.sandbox.defaultsLoadFailed')}</p>}
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" disabled={!canRememberDefault || disabled || defaultsBusy} onClick={() => { void changeDefaults(() => onRememberDefault(live?.status?.writePaths ?? defaultConfiguration?.cacheDirectories ?? [])); }}>{t('agent.sandbox.rememberDefault')}</Button>
            {defaultConfiguration && onForgetDefault && <Button size="sm" variant="outline" disabled={disabled || defaultsBusy} onClick={() => { void changeDefaults(onForgetDefault); }}>{t('agent.sandbox.forgetDefault')}</Button>}
            {!defaultsReady && onReloadDefaults && <Button size="sm" variant="outline" disabled={defaultsBusy} onClick={() => { void changeDefaults(onReloadDefaults); }}>{t('agent.sandbox.reloadDefaults')}</Button>}
            {!defaultsReady && !existing && <Button size="sm" variant="outline" disabled={disabled} onClick={() => { if (policy) onPolicyChange(policy); }}>{t('agent.sandbox.useSessionPolicy')}</Button>}
            {!defaultsReady && onClearDefaults && <Button size="sm" variant="outline" disabled={defaultsBusy} onClick={() => setClearDefaultsOpen(true)}>{t('agent.sandbox.clearDefaults')}</Button>}
          </div>
        </div>}
        {existing && restricted && sessionId && <div className="flex min-w-0 flex-col gap-1 text-xs" role="status">
          <p>{t('agent.sandbox.authorizations')}</p>
          <p>{t(live?.error ? 'agent.sandbox.authorizationUnknown' : live?.status ? `agent.sandbox.authorization.${live.status.state}` : 'common.loading')}</p>
          {live?.status && <>
            <p>{t('agent.sandbox.activeProcesses', { count: live.status.activeProcesses })}</p>
            {live.status.state === 'active' && <>
              {live.status.expiresAtUnixMs !== null && <p>{t('agent.sandbox.authorizationExpiry', { time: new Date(live.status.expiresAtUnixMs).toLocaleString(locale) })}</p>}
              <ul>
                {live.status.readPaths.map(path => <li className="break-all" key={path}>{path}</li>)}
                {live.status.writePaths?.map(path => <li className="break-all" key={`write:${path}`}>{t('agent.sandbox.cacheAccess', { path })}</li>)}
                {live.status.networkTargets.map(target => <li className="break-all" key={`${target.host}:${target.port}:${target.resolver}`}>
                  {`TCP ${target.host}:${target.port}`} · {t(target.resolver === 'cloudflare' ? 'ai.workspace.approval.networkDnsCloudflare' : 'ai.workspace.approval.networkDnsSystem')}
                </li>)}
                {live.status.localServices.map(service => <li key={service.port}>{`127.0.0.1:${service.port}`}</li>)}
              </ul>
            </>}
          </>}
        </div>}
        {existing && restricted && onRevokeReads && <Button size="sm" variant="outline" disabled={revokeBusy} onClick={onRevokeReads}>{t('agent.sandbox.revokeReads')}</Button>}
        <dl className="flex min-w-0 flex-col gap-1 text-xs">
          <dt>{t('agent.sandbox.executionHost')}</dt><dd className="break-all">{host}</dd>
          <dt>{t('agent.sandbox.root')}</dt><dd className="break-all">{root || t('agent.sandbox.rootMissing')}</dd>
          <dt>{t('agent.sandbox.capability')}</dt><dd>{t(capability ? `agent.sandbox.${capability.status}` : existing ? 'agent.sandbox.unknown' : 'agent.sandbox.unavailable')}</dd>
          <dt>{t('agent.sandbox.network')}</dt><dd>{t(restricted ? nativeAvailable ? 'agent.sandbox.networkDeny' : 'agent.sandbox.networkIntent' : 'agent.sandbox.accountNetwork')}</dd>
        </dl>
        <Alert size="sm"><AlertDescription>{t(restricted ? nativeAvailable ? 'agent.sandbox.nativeNotice' : 'agent.sandbox.backendUnavailable' : 'agent.sandbox.hostNotice')}</AlertDescription></Alert>
        {restricted && surface === 'boundTerminal' && <Alert size="sm"><AlertDescription>{t('agent.sandbox.terminalConflict')}</AlertDescription></Alert>}
        {restricted && !root && <p>{t('agent.sandbox.rootRequired')}</p>}
        {capability && (existing || nativeAvailable) && <details>
          <summary>{t('agent.sandbox.details')}</summary>
          <dl className="flex flex-col gap-1 text-xs">
            {(['files', 'network', 'processLifecycle'] as const).map(key => <div key={key}>
              <dt>{t(`agent.sandbox.${key}`)}</dt><dd>{t(capability[key] ? 'agent.sandbox.enforced' : key === 'processLifecycle' && nativeAvailable ? 'agent.sandbox.processLimited' : 'agent.sandbox.notEnforced')}</dd>
            </div>)}
          </dl>
          {capability.gaps.map((gap, index) => <p className="break-words" key={index}>{sandboxGapLabels[gap] ? t(sandboxGapLabels[gap]) : gap}</p>)}
        </details>}
      </PopoverContent>
    </Popover>
    <ConfirmationDialog open={clearDefaultsOpen} onOpenChange={setClearDefaultsOpen}
      title={t('agent.sandbox.clearDefaults')} description={t('agent.sandbox.clearDefaultsNotice')}
      confirmLabel={t('agent.sandbox.clearDefaults')} onConfirm={() => { if (onClearDefaults) void changeDefaults(onClearDefaults); setClearDefaultsOpen(false); }} />
    </>
  );
}
