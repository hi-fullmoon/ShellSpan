import { useMemo, useRef, useState } from 'react';
import type { SessionState, UpdateState } from '../../types';
import { StatusBlock } from './StatusBlock';
import { StatusBlockTooltip } from './StatusBlockTooltip';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/ui';

interface SystemBlocksProps {
  sessions: SessionState[];
  activeSession: SessionState | undefined;
  updateState: UpdateState;
  updateDownloadProgress: number | undefined;
}

export function SystemBlocks({ sessions, activeSession, updateState, updateDownloadProgress }: SystemBlocksProps) {
  const connectedCount = useMemo(() => sessions.filter((s) => s.status === 'connected').length, [sessions]);
  const hasUpdate = updateState.phase !== 'idle' && updateState.phase !== 'no_update';

  return (
    <div className={cn('flex shrink-0 items-center gap-1')}>
      {sessions.length > 0 ? (
        <SystemBlock
          icon={<SessionCountIcon count={connectedCount} />}
          progress={100}
          tone="neutral"
          tooltip={{ title: t('statusBar.system.sessions', { count: sessions.length, connected: connectedCount }) }}
        />
      ) : null}
      {activeSession ? (
        <SystemBlock
          icon={<HostInitial host={activeSession.host} />}
          progress={100}
          tone={activeSession.status === 'connected' ? 'success' : activeSession.status === 'error' ? 'error' : 'active'}
          tooltip={{ title: activeSession.title || activeSession.host, subtitle: activeSession.status }}
        />
      ) : null}
      {hasUpdate ? (
        <SystemBlock
          icon={<UpdateIcon phase={updateState.phase} />}
          progress={updateDownloadProgress ?? (updateState.phase === 'downloaded' ? 100 : 0)}
          tone={updateState.phase === 'error' ? 'error' : updateState.phase === 'downloaded' ? 'success' : 'active'}
          tooltip={{ title: t('statusBar.system.update'), subtitle: updateState.phase }}
        />
      ) : null}
    </div>
  );
}

function SystemBlock({
  icon,
  progress,
  tone,
  tooltip,
}: {
  icon: React.ReactNode;
  progress: number;
  tone: 'active' | 'success' | 'error' | 'neutral';
  tooltip: { title: string; subtitle?: string };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  return (
    <div ref={ref} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <StatusBlock icon={icon} progress={progress} tone={tone} />
      <StatusBlockTooltip open={hovered} anchorRef={ref} data={tooltip} />
    </div>
  );
}

function SessionCountIcon({ count }: { count: number }) {
  return (
    <div className={cn('flex h-full w-full items-center justify-center text-[9px] font-semibold leading-none')}>
      {count}
    </div>
  );
}

function HostInitial({ host }: { host: string }) {
  const initial = host ? host.charAt(0).toUpperCase() : '?';
  return (
    <div className={cn('flex h-full w-full items-center justify-center text-[9px] font-semibold leading-none')}>
      {initial}
    </div>
  );
}

function UpdateIcon({ phase }: { phase: UpdateState['phase'] }) {
  return (
    <div className={cn('flex h-full w-full items-center justify-center text-[9px] font-semibold leading-none')}>
      {phase === 'downloaded' ? '✓' : '↻'}
    </div>
  );
}
