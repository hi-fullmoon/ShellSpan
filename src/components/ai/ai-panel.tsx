import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { useAiStore } from '@/stores/aiStore';
import { useAppStore } from '@/stores/appStore';
import type { AppSection } from '@/types';
import { AiWorkspaceController } from './workspace/ai-workspace-controller';

const AI_PANEL_DEFAULT_WIDTH = 400;
const AI_PANEL_MIN_WIDTH = 320;
const AI_PANEL_MAX_WIDTH = 720;
const MAIN_CONTENT_MIN_WIDTH = 480;
const AI_PANEL_KEYBOARD_RESIZE_STEP = 24;
const AI_PANEL_WIDTH_STORAGE_KEY = 'shellspan.aiPanelWidth';

export function getAiPanelWidthBounds(containerWidth: number): { min: number; max: number } {
  if (containerWidth < MAIN_CONTENT_MIN_WIDTH) {
    const max = Math.max(0, Math.min(AI_PANEL_MAX_WIDTH, containerWidth));
    return { min: Math.min(AI_PANEL_MIN_WIDTH, max), max };
  }
  const max = Math.max(0, Math.min(AI_PANEL_MAX_WIDTH, containerWidth - MAIN_CONTENT_MIN_WIDTH));
  return { min: Math.min(AI_PANEL_MIN_WIDTH, max), max };
}

export function clampAiPanelWidth(width: number, containerWidth: number): number {
  const bounds = getAiPanelWidthBounds(containerWidth);
  return Math.round(Math.min(Math.max(width, bounds.min), bounds.max));
}

function initialAiPanelWidth(): number {
  if (typeof window === 'undefined') return AI_PANEL_DEFAULT_WIDTH;
  const storedWidth = Number(window.localStorage.getItem(AI_PANEL_WIDTH_STORAGE_KEY));
  return Number.isFinite(storedWidth) && storedWidth > 0
    ? storedWidth
    : AI_PANEL_DEFAULT_WIDTH;
}

function useCompactAiPanelViewport(): boolean {
  const [compact, setCompact] = useState(() => window.innerWidth <= 479);

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 479px)');
    const update = (): void => setCompact(query ? query.matches : window.innerWidth <= 479);
    update();
    query?.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      query?.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return compact;
}

interface AiPanelResizeHandleProps {
  bounds: { min: number; max: number };
  resizing: boolean;
  width: number;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  onLostPointerCapture: React.PointerEventHandler<HTMLDivElement>;
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>;
  onPointerDown: React.PointerEventHandler<HTMLDivElement>;
  onPointerMove: React.PointerEventHandler<HTMLDivElement>;
  onPointerUp: React.PointerEventHandler<HTMLDivElement>;
}

export const AiPanelResizeHandle: React.FC<AiPanelResizeHandleProps> = ({
  bounds,
  resizing,
  width,
  onKeyDown,
  onLostPointerCapture,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}) => {
  const { t } = useI18n();

  return (
    <div
      data-slot="ai-panel-resize-handle"
      role="separator"
      aria-label={t('ai.resize')}
      aria-orientation="vertical"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      data-resizing={resizing || undefined}
      className="group absolute inset-y-0 -left-0.5 z-10 w-1 cursor-col-resize touch-none outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
    >
      <div
        data-slot="ai-panel-resize-indicator"
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent shadow-none transition-all duration-150 delay-0 group-hover:w-1 group-hover:bg-app-primary group-hover:delay-200 group-focus-visible:w-1 group-focus-visible:bg-app-primary group-data-[resizing]:w-1 group-data-[resizing]:bg-app-primary"
      />
    </div>
  );
};

export interface AiPanelShellProps {
  children: React.ReactNode;
  open: boolean;
  panelTitle: string;
  scope: AppSection;
  onOpenChange: (open: boolean) => void;
}

