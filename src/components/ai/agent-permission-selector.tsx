import { useState } from 'react';
import {
  ChevronDownIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentPermissionMode } from '@/types/agent-approval';

const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'autoApproveReadOnly';

const PERMISSION_OPTIONS = [
  {
    mode: 'autoApproveReadOnly',
    icon: ShieldCheckIcon,
    iconClassName: 'bg-app-primary/10 text-app-primary',
    label: 'agent.permission.autoApproveReadOnly',
    composerLabel: 'agent.permission.composer.readOnly',
    description: 'agent.permission.autoApproveReadOnlyDescription',
  },
  {
    mode: 'fullAccess',
    icon: ShieldAlertIcon,
    iconClassName: 'bg-app-warning/10 text-app-warning',
    label: 'agent.permission.fullAccess',
    composerLabel: 'agent.permission.composer.fullAccess',
    description: 'agent.permission.fullAccessDescription',
  },
] as const;

const COMPOSER_PERMISSION_OPTIONS = PERMISSION_OPTIONS;

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
  const setMode = useAgentPermissionStore((state) => state.setMode);
  const connected = useTerminalStore((state) => state.sessions.some(
    (session) => session.sessionId === sessionId && session.status === 'connected',
  ));
  const [fullAccessDialogOpen, setFullAccessDialogOpen] = useState(false);
  const composer = variant === 'composer';
  const mode = selectedMode ?? binding?.mode ?? DEFAULT_AGENT_PERMISSION_MODE;
  const changeMode = (nextMode: AgentPermissionMode): void => {
    if (onModeChange) void onModeChange(nextMode);
    else setMode(sessionId, nextMode);
  };
  const visibleMode = mode === 'fullAccess' ? mode : DEFAULT_AGENT_PERMISSION_MODE;
  const current = PERMISSION_OPTIONS.find((option) => option.mode === visibleMode)
    ?? PERMISSION_OPTIONS[0];
  const CurrentIcon = current.icon;
  const triggerLabel = visibleMode === 'fullAccess'
    ? composer ? current.composerLabel : 'agent.permission.fullAccessSelected'
    : composer ? current.composerLabel : current.label;

  const selectMode = (value: string): void => {
    const nextMode = value as AgentPermissionMode;
    if (nextMode === mode) return;
    if (nextMode === 'fullAccess') {
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
              className={cn(composer && 'ai-permission-trigger')}
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
              'flex items-center leading-none',
              composer ? 'min-w-0 gap-1' : 'gap-2',
              visibleMode === 'fullAccess' && 'text-app-warning',
            )}
          >
            <CurrentIcon
              data-icon="inline-start"
              strokeWidth={1.75}
              className={cn(visibleMode === 'fullAccess' && 'text-app-warning')}
            />
            <span className={cn('leading-none', composer && 'ai-permission-trigger-label truncate')}>
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
              ? 'ai-permission-menu'
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
                        ? 'ai-permission-menu-option'
                        : 'items-start gap-2.5 py-2 text-[13px]',
                    )}
                  >
                    {composer ? (
                      <>
                        <Icon strokeWidth={1.6} />
                        <span>{t(option.composerLabel)}</span>
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
                          <span className="block font-medium">{t(option.label)}</span>
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
        onOpenChange={setFullAccessDialogOpen}
        title={t('agent.permission.fullAccessTitle')}
        description={t('agent.permission.fullAccessWarning')}
        confirmLabel={t('agent.permission.fullAccessConfirm')}
        confirmVariant="warning"
        media={<TriangleAlertIcon className="text-app-warning" />}
        onConfirm={() => {
          changeMode('fullAccess');
          setFullAccessDialogOpen(false);
        }}
      />
    </div>
  );
}
