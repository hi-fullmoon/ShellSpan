import { ChevronDownIcon, MonitorCogIcon, SquareTerminalIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import type { LocaleKey } from '@/locales';
import {
  resolveTerminalSurfacePresentation,
  terminalSurfaceSemanticsV1Enabled,
  type RealTerminalPresentationState,
  type TerminalSurfaceRuntimeFallbackSignal,
} from '@/lib/terminal/terminal-surface-semantics';
import type { AgentExecutionSurface } from '@/types/agent-session';

const LEGACY_EXECUTION_SURFACE_OPTIONS = [
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

const SEMANTIC_EXECUTION_SURFACE_OPTIONS = [
  {
    surface: 'direct',
    icon: MonitorCogIcon,
    label: 'agent.executionSurface.v1.direct',
    description: 'agent.executionSurface.v1.directDescription',
  },
  {
    surface: 'boundTerminal',
    icon: SquareTerminalIcon,
    label: 'agent.executionSurface.v1.visibleCommand',
    description: 'agent.executionSurface.v1.degradedDescription',
  },
] as const;

const REAL_TERMINAL_STATE_COPY: Record<
  RealTerminalPresentationState,
  { readonly label: LocaleKey; readonly description: LocaleKey }
> = {
  initializing: {
    label: 'agent.executionSurface.v1.state.initializing',
    description: 'agent.executionSurface.v1.initializingDescription',
  },
  ready: {
    label: 'agent.executionSurface.v1.state.ready',
    description: 'agent.executionSurface.v1.readyDescription',
  },
  unavailable: {
    label: 'agent.executionSurface.v1.state.unavailable',
    description: 'agent.executionSurface.v1.unavailableDescription',
  },
  degraded: {
    label: 'agent.executionSurface.v1.state.degraded',
    description: 'agent.executionSurface.v1.degradedDescription',
  },
};

const DIRECT_FALLBACK_COPY = {
  label: 'agent.executionSurface.v1.state.directFallback',
  description: 'agent.executionSurface.v1.directFallbackDescription',
} as const;

export interface AgentExecutionSurfaceSelectorProps {
  readonly disabled?: boolean;
  readonly surface: AgentExecutionSurface;
  readonly realTerminalState?: RealTerminalPresentationState;
  /** Reserved for a future authoritative runtime routing result. */
  readonly runtimeFallback?: TerminalSurfaceRuntimeFallbackSignal;
  /** Test/build override; the rollout switch is deliberately not persisted. */
  readonly surfaceSemanticsEnabled?: boolean;
  readonly onSurfaceChange?: (surface: AgentExecutionSurface) => void;
}

/** Session-scoped execution choice; changes apply only after the Agent becomes idle. */
export function AgentExecutionSurfaceSelector({
  disabled = false,
  surface,
  realTerminalState = 'degraded',
  runtimeFallback,
  surfaceSemanticsEnabled,
  onSurfaceChange,
}: AgentExecutionSurfaceSelectorProps): React.ReactNode {
  const { t } = useI18n();
  const presentation = resolveTerminalSurfacePresentation(
    surface,
    realTerminalState,
    runtimeFallback,
  );
  const semanticsEnabled = terminalSurfaceSemanticsV1Enabled(surfaceSemanticsEnabled);
  const options = semanticsEnabled
    ? SEMANTIC_EXECUTION_SURFACE_OPTIONS
    : LEGACY_EXECUTION_SURFACE_OPTIONS;
  const current = options.find((option) => option.surface === surface) ?? options[0];
  const CurrentIcon = current.icon;
  const disabledHint = disabled ? t('agent.executionSurface.switchHint') : undefined;
  const realTerminalCopy = REAL_TERMINAL_STATE_COPY[presentation.realTerminalState];
  const currentStateDescription = semanticsEnabled
    ? presentation.state === 'directFallback'
      ? t(DIRECT_FALLBACK_COPY.description)
      : surface === 'boundTerminal'
        ? t(realTerminalCopy.description)
        : t(current.description)
    : undefined;
  const accessibleDescription = [currentStateDescription, disabledHint]
    .filter((value): value is string => Boolean(value))
    .join(' ') || undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="xs"
            className="ai-execution-surface-trigger h-7 min-w-0 max-w-[154px] gap-1 px-[7px] @max-[480px]/ai-workspace:size-7 @max-[480px]/ai-workspace:shrink-0 @max-[480px]/ai-workspace:p-0 @max-[480px]/ai-workspace:[&_[data-icon=inline-end]]:hidden"
            data-execution-surface={surface}
            data-terminal-surface-state={semanticsEnabled ? presentation.state : undefined}
            data-real-terminal-state={semanticsEnabled ? presentation.realTerminalState : undefined}
            data-terminal-surface-semantics={semanticsEnabled ? 'v1' : 'legacy'}
            disabled={disabled}
            aria-label={`${t('agent.executionSurface')}: ${t(current.label)}`}
            aria-description={accessibleDescription}
            title={disabledHint}
          />
        )}
      >
        <CurrentIcon data-icon="inline-start" strokeWidth={1.75} />
        <span className="ai-execution-surface-label max-w-24 truncate @max-[480px]/ai-workspace:hidden">{t(current.label)}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={8}
        align="start"
        className="ai-execution-surface-menu w-[284px] max-w-[calc(100vw-16px)] p-[3px]"
        aria-label={t('agent.executionSurface')}
      >
        <DropdownMenuGroup>
          <DropdownMenuRadioGroup
            value={surface}
            onValueChange={(value) => {
              if (value === 'direct' || value === 'boundTerminal') onSurfaceChange?.(value);
            }}
          >
            {options.map((option) => {
              const Icon = option.icon;
              const directFallback = semanticsEnabled
                && option.surface === 'direct'
                && presentation.state === 'directFallback';
              const terminalState = semanticsEnabled && option.surface === 'boundTerminal'
                ? realTerminalCopy
                : undefined;
              const statusCopy = directFallback ? DIRECT_FALLBACK_COPY : terminalState;
              const description = terminalState?.description
                ?? (directFallback ? DIRECT_FALLBACK_COPY.description : option.description);
              return (
                <DropdownMenuRadioItem
                  key={option.surface}
                  value={option.surface}
                  closeOnClick
                  className="ai-execution-surface-menu-option min-h-12 items-start gap-2 py-2 pr-8 pl-2"
                  aria-description={t(description)}
                >
                  <Icon className="mt-0.5" strokeWidth={1.6} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate">{t(option.label)}</span>
                      {statusCopy && (
                        <Badge
                          variant={directFallback ? 'secondary' : 'outline'}
                          size="sm"
                          aria-hidden="true"
                        >
                          {t(statusCopy.label)}
                        </Badge>
                      )}
                    </span>
                    <span className="text-[11px] leading-4 text-muted-foreground" aria-hidden="true">
                      {t(description)}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
