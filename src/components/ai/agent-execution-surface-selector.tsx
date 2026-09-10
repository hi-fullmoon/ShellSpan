import { MonitorCogIcon, SquareTerminalIcon } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/hooks/useI18n';
import type { AgentExecutionSurface } from '@/types/agent-session';

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

  return (
    <ToggleGroup
      data-slot="agent-execution-surface-selector"
      className="ai-execution-surface-selector"
      aria-label={t('agent.executionSurface')}
      value={[surface]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === 'direct' || next === 'boundTerminal') onSurfaceChange?.(next);
      }}
      variant="outline"
      size="sm"
      spacing={0}
    >
      <ToggleGroupItem
        className="ai-execution-surface-option"
        value="direct"
        disabled={disabled}
        aria-label={t('agent.executionSurface.direct')}
        aria-description={t('agent.executionSurface.directDescription')}
      >
        <MonitorCogIcon data-icon="inline-start" />
        <span className="ai-execution-surface-label truncate">{t('agent.executionSurface.direct')}</span>
      </ToggleGroupItem>
      <ToggleGroupItem
        className="ai-execution-surface-option"
        value="boundTerminal"
        disabled={disabled}
        aria-label={t('agent.executionSurface.boundTerminal')}
        aria-description={t('agent.executionSurface.boundTerminalDescription')}
      >
        <SquareTerminalIcon data-icon="inline-start" />
        <span className="ai-execution-surface-label truncate">{t('agent.executionSurface.boundTerminal')}</span>
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
