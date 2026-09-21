import { useEffect, useState } from 'react';
import {
  ChevronDownIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { AgentPermissionMode } from '@/types/agent-approval';

const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'autoApproveReadOnly';

const PERMISSION_OPTIONS = [
  {
    mode: 'autoApproveReadOnly',
    icon: ShieldCheckIcon,
    iconClassName: 'bg-app-primary/10 text-app-primary',
    label: 'agent.permission.autoApproveReadOnly',
    composerLabel: 'agent.permission.composer.readOnly',
    composerDescription: 'agent.permission.composer.readOnlyDescription',
    description: 'agent.permission.autoApproveReadOnlyDescription',
  },
  {
    mode: 'requestApproval',
    icon: ShieldIcon,
    iconClassName: 'bg-muted text-muted-foreground',
    label: 'agent.permission.requestApproval',
    composerLabel: 'agent.permission.requestApproval',
    composerDescription: 'agent.permission.requestApprovalDescription',
    description: 'agent.permission.requestApprovalDescription',
  },
  {
    mode: 'fullAccess',
    icon: ShieldAlertIcon,
    iconClassName: 'bg-app-warning/10 text-app-warning',
    label: 'agent.permission.fullAccess',
    composerLabel: 'agent.permission.composer.fullAccess',
    composerDescription: 'agent.permission.composer.fullAccessDescription',
    description: 'agent.permission.fullAccessDescription',
  },
] as const;

const COMPOSER_PERMISSION_OPTIONS = PERMISSION_OPTIONS;

interface FullAccessConfirmationTarget {
  readonly sessionId: string;
  readonly identity: string;
  readonly label: string;
}

function terminalIdentity(session: TerminalSession): string {
  return JSON.stringify([
    session.sessionId,
    session.profileId ?? null,
    session.host,
    session.port,
    session.username,
    session.terminalSessionId ?? null,
    session.terminalGeneration ?? null,
  ]);
}

function terminalLabel(session: TerminalSession): string {
  if (session.host === 'local' && session.port === 0) return `${session.title} (local)`;
  return `${session.title} (${session.username}@${session.host}:${session.port})`;
}

export interface AgentPermissionSelectorProps {
  readonly sessionId: string;
  readonly disabled?: boolean;
  readonly mode?: AgentPermissionMode;
  readonly onModeChange?: (mode: AgentPermissionMode) => Promise<void>;
  readonly variant?: 'default' | 'composer';
}

export function AgentPermissionSelector({
  sessionId,
  disabled = false,
  mode: selectedMode,
  onModeChange,
  variant = 'default',
}: AgentPermissionSelectorProps): React.ReactNode {
  const { t } = useI18n();
  const binding = useAgentPermissionStore((state) => state.bindings[sessionId]);
  const preferredMode = useAiSettingsStore((state) => state.agentPermissionMode);
  const setMode = useAgentPermissionStore((state) => state.setMode);
  const terminal = useTerminalStore((state) => state.sessions.find(
    (session) => session.sessionId === sessionId,
  ));
  const connected = terminal?.status === 'connected';
  const [fullAccessDialogOpen, setFullAccessDialogOpen] = useState(false);
  const [confirmationTarget, setConfirmationTarget] = useState<FullAccessConfirmationTarget | null>(null);
  const composer = variant === 'composer';
  const mode = selectedMode ?? binding?.mode ?? preferredMode;
  const changeMode = (nextMode: AgentPermissionMode): void => {
    if (onModeChange) void onModeChange(nextMode);
    else setMode(sessionId, nextMode);
  };
  const visibleMode = PERMISSION_OPTIONS.some((option) => option.mode === mode)
    ? mode
    : DEFAULT_AGENT_PERMISSION_MODE;
  const current = PERMISSION_OPTIONS.find((option) => option.mode === visibleMode)
    ?? PERMISSION_OPTIONS[0];
  const CurrentIcon = current.icon;
  const triggerLabel = visibleMode === 'fullAccess'
    ? 'agent.permission.fullAccessSelected'
    : composer ? current.composerLabel : current.label;

  useEffect(() => {
    if (!fullAccessDialogOpen || !confirmationTarget) return;
    if (!terminal || terminal.status !== 'connected'
      || confirmationTarget.sessionId !== sessionId
      || confirmationTarget.identity !== terminalIdentity(terminal)) {
      setFullAccessDialogOpen(false);
      setConfirmationTarget(null);
    }
  }, [confirmationTarget, fullAccessDialogOpen, sessionId, terminal]);

  const selectMode = (value: string): void => {
    const nextMode = value as AgentPermissionMode;
    if (nextMode === mode) return;
    if (nextMode === 'fullAccess') {
      if (!terminal || terminal.status !== 'connected') return;
      setConfirmationTarget({
        sessionId,
        identity: terminalIdentity(terminal),
        label: terminalLabel(terminal),
      });
      setFullAccessDialogOpen(true);
      return;
    }
    changeMode(nextMode);
  };

  return (
    <div
      className={cn('flex min-w-0 flex-col', composer ? 'gap-0' : 'gap-2')}
      data-slot="agent-permission-selector"
      data-variant={variant}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button
              variant={composer ? 'ghost' : 'outline'}
              size={composer ? 'xs' : 'sm'}
              className={cn(composer && 'ai-permission-trigger h-7 min-w-0 max-w-[154px] px-[7px] @max-[480px]/ai-workspace:size-7 @max-[480px]/ai-workspace:shrink-0 @max-[480px]/ai-workspace:p-0 @max-[480px]/ai-workspace:[&_[data-icon=inline-end]]:hidden')}
              disabled={disabled || !connected}
              aria-label={composer
                ? t('agent.permission.composerAria', { mode: t(triggerLabel) })
                : t('agent.permission')}
            />
          )}
        >
          <span
            data-slot="agent-permission-trigger-content"
            className={cn(
              'flex items-center gap-1 leading-none',
              composer && 'min-w-0',
              visibleMode === 'fullAccess' && 'text-app-warning',
            )}
          >
            <CurrentIcon
              data-icon="inline-start"
              strokeWidth={1.75}
              className={cn(visibleMode === 'fullAccess' && 'text-app-warning')}
            />
            <span className={cn('leading-none', composer && 'ai-permission-trigger-label truncate @max-[480px]/ai-workspace:hidden')}>
              {t(triggerLabel)}
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={composer ? 'top' : 'bottom'}
          sideOffset={composer ? 8 : 4}
          align="start"
          className={cn(
            composer
              ? 'ai-permission-menu w-[240px] max-w-[calc(100vw-16px)] p-[3px]'
              : 'w-96 max-w-[calc(100vw-1rem)]',
          )}
        >
          <DropdownMenuGroup>
            {!composer && (
              <DropdownMenuLabel className="text-[11px]">{t('agent.permission')}</DropdownMenuLabel>
            )}
            <DropdownMenuRadioGroup value={visibleMode} onValueChange={selectMode}>
              {(composer ? COMPOSER_PERMISSION_OPTIONS : PERMISSION_OPTIONS).map((option) => {
                const Icon = option.icon;
                return (
                  <DropdownMenuRadioItem
                    key={option.mode}
                    value={option.mode}
                    closeOnClick
                    className={cn(
                      composer
                        ? 'ai-permission-menu-option min-h-12 items-start gap-1 py-2 pr-8 pl-2'
                        : 'items-start gap-1 py-2 text-[13px]',
                    )}
                    aria-description={composer ? t(option.description) : undefined}
                  >
                    {composer ? (
                      <>
                        <Icon
                          className={cn('mt-0.5', option.mode === 'fullAccess' && 'text-app-warning')}
                          strokeWidth={1.6}
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex items-center gap-1.5">
                            <span>{t(option.composerLabel)}</span>
                            {option.mode === DEFAULT_AGENT_PERMISSION_MODE && (
                              <Badge variant="secondary" size="sm">
                                {t('agent.permission.recommended')}
                              </Badge>
                            )}
                            {option.mode === 'fullAccess' && (
                              <Badge variant="destructive" size="sm">
                                {t('agent.permission.highRisk')}
                              </Badge>
                            )}
                          </span>
                          <span className="text-[11px] leading-4 text-muted-foreground" aria-hidden="true">
                            {t(option.composerDescription)}
                          </span>
                        </span>
                      </>
                    ) : (
                      <>
                        <span
                          data-slot="agent-permission-option-icon"
                          className={cn(
                            'mt-px flex size-5 shrink-0 items-center justify-center rounded-md',
                            option.iconClassName,
                          )}
                        >
                          <Icon strokeWidth={1.75} />
                        </span>
                        <span className="min-w-0 leading-tight">
                          <span className="flex items-center gap-1.5 font-medium">
                            <span>{t(option.label)}</span>
                            {option.mode === DEFAULT_AGENT_PERMISSION_MODE && (
                              <Badge variant="secondary" size="sm">
                                {t('agent.permission.recommended')}
                              </Badge>
                            )}
                            {option.mode === 'fullAccess' && (
                              <Badge variant="destructive" size="sm">
                                {t('agent.permission.highRisk')}
                              </Badge>
                            )}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground sm:whitespace-nowrap">
                            {t(option.description)}
                          </span>
                        </span>
                      </>
                    )}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {!composer && mode === 'fullAccess' && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{t('agent.permission.fullAccess')}</AlertTitle>
          <AlertDescription>{t('agent.permission.fullAccessActive')}</AlertDescription>
        </Alert>
      )}

      <ConfirmationDialog
        open={fullAccessDialogOpen}
        onOpenChange={(open) => {
          setFullAccessDialogOpen(open);
          if (!open) setConfirmationTarget(null);
        }}
        title={t('agent.permission.fullAccessTitle')}
        description={t('agent.permission.fullAccessWarning')}
        confirmLabel={t('agent.permission.fullAccessConfirm')}
        confirmVariant="warning"
        confirmDisabled={!confirmationTarget || !terminal || terminal.status !== 'connected'
          || confirmationTarget.sessionId !== sessionId
          || confirmationTarget.identity !== terminalIdentity(terminal)}
        media={<ShieldAlertIcon />}
        mediaVariant="warning"
        onConfirm={() => {
          const live = useTerminalStore.getState().sessions.find((session) => session.sessionId === sessionId);
          if (!confirmationTarget || !live || live.status !== 'connected'
            || confirmationTarget.sessionId !== sessionId
            || confirmationTarget.identity !== terminalIdentity(live)) {
            setFullAccessDialogOpen(false);
            setConfirmationTarget(null);
            return;
          }
          changeMode('fullAccess');
          setFullAccessDialogOpen(false);
          setConfirmationTarget(null);
        }}
      >
        {confirmationTarget && (
          <Alert variant="warning" size="sm">
            <AlertTitle>{t('agent.permission.fullAccessTarget')}</AlertTitle>
            <AlertDescription>{confirmationTarget.label}</AlertDescription>
          </Alert>
        )}
      </ConfirmationDialog>
    </div>
  );
}
