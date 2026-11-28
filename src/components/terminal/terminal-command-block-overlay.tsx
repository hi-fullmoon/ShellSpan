import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import { CheckIcon, CopyIcon, SparklesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyFeedbackLabel } from '@/components/ui/copy-button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { writeClipboardText } from '@/lib/clipboard';
import { readTerminalCommandOutput, type TerminalCommandBlock } from '@/lib/terminal/terminal-command-blocks';
import { cn } from '@/lib/utils';
import { useAiDraftStore } from '@/stores/aiDraftStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { resolveTerminalTheme } from './registry/terminal-registry';
import { subscribeTerminalCommandTrackers, terminalCommandTracker } from './terminal-command-activity';

const noSubscribe = () => () => {};
const emptyRevision = () => 0;
const SINGLE_ROW_MIN_WIDTH = 400;

export function TerminalCommandBlockOverlay({ terminal, sessionId }: { terminal: Terminal; sessionId: string }) {
  const { t } = useI18n();
  const { error } = useToast();
  const colorScheme = useAppStore((state) => state.terminalColorScheme);
  const colorOverrides = useAppStore((state) => state.terminalColorOverrides);
  const terminalTheme = colorScheme === 'app' ? colorOverrides : resolveTerminalTheme(colorScheme, colorOverrides);
  const runningDotColor = terminalTheme?.brightBlue ?? terminalTheme?.blue ?? terminalTheme?.cursor ?? 'var(--app-primary)';
  const tracker = useSyncExternalStore(subscribeTerminalCommandTrackers, () => terminalCommandTracker(terminal));
  const revision = useSyncExternalStore(tracker?.subscribe ?? noSubscribe, tracker?.getRevision ?? emptyRevision);
  const bounds = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRef = useRef<(() => void) | null>(null);
  const [visible, setVisible] = useState<Array<{ block: TerminalCommandBlock; top: number }>>([]);
  const [compact, setCompact] = useState(false);
  const [copiedBlockId, setCopiedBlockId] = useState<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    let frame: number | undefined;
    let cachedScreen: HTMLElement | null = null;
    let observedScreen: HTMLElement | null = null;
    let geometryDirty = true;
    let cachedGeometry: { offset: number; rowHeight: number; compact: boolean } | null = null;

    const invalidateGeometry = () => {
      geometryDirty = true;
      schedule();
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(invalidateGeometry) : null;

    const measureGeometry = (overlay: HTMLElement): { offset: number; rowHeight: number; compact: boolean } | null => {
      if (!cachedScreen || !cachedScreen.isConnected) {
        if (observedScreen && observer) observer.unobserve(observedScreen);
        cachedScreen = terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? null;
        observedScreen = cachedScreen;
        if (observedScreen && observer) observer.observe(observedScreen);
      }
      if (!cachedScreen || !cachedScreen.clientHeight || terminal.rows <= 0) return null;
      const overlayRect = overlay.getBoundingClientRect();
      const viewportSpace = typeof window !== 'undefined' && window.innerWidth > 0
        ? Math.max(0, window.innerWidth - overlayRect.left)
        : cachedScreen.clientWidth;
      const availableWidth = Math.min(cachedScreen.clientWidth || viewportSpace, viewportSpace);
      return {
        offset: cachedScreen.getBoundingClientRect().top - overlayRect.top,
        rowHeight: cachedScreen.clientHeight / terminal.rows,
        compact: availableWidth > 0 && availableWidth < SINGLE_ROW_MIN_WIDTH,
      };
    };

    const update = () => {
      frame = undefined;
      const overlay = bounds.current;
      const buffer = terminal.buffer.active;
      if (!overlay || buffer.type !== 'normal' || !tracker) {
        setVisible((current) => current.length ? [] : current);
        return;
      }
      if (geometryDirty || !cachedGeometry) {
        cachedGeometry = measureGeometry(overlay);
        geometryDirty = false;
      }
      if (!cachedGeometry) {
        setVisible((current) => current.length ? [] : current);
        return;
      }
      const { viewportY } = buffer;
      const { offset, rowHeight, compact: nextCompact } = cachedGeometry;
      setCompact((current) => (current === nextCompact ? current : nextCompact));
      const rows = new Map<number, TerminalCommandBlock>();
      for (const block of tracker.list()) {
        const line = block.prompt?.line;
        if (block.lifecycle && line !== undefined && line >= viewportY && line < viewportY + terminal.rows) {
          rows.set(line, block);
        }
      }
      const visibleBlocks = [...rows].map(([line, block]) => ({ block, top: offset + (line - viewportY + 0.5) * rowHeight }));
      setVisible((current) => current.length === visibleBlocks.length && current.every((item, index) =>
        item.block === visibleBlocks[index].block && item.top === visibleBlocks[index].top,
      ) ? current : visibleBlocks);
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update); };
    scheduleRef.current = schedule;
    schedule();
    const disposables = [terminal.onScroll(schedule), terminal.onResize(invalidateGeometry),
      terminal.buffer.onBufferChange(invalidateGeometry)];
    if (observer && bounds.current) observer.observe(bounds.current);
    return () => {
      scheduleRef.current = null;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
      disposables.forEach((disposable) => disposable.dispose());
    };
  }, [terminal, tracker]);

  useEffect(() => {
    scheduleRef.current?.();
  }, [revision]);

  const read = (block: TerminalCommandBlock): string | null => {
    const contents = readTerminalCommandOutput(terminal, block);
    if (contents === null) error(t('terminal.commandBlock.outputUnavailable'));
    return contents;
  };

  return <div ref={bounds} className="pointer-events-none absolute inset-y-0 left-0 w-2.5" data-terminal-command-overlay>
    {visible.map(({ block, top }) => {
      const lifecycle = block.lifecycle!;
      const running = lifecycle.phase === 'running';
      const failed = !running && (lifecycle.exitCode ?? 0) !== 0;
      const label = running ? t('terminal.commandBlock.running') : t('terminal.commandBlock.result', {
        code: lifecycle.exitCode ?? 0, seconds: ((lifecycle.durationMs ?? 0) / 1000).toFixed(1),
      });
      const copied = copiedBlockId === block.id;
      return <div key={block.id} className="pointer-events-auto absolute left-0 -translate-y-1/2" style={{ top }}>
        <Popover>
          <PopoverTrigger openOnHover delay={300} aria-label={label} className="group/command-dot grid h-4 w-2.5 cursor-pointer place-items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">
            <span aria-hidden="true"
              style={running ? { backgroundColor: runningDotColor } : undefined}
              className={cn('size-1.5 rounded-full ring-1 ring-black/15 transition-transform duration-150 group-hover/command-dot:scale-125 group-data-[popup-open]/command-dot:scale-125 dark:ring-white/20',
                running ? 'motion-safe:animate-pulse' : failed ? 'bg-destructive' : 'bg-app-success')} />
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="center"
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              'w-fit max-w-[min(28rem,calc(100vw-2rem))] gap-1 rounded-lg p-1 text-xs',
              compact ? 'flex-col items-start' : 'flex-row flex-wrap items-center',
            )}
          >
            <PopoverTitle className={cn(
              'inline-flex h-6 items-center gap-1 whitespace-nowrap px-2 text-xs leading-none tabular-nums',
              failed ? 'font-medium text-destructive' : 'font-normal text-muted-foreground',
            )}>
              <span
                aria-hidden="true"
                style={running ? { backgroundColor: runningDotColor } : undefined}
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  running ? 'motion-safe:animate-pulse' : failed ? 'bg-destructive' : 'bg-app-success',
                )}
              />
              <span>{label}</span>
            </PopoverTitle>
            {!running && !compact && <Separator orientation="vertical" className="h-3.5 data-vertical:self-center" />}
            {!running && <div className="flex flex-wrap items-center gap-0.5">
              <Button size="xs" variant="ghost" disabled={!block.end} onClick={() => {
                const output = read(block);
                if (output === null) return;
                void writeClipboardText(output).then(() => {
                  if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
                  setCopiedBlockId(block.id);
                  copyTimer.current = setTimeout(() => {
                    copyTimer.current = undefined;
                    setCopiedBlockId((current) => (current === block.id ? null : current));
                  }, 1500);
                }).catch(() => error(t('terminal.feedback.copyFailed')));
              }}>
                {copied
                  ? <CheckIcon data-icon="inline-start" aria-hidden="true" className="text-app-success" />
                  : <CopyIcon data-icon="inline-start" aria-hidden="true" className="text-muted-foreground" />}
                <CopyFeedbackLabel copied={copied} label={t('terminal.commandBlock.copy')} className="text-center" />
              </Button>
              <Button size="xs" variant={failed ? 'soft' : 'ghost'} disabled={!block.end} onClick={() => {
                const output = read(block);
                if (output === null) return;
                const workspace = useFocusStore.getState().enabled ? 'focus' : 'terminal';
                useAiDraftStore.getState().insertTerminalText(`${workspace}:${sessionId}`, [
                  t('terminal.commandBlock.draft', { code: lifecycle.exitCode ?? 0, directory: lifecycle.cwd }),
                  output.slice(0, 16_000),
                  ...(output.length > 16_000 ? [t('terminal.commandBlock.truncated')] : []),
                ].join('\n\n'));
                useAiPanelStore.getState().setOpen(true, 'terminal');
              }}>
                <SparklesIcon data-icon="inline-start" aria-hidden="true" className={cn(!failed && 'text-muted-foreground')} />
                <span>{t('terminal.commandBlock.diagnose')}</span>
              </Button>
            </div>}
          </PopoverContent>
        </Popover>
      </div>;
    })}
  </div>;
}
