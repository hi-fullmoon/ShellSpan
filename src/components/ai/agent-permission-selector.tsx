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
    label: 'agent.permission.requestApproval',
    description: 'agent.permission.requestApprovalDescription',
  },
  {
    mode: 'autoApproveReadOnly',
    icon: ShieldCheckIcon,
    label: 'agent.permission.autoApproveReadOnly',
    description: 'agent.permission.autoApproveReadOnlyDescription',
  },
  {
    mode: 'fullAccess',
    icon: TriangleAlertIcon,
    label: 'agent.permission.fullAccess',
    description: 'agent.permission.fullAccessDescription',
  },
] as const;

export interface AgentPermissionSelectorProps {
  readonly sessionId: string;
  readonly disabled?: boolean;
}

export function AgentPermissionSelector({
  sessionId,
  disabled = false,
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
    <div className="flex min-w-0 flex-col gap-2" data-slot="agent-permission-selector">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !connected}
              aria-label={t('agent.permission')}
            />
          )}
        >
          <CurrentIcon
            data-icon="inline-start"
            className={cn(mode === 'fullAccess' && 'text-app-warning')}
          />
          {t(current.label)}
          <ChevronDownIcon data-icon="inline-end" />
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
                    className="items-start py-2"
                  >
                    <Icon className={cn('mt-0.5', option.mode === 'fullAccess' && 'text-app-warning')} />
                    <span className="min-w-0">
                      <span className="block">{t(option.label)}</span>
                      <span className="block text-xs text-muted-foreground">
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

      {mode === 'fullAccess' && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{t('agent.permission.fullAccess')}</AlertTitle>
          <AlertDescription>{t('agent.permission.fullAccessActive')}</AlertDescription>
        </Alert>
      )}

      <AlertDialog open={fullAccessDialogOpen} onOpenChange={setFullAccessDialogOpen}>
        <AlertDialogContent>
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
