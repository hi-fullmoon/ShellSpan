import React, { useEffect, useState } from 'react';
import { ShieldCheckIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/hooks/useI18n';
import { invokeGetProfileSandbox, isTauriRuntime } from '@/lib/ipc/tauri';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import type { SandboxMode } from '@/types';
import type { AgentSessionTarget } from '@/types/agent-session';

interface SandboxStatusBadgeProps {
  readonly target?: AgentSessionTarget | null;
  readonly remoteSandboxMode?: SandboxMode | null;
}

export function SandboxStatusBadge({
  target,
  remoteSandboxMode,
}: SandboxStatusBadgeProps): React.ReactElement | null {
  const { t } = useI18n();
  const networkMode = useAiSettingsStore((state) => state.agentSandboxNetworkMode);
  const networkAllowlist = useAiSettingsStore((state) => state.agentSandboxNetworkAllowlist);
  const [loadedRemoteMode, setLoadedRemoteMode] = useState<SandboxMode | null>(null);

  const localKind = target?.localSandboxRequired ?? null;
  const isRemoteSandbox = target?.kind === 'remote' && target.remoteSandboxRequired === true;
  const remoteProfileId = isRemoteSandbox ? (target?.profileId ?? null) : null;

  useEffect(() => {
    if (remoteSandboxMode !== undefined || !remoteProfileId || !isTauriRuntime()) {
      setLoadedRemoteMode(null);
      return;
    }
    let cancelled = false;
    void invokeGetProfileSandbox(remoteProfileId)
      .then((result) => {
        if (!cancelled) setLoadedRemoteMode(result.policy?.mode ?? null);
      })
      .catch(() => {
        if (!cancelled) setLoadedRemoteMode(null);
      });
    return () => {
      cancelled = true;
    };
  }, [remoteProfileId, remoteSandboxMode]);

  if (!target) return null;
  if (!localKind && !isRemoteSandbox) return null;

  const effectiveRemoteMode = remoteSandboxMode !== undefined ? remoteSandboxMode : loadedRemoteMode;

  const backendLabel = localKind === 'macNono'
    ? t('ai.sandboxStatus.backend.macNono')
    : localKind === 'windowsAppContainer'
      ? t('ai.sandboxStatus.backend.windowsAppContainer')
      : effectiveRemoteMode === 'clientReadOnly'
        ? t('ai.sandboxStatus.backend.remoteClientReadOnly')
        : effectiveRemoteMode === 'readOnly'
          ? t('ai.sandboxStatus.backend.remoteBubblewrapReadOnly')
          : effectiveRemoteMode === 'workspaceWrite'
            ? t('ai.sandboxStatus.backend.remoteBubblewrapWrite')
            : t('ai.sandboxStatus.backend.remote');

  const networkLabel = localKind === 'macNono' && networkMode === 'devRegistries'
    ? t('ai.sandboxStatus.networkDevRegistries')
    : localKind === 'macNono' && networkMode === 'customAllowlist' && networkAllowlist.length > 0
      ? t('ai.sandboxStatus.networkCustomAllowlist', { count: networkAllowlist.length })
      : !localKind && effectiveRemoteMode === 'clientReadOnly'
        ? t('ai.sandboxStatus.networkClientReadOnly')
        : t('ai.sandboxStatus.networkBlocked');

  const boundaryHint = localKind
    ? t('ai.sandboxStatus.localBoundaryHint')
    : effectiveRemoteMode === 'clientReadOnly'
      ? t('ai.sandboxStatus.remoteClientReadOnlyHint')
      : t('ai.sandboxStatus.remoteBoundaryHint');

  const workspacePath = localKind ? (target.cwd ?? target.localRoot ?? '') : (target.rootPath ?? '');

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex shrink-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('ai.sandboxStatus.triggerAria', { backend: backendLabel })}
            data-slot="ai-sandbox-status-trigger"
          />
        }
      >
        <Badge variant="outline" size="sm" className="shrink-0 gap-1">
          <ShieldCheckIcon className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="hidden truncate @min-[360px]/ai-workspace:inline">{t('ai.sandboxStatus.badge')}</span>
        </Badge>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" sideOffset={8} className="w-72 p-3 text-xs">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1 font-medium text-foreground">
            <ShieldCheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>{t('ai.sandboxStatus.title')}</span>
          </div>
          <dl className="flex flex-col gap-1.5 text-muted-foreground">
            <div className="flex items-start justify-between gap-2">
              <dt className="shrink-0">{t('ai.sandboxStatus.backendLabel')}</dt>
              <dd className="text-right font-medium text-foreground">{backendLabel}</dd>
            </div>
            <div className="flex items-start justify-between gap-2">
              <dt className="shrink-0">{t('ai.sandboxStatus.networkLabel')}</dt>
              <dd className="text-right text-foreground">{networkLabel}</dd>
            </div>
            {workspacePath && (
              <div className="flex flex-col gap-0.5">
                <dt>{t('ai.sandboxStatus.workspaceLabel')}</dt>
                <dd className="break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">
                  {workspacePath}
                </dd>
              </div>
            )}
          </dl>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {boundaryHint}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
