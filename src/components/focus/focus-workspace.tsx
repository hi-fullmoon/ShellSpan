import { useEffect, useRef, useState } from 'react';
import { useFocusStore } from '@/stores/focusStore';
import { useI18n } from '@/hooks/useI18n';
import { AiWorkspaceController } from '@/components/ai/workspace/ai-workspace-controller';
import '@/components/ai/styles/styles.css';
import { RESIZABLE_HANDLE_CLASS_NAME } from '@/components/ui/resizable';
import { splitPaneDividerClassName } from '@/components/ui/split-pane';
import { cn } from '@/lib/utils';

export function FocusAgent(): React.ReactNode {
  const { hasOpened } = useFocusStore();
  return hasOpened ? <AiWorkspaceController scope="terminal" focusMode /> : null;
}

/** The existing terminal stays at the same React position while this gutter resizes its columns. */
export function FocusDivider(): React.ReactNode {
  const split = useFocusStore(s => s.split);
  const drag = useRef<{ pointer: number; element: HTMLElement } | null>(null);
  const [separatorState, setSeparatorState] = useState<'hover' | 'active'>();
  const { t } = useI18n();
  useEffect(() => () => { drag.current = null; }, []);
  return <div data-slot="focus-divider" role="separator" tabIndex={0} aria-label={t('focus.resize')}
    aria-orientation="vertical" aria-valuemin={30} aria-valuemax={75} aria-valuenow={Math.round(split * 100)}
    data-separator={separatorState}
    className={cn(RESIZABLE_HANDLE_CLASS_NAME, splitPaneDividerClassName('horizontal', 'subtle'), 'cursor-col-resize touch-none before:absolute before:inset-y-0 before:left-1/2 before:w-1 before:-translate-x-1/2')}
    onPointerEnter={() => { if (!drag.current) setSeparatorState('hover'); }}
    onPointerLeave={() => { if (!drag.current) setSeparatorState(undefined); }}
    onPointerDown={e => {
      if (e.button !== 0) return;
      const element = e.currentTarget.closest<HTMLElement>('[data-slot="focus-layout"]');
      if (!element) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { pointer: e.pointerId, element };
      setSeparatorState('active');
    }}
    onPointerMove={e => { if (drag.current?.pointer !== e.pointerId) return; const rect = drag.current.element.getBoundingClientRect(); if (rect.width) useFocusStore.getState().setSplit((e.clientX - rect.left) / rect.width); }}
    onPointerUp={e => {
      drag.current = null;
      setSeparatorState(e.currentTarget.matches(':hover') ? 'hover' : undefined);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }}
    onLostPointerCapture={() => { if (drag.current) { drag.current = null; setSeparatorState(undefined); } }}
    onPointerCancel={() => { drag.current = null; setSeparatorState(undefined); }}
    onKeyDown={e => { const next = e.key === 'ArrowLeft' ? split - 0.03 : e.key === 'ArrowRight' ? split + 0.03 : e.key === 'Home' ? 0.3 : e.key === 'End' ? 0.75 : null; if (next !== null) { e.preventDefault(); useFocusStore.getState().setSplit(next); } }} />;
}
