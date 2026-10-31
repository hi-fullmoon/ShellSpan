/// <reference lib="es2022.intl" />

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function commandGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), segment => segment.segment);
}

/** Animate approved source inside a verified native input scope; never send input. */
export function createTerminalCommandTyping(enabled: () => boolean, changed: () => void) {
  const pending = new Map<string, { target: string; characters: string[]; shown: number }>();
  let frame: number | undefined;
  let disposed = false;
  const schedule = () => {
    if (disposed || frame !== undefined || ![...pending.values()].some(state => state.shown < state.characters.length)) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (disposed) return;
      for (const state of pending.values()) {
        // Adapt to real transport batches while keeping each paint small.
        // The native parser and its receipt/submission fences keep running.
        const remaining = state.characters.length - state.shown;
        state.shown += Math.max(0, Math.ceil(remaining / 8));
      }
      changed();
      schedule();
    });
  };
  return {
    show(id: string, verified: string, complete = false): string {
      if (complete || !enabled()) {
        pending.delete(id);
        return verified;
      }
      let state = pending.get(id);
      if (state && state.target.startsWith(verified) && state.target !== verified) {
        return state.characters.slice(0, Math.min(state.shown, commandGraphemes(verified).length)).join('');
      }
      if (!state || !verified.startsWith(state.target)) {
        state = { target: verified, characters: commandGraphemes(verified), shown: 0 };
        pending.set(id, state);
      } else if (state.target !== verified) {
        state.target = verified;
        state.characters = commandGraphemes(verified);
      }
      schedule();
      return state.characters.slice(0, state.shown).join('');
    },
    retain(ids: ReadonlySet<string>) {
      for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
      if (pending.size === 0 && frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
    },
    dispose() {
      disposed = true;
      pending.clear();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    },
  };
}
