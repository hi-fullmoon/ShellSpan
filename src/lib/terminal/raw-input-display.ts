import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { IDisposable, Terminal } from '@xterm/xterm';
import { getPlatform } from '@/lib/platform';
import type { SessionPtyInfo } from '@/types';

/** Local Darwin character widths only; no native binding or input authority. */
export function attachRawInputDisplay(terminal: Terminal, ptyInfo?: SessionPtyInfo): IDisposable | undefined {
  if (getPlatform() !== 'macos' || ptyInfo?.transportKind !== 'localPty' || ptyInfo.inputMode !== 'raw') {
    return undefined;
  }
  const previous = terminal.unicode.activeVersion;
  if (!terminal.unicode.versions.includes('11')) terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (terminal.unicode.activeVersion === '11') terminal.unicode.activeVersion = previous;
    },
  };
}
