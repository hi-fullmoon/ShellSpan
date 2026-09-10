import { ChevronDownIcon, MonitorCogIcon, SquareTerminalIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/hooks/useI18n';
import type { AgentExecutionSurface } from '@/types/agent-session';

const EXECUTION_SURFACE_OPTIONS = [
  {
    surface: 'direct',
    icon: MonitorCogIcon,
    label: 'agent.executionSurface.direct',
    description: 'agent.executionSurface.directDescription',
  },
  {
    surface: 'boundTerminal',
    icon: SquareTerminalIcon,
    label: 'agent.executionSurface.boundTerminal',
    description: 'agent.executionSurface.boundTerminalDescription',
  },
] as const;

export interface AgentExecutionSurfaceSelectorProps {
  readonly disabled?: boolean;
  readonly surface: AgentExecutionSurface;
  readonly onSurfaceChange?: (surface: AgentExecutionSurface) => void;
}

/** Session-scoped execution choice. Existing Sessions render their frozen value disabled. */
export function AgentExecutionSurfaceSelector({
  disabled = false,
  surface,
  onSurfaceChange,
}: AgentExecutionSurfaceSelectorProps): React.ReactNode {
  const { t } = useI18n();
  const current = EXECUTION_SURFACE_OPTIONS.find((option) => option.surface === surface)
    ?? EXECUTION_SURFACE_OPTIONS[0];
  const CurrentIcon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="xs"
            className="ai-execution-surface-trigger"
            disabled={disabled}
            aria-label={`${t('agent.executionSurface')}: ${t(current.label)}`}
          />
        )}
      >
        <CurrentIcon data-icon="inline-start" strokeWidth={1.75} />
        <span className="ai-execution-surface-label truncate">{t(current.label)}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={8}
        align="start"
        className="ai-execution-surface-menu"
        aria-label={t('agent.executionSurface')}
      >
        <DropdownMenuGroup>
          <DropdownMenuRadioGroup
            value={surface}
            onValueChange={(value) => {
              if (value === 'direct' || value === 'boundTerminal') onSurfaceChange?.(value);
            }}
          >
            {EXECUTION_SURFACE_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <DropdownMenuRadioItem
                  key={option.surface}
                  value={option.surface}
                  closeOnClick
                  className="ai-execution-surface-menu-option"
                  aria-description={t(option.description)}
                >
                  <Icon strokeWidth={1.6} />
                  <span>{t(option.label)}</span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
