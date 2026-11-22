import type { TerminalDisplayBinding, TerminalDisplayFrame, TerminalDisplaySnapshot } from '@/types/agent-session';

export const DEFAULT_MAX_PENDING_DISPLAY_FRAMES = 2048;

export interface RestoreTerminalDisplayOptions {
  maxPendingFrames?: number;
  onOverflow?: () => void;
}

/** Orders the snapshot boundary and the live frames from the same renderer. */
export function restoreTerminalDisplay(
  binding: TerminalDisplayBinding,
  write: (text: string) => void,
  requestSnapshot: () => void,
  options?: RestoreTerminalDisplayOptions,
) {
  let through: number | undefined;
  const pending = new Map<number, string>();
  const maxPendingFrames = options?.maxPendingFrames ?? DEFAULT_MAX_PENDING_DISPLAY_FRAMES;

  const flush = (): void => {
    if (through === undefined) return;
    for (const [sequence, text] of [...pending].sort(([a], [b]) => a - b)) {
      if (sequence <= through) {
        pending.delete(sequence);
      } else if (sequence === through + 1) {
        write(text);
        through = sequence;
        pending.delete(sequence);
      } else {
        through = undefined;
        requestSnapshot();
        return;
      }
    }
  };

  return {
    receive(frame: TerminalDisplayFrame): void {
      if (frame.terminalSessionId !== binding.terminalSessionId || frame.terminalGeneration !== binding.terminalGeneration) return;
      if (through !== undefined && pending.size === 0) {
        if (frame.sequence <= through) return;
        if (frame.sequence === through + 1) {
          write(frame.text);
          through = frame.sequence;
          return;
        }
      }
      if (!pending.has(frame.sequence) && pending.size >= maxPendingFrames) {
        pending.clear();
        through = undefined;
        if (options?.onOverflow) {
          options.onOverflow();
        } else {
          requestSnapshot();
        }
        return;
      }
      pending.set(frame.sequence, frame.text);
      flush();
    },
    apply(snapshot: TerminalDisplaySnapshot): void {
      write(snapshot.contents);
      through = snapshot.throughSequence;
      flush();
    },
    ready(): boolean {
      return through !== undefined;
    },
  };
}
