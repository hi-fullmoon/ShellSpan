import { useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useFocusStore } from '@/stores/focusStore';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';
import { FocusAgent, FocusDivider } from './focus-workspace';
import './focus.css';

export function FocusLayout({ children }: { children: ReactNode }): ReactNode {
  const { enabled, terminalOpen, split } = useFocusStore();
  const section = useAppStore(s => s.activeSection);
  useEffect(() => { if (section !== 'terminal') useFocusStore.getState().leave(); }, [section]);
  return <div className="focus-layout min-h-0 min-w-0 flex-1">
    <div data-slot="focus-layout" data-focus={enabled || undefined} data-terminal-open={terminalOpen}
      className={cn('focus-frame relative h-full min-h-0 min-w-0', enabled ? 'grid' : 'flex')}
      style={{ '--focus-agent-width': `${split * 100}%` } as CSSProperties}>
      <div data-slot="focus-agent" className={cn('ai-panel-shell min-h-0 min-w-0 overflow-hidden bg-card font-sans text-sm leading-[22px] text-foreground', !enabled && 'hidden')}><FocusAgent /></div>
      <div className={cn('focus-gutter min-h-0', (!enabled || !terminalOpen) && 'hidden')}><FocusDivider /></div>
      <div data-slot="focus-terminal" className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', enabled && !terminalOpen && 'hidden')}>{children}</div>
    </div>
  </div>;
}