export const AiPanelShell: React.FC<AiPanelShellProps> = ({
  children,
  open,
  panelTitle,
  scope,
  onOpenChange,
}) => {
  const [panelWidth, setPanelWidth] = useState(initialAiPanelWidth);
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const resizeStartRef = useRef<{
    pointerId: number;
    clientX: number;
    width: number;
    containerWidth: number;
  } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingPanelWidthRef = useRef<number | null>(null);
  const compactViewport = useCompactAiPanelViewport();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(AI_PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [panelWidth]);

  const measureContainerWidth = useCallback((): number => {
    if (compactViewport) return window.innerWidth;
    const width = panelRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
    return width > 0 ? width : window.innerWidth;
  }, [compactViewport]);

  const applyPendingPanelWidth = useCallback(() => {
    resizeFrameRef.current = null;
    if (pendingPanelWidthRef.current === null) return;
    setPanelWidth(pendingPanelWidthRef.current);
    pendingPanelWidthRef.current = null;
  }, []);

  const finishPanelResize = useCallback(() => {
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      applyPendingPanelWidth();
    }
    resizeStartRef.current = null;
    setResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [applyPendingPanelWidth]);

  useEffect(() => {
    const applyContainerWidth = (nextWidth: number): void => {
      const width = nextWidth > 0 ? nextWidth : window.innerWidth;
      setContainerWidth((current) => Math.abs(current - width) < 1 ? current : width);
      setPanelWidth((current) => clampAiPanelWidth(current, width));
    };
    const handleWindowResize = (): void => applyContainerWidth(measureContainerWidth());
    const container = compactViewport ? null : panelRef.current?.parentElement;

    applyContainerWidth(measureContainerWidth());
    if (container && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width !== undefined) applyContainerWidth(width);
      });
      observer.observe(container);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [compactViewport, measureContainerWidth, open]);

  useEffect(() => () => {
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
    }
    resizeFrameRef.current = null;
    pendingPanelWidthRef.current = null;
    resizeStartRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    if (!open && resizeStartRef.current) finishPanelResize();
  }, [finishPanelResize, open]);

  if (!open) return null;

  const panelWidthBounds = getAiPanelWidthBounds(containerWidth);
  const panelContent = (
    <aside
      ref={panelRef}
      data-slot="ai-panel"
      data-ai-scope={scope}
      className={cn(
        'relative flex h-full min-w-0 shrink-0 flex-col',
        scope === 'terminal' ? 'bg-background' : 'bg-muted/20',
        !compactViewport && 'border-l border-app-border',
      )}
      style={{ width: compactViewport ? '100%' : panelWidth }}
      aria-label={panelTitle}
    >
      {!compactViewport && (
        <AiPanelResizeHandle
          bounds={panelWidthBounds}
          resizing={resizing}
          width={panelWidth}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizeStartRef.current = {
              pointerId: event.pointerId,
              clientX: event.clientX,
              width: panelWidth,
              containerWidth: measureContainerWidth(),
            };
            setResizing(true);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          onPointerMove={(event) => {
            const start = resizeStartRef.current;
            if (!start || start.pointerId !== event.pointerId) return;
            pendingPanelWidthRef.current = clampAiPanelWidth(
              start.width + start.clientX - event.clientX,
              start.containerWidth,
            );
            if (resizeFrameRef.current === null) {
              resizeFrameRef.current = window.requestAnimationFrame(applyPendingPanelWidth);
            }
          }}
          onPointerUp={(event) => {
            if (resizeStartRef.current?.pointerId !== event.pointerId) return;
            finishPanelResize();
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={finishPanelResize}
          onLostPointerCapture={finishPanelResize}
          onKeyDown={(event) => {
            let nextWidth: number | undefined;
            if (event.key === 'ArrowLeft') {
              nextWidth = panelWidth + AI_PANEL_KEYBOARD_RESIZE_STEP;
            } else if (event.key === 'ArrowRight') {
              nextWidth = panelWidth - AI_PANEL_KEYBOARD_RESIZE_STEP;
            } else if (event.key === 'Home') {
              nextWidth = panelWidthBounds.min;
            } else if (event.key === 'End') {
              nextWidth = panelWidthBounds.max;
            }
            if (nextWidth === undefined) return;
            event.preventDefault();
            setPanelWidth(clampAiPanelWidth(nextWidth, measureContainerWidth()));
          }}
        />
      )}
      {children}
    </aside>
  );

  return (
    <TooltipProvider>
      {compactViewport ? (
        <Drawer open={open} onOpenChange={onOpenChange}>
          <DrawerContent
            showCloseButton={false}
            className="max-w-none gap-0 overflow-hidden rounded-none border-l p-0"
            style={{ width: `min(100vw, ${panelWidth}px)` }}
          >
            <DrawerTitle className="sr-only">{panelTitle}</DrawerTitle>
            {panelContent}
          </DrawerContent>
        </Drawer>
      ) : panelContent}
    </TooltipProvider>
  );
};

export const AiPanel: React.FC = () => {
  const { t } = useI18n();
  const activeSection = useAppStore((state) => state.activeSection);
  const panelSection = activeSection === 'terminal' ? 'terminal' : 'workbench';
  const open = useAiStore((state) => (
    activeSection !== 'sftp' && state.panelOpenBySection[panelSection]
  ));
  const setOpen = useAiStore((state) => state.setOpen);
  const panelTitle = activeSection === 'terminal'
    ? t('ai.terminal.title')
    : t('ai.workbench.title');
  return (
    <AiPanelShell
      open={open}
      panelTitle={panelTitle}
      scope={activeSection}
      onOpenChange={(nextOpen) => setOpen(nextOpen, panelSection)}
    >
      <AiWorkspaceController
        scope={panelSection}
        onClose={() => setOpen(false, panelSection)}
      />
    </AiPanelShell>
  );
};
