import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import { BotIcon, CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
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
  const [visible, setVisible] = useState<Array<{ block: TerminalCommandBlock; top: number }>>([]);
  const [copiedBlockId, setCopiedBlockId] = useState<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
      const overlay = bounds.current;
      const buffer = terminal.buffer.active;
      if (!screen || !overlay || !screen.clientHeight || buffer.type !== 'normal' || !tracker) {
        setVisible((current) => current.length ? [] : current);
        return;
      }
      const { viewportY } = buffer;
      const height = screen.clientHeight / terminal.rows;
      const offset = screen.getBoundingClientRect().top - overlay.getBoundingClientRect().top;
      const rows = new Map<number, TerminalCommandBlock>();
      for (const block of tracker.list()) {
        const line = block.prompt?.line;
        if (block.lifecycle && line !== undefined && line >= viewportY && line < viewportY + terminal.rows) {
          rows.set(line, block);
        }
      }
      const visibleBlocks = [...rows].map(([line, block]) => ({ block, top: offset + (line - viewportY + 0.5) * height }));
      setVisible((current) => current.length === visibleBlocks.length && current.every((item, index) =>
        item.block === visibleBlocks[index].block && item.top === visibleBlocks[index].top,
      ) ? current : visibleBlocks);
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update); };
    schedule();
    const disposables = [terminal.onScroll(schedule), terminal.onResize(schedule),
      terminal.onRender(schedule), terminal.buffer.onBufferChange(schedule)];
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      disposables.forEach((disposable) => disposable.dispose());
    };
  }, [terminal, tracker, revision]);

  const read = (block: TerminalCommandBlock): string | null => {
    const contents = readTerminalCommandOutput(terminal, block);
    if (contents === null) error(t('terminal.commandBlock.outputUnavailable'));
    return contents;
  };

  return <div ref={bounds} className="pointer-events-none absolute inset-y-0 left-0 w-3" data-terminal-command-overlay>
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
          <PopoverTrigger openOnHover delay={300} aria-label={label} className="grid h-4 w-3 cursor-pointer place-items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">
            <span aria-hidden="true"
              style={running ? { backgroundColor: runningDotColor } : undefined}
              className={cn('size-1.5 rounded-full ring-1 ring-black/15 dark:ring-white/20',
                running ? 'motion-safe:animate-pulse' : failed ? 'bg-destructive' : 'bg-app-success')} />
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-auto max-w-[min(22rem,calc(100vw-2rem))]">
            <PopoverTitle className="text-xs">{label}</PopoverTitle>
            {!running && <div className="flex flex-wrap items-center gap-1">
              <Button size="xs" variant="outline" disabled={!block.end} onClick={() => {
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
                {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
                {copied ? t('common.copied') : t('terminal.commandBlock.copy')}
              </Button>
              <Button size="xs" variant={failed ? 'default' : 'ghost'} disabled={!block.end} onClick={() => {
                const output = read(block);
                if (output === null) return;
                const workspace = useFocusStore.getState().enabled ? 'focus' : 'terminal';
                useAiDraftStore.getState().insertTerminalText(`${workspace}:${sessionId}`, [
                  t('terminal.commandBlock.draft', { code: lifecycle.exitCode ?? 0, directory: lifecycle.cwd }),
                  output.slice(0, 16_000),
                  ...(output.length > 16_000 ? [t('terminal.commandBlock.truncated')] : []),
                ].join('\n\n'));
                useAiPanelStore.getState().setOpen(true, 'terminal');
              }}><BotIcon data-icon="inline-start" />{t('terminal.commandBlock.diagnose')}</Button>
            </div>}
          </PopoverContent>
        </Popover>
      </div>;
    })}
  </div>;
}
