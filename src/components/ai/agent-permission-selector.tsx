import { useState } from 'react';
import {
  ChevronDownIcon,
  HandIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { DEFAULT_AGENT_PERMISSION_MODE } from '@/lib/agent-contract';
import { cn } from '@/lib/utils';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentPermissionMode } from '@/types/agent';

const PERMISSION_OPTIONS = [
  {
    mode: 'requestApproval',
    icon: HandIcon,
    iconClassName: 'bg-muted text-foreground',
    label: 'agent.permission.requestApproval',
    description: 'agent.permission.requestApprovalDescription',
  },
  {
    mode: 'autoApproveReadOnly',
    icon: ShieldCheckIcon,
    iconClassName: 'bg-app-primary/10 text-app-primary',
    label: 'agent.permission.autoApproveReadOnly',
    description: 'agent.permission.autoApproveReadOnlyDescription',
  },
  {
    mode: 'fullAccess',
    icon: TriangleAlertIcon,
    iconClassName: 'bg-app-warning/10 text-app-warning',
    label: 'agent.permission.fullAccess',
    description: 'agent.permission.fullAccessDescription',
  },
] as const;

export interface AgentPermissionSelectorProps {
  readonly sessionId: string;
  readonly disabled?: boolean;
  readonly variant?: 'default' | 'composer';
}

export function AgentPermissionSelector({
  sessionId,
  disabled = false,
  variant = 'default',
}: AgentPermissionSelectorProps): React.ReactNode {
  const { t } = useI18n();
  const binding = useAgentPermissionStore((state) => state.bindings[sessionId]);
  const setMode = useAgentPermissionStore((state) => state.setMode);
  const connected = useTerminalStore((state) => state.sessions.some(
    (session) => session.sessionId === sessionId && session.status === 'connected',
  ));
  const [fullAccessDialogOpen, setFullAccessDialogOpen] = useState(false);
  const mode = binding?.mode ?? DEFAULT_AGENT_PERMISSION_MODE;
  const current = PERMISSION_OPTIONS.find((option) => option.mode === mode)
    ?? PERMISSION_OPTIONS[0];
  const CurrentIcon = current.icon;
  const composer = variant === 'composer';
  const triggerLabel = mode === 'fullAccess'
    ? 'agent.permission.fullAccessSelected'
    : current.label;

  const selectMode = (value: string): void => {
    const nextMode = value as AgentPermissionMode;
    if (nextMode === mode) return;
    if (nextMode === 'fullAccess') {
      setFullAccessDialogOpen(true);
      return;
    }
    setMode(sessionId, nextMode);
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
              className={cn(composer && 'max-w-40')}
              disabled={disabled || !connected}
              aria-label={t('agent.permission')}
            />
          )}
        >
          <span
            data-slot="agent-permission-trigger-content"
            className={cn(
              'flex items-center leading-none',
              composer ? 'min-w-0 gap-1' : 'gap-2',
              mode === 'fullAccess' && 'text-app-warning',
            )}
          >
            <CurrentIcon
              data-icon="inline-start"
              strokeWidth={1.75}
              className={cn(mode === 'fullAccess' && 'text-app-warning')}
            />
            <span className={cn('leading-none', composer && 'truncate')}>
              {t(triggerLabel)}
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('agent.permission')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={mode} onValueChange={selectMode}>
              {PERMISSION_OPTIONS.map((option) => {
                const Icon = option.icon;
                return (
                  <DropdownMenuRadioItem
                    key={option.mode}
                    value={option.mode}
                    closeOnClick
                    className="items-start gap-2.5 py-2"
                  >
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
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {t(option.description)}
                      </span>
                    </span>
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

      <AlertDialog open={fullAccessDialogOpen} onOpenChange={setFullAccessDialogOpen}>
        <AlertDialogContent className="p-4">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlertIcon className="text-app-warning" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('agent.permission.fullAccessTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('agent.permission.fullAccessWarning')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setMode(sessionId, 'fullAccess');
                setFullAccessDialogOpen(false);
              }}
            >
              {t('agent.permission.fullAccessConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
