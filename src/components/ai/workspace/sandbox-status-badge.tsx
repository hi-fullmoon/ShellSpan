import React, { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon, FolderOpenIcon, ShieldCheckIcon, TerminalIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import {
  invokeGetProfileSandbox,
  invokeRevealPath,
  invokeSandboxWorkspaceInfo,
  isTauriRuntime,
  type SandboxWorkspaceSourceInfo,
} from '@/lib/ipc/tauri';
import {
  effectiveSandboxNetworkPolicy,
  EMPTY_SANDBOX_DOMAINS,
  hasSandboxPtyPolicyDrifted,
  useSessionSandboxDomainsStore,
} from '@/lib/terminal/sandbox-terminal';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import type { LocalSandboxPtyBinding, SandboxMode } from '@/types';
import type { AgentSessionTarget } from '@/types/agent-session';

interface SandboxStatusBadgeProps {
  readonly sessionId?: string | null;
  readonly target?: AgentSessionTarget | null;
  readonly remoteSandboxMode?: SandboxMode | null;
  readonly boundSandbox?: LocalSandboxPtyBinding | null;
  readonly onOpenSandboxTerminal?: () => void;
  readonly openSandboxTerminalDisabled?: boolean;
}

function formatSandboxWorkspacePath(path: string, isLocalManaged: boolean): string {
  if (!isLocalManaged) return path;
  const macMatch = path.match(/(?:^|[\\/])sandboxes[\\/]([0-9a-f]{12,})[\\/](workspace(?:[\\/].*)?)$/i);
  if (macMatch) {
    return `sandbox/${macMatch[1].slice(0, 8)}…/${macMatch[2]}`;
  }
  const winMatch = path.match(/(?:^|[\\/])windows-agent-workspaces[\\/]([0-9a-f]{12,})(?:[\\/](.*))?$/i);
  if (winMatch) {
    return winMatch[2]
      ? `sandbox/${winMatch[1].slice(0, 8)}…/${winMatch[2]}`
      : `sandbox/${winMatch[1].slice(0, 8)}…`;
  }
  return path;
}

export function SandboxStatusBadge({
  sessionId,
  target,
  remoteSandboxMode,
  boundSandbox,
  onOpenSandboxTerminal,
  openSandboxTerminalDisabled = false,
}: SandboxStatusBadgeProps): React.ReactElement | null {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const networkMode = useAiSettingsStore((state) => state.agentSandboxNetworkMode);
  const networkAllowlist = useAiSettingsStore((state) => state.agentSandboxNetworkAllowlist);
  const sessionSandboxDomains = useSessionSandboxDomainsStore((state) => (
    sessionId ? (state.domainsBySession[sessionId] ?? EMPTY_SANDBOX_DOMAINS) : EMPTY_SANDBOX_DOMAINS
  ));
  const [loadedRemoteMode, setLoadedRemoteMode] = useState<SandboxMode | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<SandboxWorkspaceSourceInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

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

  useEffect(() => {
    setWorkspaceInfo(null);
  }, [sessionId]);

  useEffect(() => {
    if (!open || !localKind || !sessionId || !isTauriRuntime()) return;
    let cancelled = false;
    void invokeSandboxWorkspaceInfo(sessionId)
      .then((info) => {
        if (!cancelled) setWorkspaceInfo(info);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [localKind, open, sessionId]);

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

  const liveLocalEffective = effectiveSandboxNetworkPolicy(
    networkMode,
    networkAllowlist,
    sessionSandboxDomains,
  );
  const effectiveLocalNetworkMode = localKind === 'macNono'
    ? (boundSandbox?.networkMode ?? liveLocalEffective.mode)
    : 'blocked';
  const effectiveLocalAllowlistCount = localKind === 'macNono'
    ? (boundSandbox?.allowedDomains?.length ?? liveLocalEffective.rules.length)
    : 0;
  const boundPolicyDrifted = Boolean(
    localKind === 'macNono'
    && boundSandbox
    && hasSandboxPtyPolicyDrifted(boundSandbox, networkMode, networkAllowlist, sessionSandboxDomains),
  );

  const networkLabel = localKind === 'macNono' && effectiveLocalNetworkMode === 'devRegistries'
    ? t('ai.sandboxStatus.networkDevRegistries')
    : localKind === 'macNono' && effectiveLocalNetworkMode === 'customAllowlist' && effectiveLocalAllowlistCount > 0
      ? t('ai.sandboxStatus.networkCustomAllowlist', { count: effectiveLocalAllowlistCount })
      : !localKind && effectiveRemoteMode === 'clientReadOnly'
        ? t('ai.sandboxStatus.networkClientReadOnly')
        : t('ai.sandboxStatus.networkBlocked');

  const boundaryHint = localKind
    ? t('ai.sandboxStatus.localBoundaryHint')
    : effectiveRemoteMode === 'clientReadOnly'
      ? t('ai.sandboxStatus.remoteClientReadOnlyHint')
      : t('ai.sandboxStatus.remoteBoundaryHint');

  const workspacePath = localKind ? (target.cwd ?? target.localRoot ?? '') : (target.rootPath ?? '');
  const displayWorkspacePath = formatSandboxWorkspacePath(workspacePath, Boolean(localKind));

  const handleCopyWorkspacePath = (): void => {
    if (!workspacePath || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(workspacePath).then(() => {
      setCopiedPath(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedPath(false);
        copyTimerRef.current = null;
      }, 1500);
    }).catch(() => undefined);
  };

  const handleRevealWorkspacePath = (): void => {
    if (!workspacePath || !localKind || !isTauriRuntime()) return;
    void invokeRevealPath(workspacePath).catch(() => {
      showError(t('ai.sandboxStatus.revealFailed'));
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
            {localKind && workspaceInfo && (
              <div className="flex items-start justify-between gap-2" data-testid="sandbox-status-source">
                <dt className="shrink-0">{t('ai.sandboxStatus.sourceLabel')}</dt>
                <dd
                  className="min-w-0 truncate text-right text-foreground"
                  title={workspaceInfo.sourceRoot ?? t('ai.sandboxStatus.blankWorkspace')}
                >
                  {workspaceInfo.sourceRoot ?? t('ai.sandboxStatus.blankWorkspace')}
                </dd>
              </div>
            )}
            {workspacePath && (
              <div className="flex flex-col gap-0.5">
                <dt>{t('ai.sandboxStatus.workspaceLabel')}</dt>
                <dd className="flex items-center gap-1 rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">
                  <span className="min-w-0 flex-1 break-all" title={workspacePath}>
                    {displayWorkspacePath}
                  </span>
                  {localKind && isTauriRuntime() && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={t('ai.sandboxStatus.revealWorkspace')}
                      title={t('ai.sandboxStatus.revealWorkspace')}
                      onClick={handleRevealWorkspacePath}
                    >
                      <FolderOpenIcon aria-hidden="true" className="size-3" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={t(copiedPath ? 'ai.sandboxStatus.workspacePathCopied' : 'ai.sandboxStatus.copyWorkspacePath')}
                    title={t(copiedPath ? 'ai.sandboxStatus.workspacePathCopied' : 'ai.sandboxStatus.copyWorkspacePath')}
                    onClick={handleCopyWorkspacePath}
                  >
                    {copiedPath ? (
                      <CheckIcon aria-hidden="true" className="size-3 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <CopyIcon aria-hidden="true" className="size-3" />
                    )}
                  </Button>
                </dd>
              </div>
            )}
          </dl>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {boundaryHint}
          </p>
          {boundPolicyDrifted && (
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400" data-testid="sandbox-status-drift-hint">
              {t('ai.sandboxStatus.policyDriftHint')}
            </p>
          )}
          {onOpenSandboxTerminal && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="w-full justify-center gap-1"
              disabled={openSandboxTerminalDisabled}
              onClick={() => {
                setOpen(false);
                onOpenSandboxTerminal();
              }}
            >
              <TerminalIcon aria-hidden="true" className="size-3 shrink-0" />
              <span>{t('ai.sandboxStatus.openSandboxTerminal')}</span>
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
