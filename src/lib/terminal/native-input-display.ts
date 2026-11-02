import type { IDisposable, Terminal } from '@xterm/xterm';

/** Display capability only. P1 defines negotiation and the online payloads. */
export interface NativeInputDisplayBinding {
  readonly inputMode: 'native-inline';
  readonly oscIdentifier: number;
  readonly enterPayload: string;
  readonly exitPayload: string;
  readonly ownedReflowCursorLine?: boolean;
}

/** Optional registered provider for a verified editor's owned display only. */
export interface NativeInputDisplayOptions {
  readonly unicodeVersion?: string;
}

export interface NativeInputDisplayController extends IDisposable {
  /** Call after the closed transport's ordered output has finished parsing. */
  resetAfterTransportClosed(): void;
  /** Ordered parser barrier, then disposal; conveys no command/lease evidence. */
  closeAfterPendingOutput(): Promise<void>;
}

/** NIP/1 display binding. Installation still requires explicit native negotiation. */
export const NATIVE_INPUT_DISPLAY_V1: NativeInputDisplayBinding = Object.freeze({
  inputMode: 'native-inline', oscIdentifier: 1337,
  enterPayload: 'SetUserVar=ShellSpanNativeInputV1=MQ==',
  exitPayload: 'SetUserVar=ShellSpanNativeInputV1=MA==',
});

const attachedTerminals = new WeakSet<Terminal>();
const printablePayload = /^[\x20-\x7e]{1,1024}$/;

/**
 * Opt-in attachment for a negotiated native editor, never for legacy/raw.
 * OSC is untrusted presentation: this module has no lifecycle, input, lease,
 * readiness or execution callbacks. Native on/off bytes must share PTY order
 * with draft acceptance/clear. No terminal instance installs this implicitly.
 */
export function attachNativeInputDisplay(
  terminal: Terminal,
  binding: NativeInputDisplayBinding,
  options: NativeInputDisplayOptions = {},
): NativeInputDisplayController {
  if (binding.inputMode !== 'native-inline'
      || !Number.isSafeInteger(binding.oscIdentifier)
      || binding.oscIdentifier < 0
      || binding.oscIdentifier > 0x7fffffff
      || !printablePayload.test(binding.enterPayload)
      || !printablePayload.test(binding.exitPayload)
      || binding.enterPayload === binding.exitPayload
      || binding.ownedReflowCursorLine !== undefined && typeof binding.ownedReflowCursorLine !== 'boolean') {
    throw new TypeError('Invalid native editor display binding');
  }
  if (terminal.options.reflowCursorLine !== false || attachedTerminals.has(terminal)) {
    throw new Error('Native editor display requires an unattached default-reflow terminal');
  }
  const unicodeVersion = options.unicodeVersion;
  if (unicodeVersion !== undefined && (typeof unicodeVersion !== 'string'
      || !terminal.unicode.versions.includes(unicodeVersion))) {
    throw new TypeError('Native editor display requires a registered Unicode provider');
  }

  let disposed = false;
  let previousUnicodeVersion: string | undefined;
  const restoreUnicode = (): void => {
    if (previousUnicodeVersion === undefined) return;
    // Preserve an explicit external provider change made during this scope.
    if (terminal.unicode.activeVersion === unicodeVersion) {
      terminal.unicode.activeVersion = previousUnicodeVersion;
    }
    previousUnicodeVersion = undefined;
  };
  const handler = terminal.parser.registerOscHandler(binding.oscIdentifier, payload => {
    if (disposed) return false;
    if (payload === binding.enterPayload) {
      if (unicodeVersion !== undefined && previousUnicodeVersion === undefined) {
        previousUnicodeVersion = terminal.unicode.activeVersion;
        terminal.unicode.activeVersion = unicodeVersion;
      }
      terminal.options.reflowCursorLine = binding.ownedReflowCursorLine ?? true;
      return true;
    }
    if (payload === binding.exitPayload) {
      terminal.options.reflowCursorLine = false;
      restoreUnicode();
      return true;
    }
    return false;
  });
  attachedTerminals.add(terminal);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    handler.dispose();
    attachedTerminals.delete(terminal);
    terminal.options.reflowCursorLine = false;
    restoreUnicode();
  };
  return { dispose, resetAfterTransportClosed: dispose,
    closeAfterPendingOutput: () => new Promise<void>((resolve) => {
      // Even an already-disposed handler may still have transport bytes queued
      // in xterm. Keep the barrier before permitting a caller to rebind.
      terminal.write('', () => { dispose(); resolve(); });
    }),
  };
}
