import type { TerminalOsc52Policy } from '@/types';

export const OSC52_MAX_BYTES = 1024 * 1024;
const MAX_ENCODED_LENGTH = Math.ceil(OSC52_MAX_BYTES / 3) * 4;
const decoder = new TextDecoder();

export function decodeTerminalClipboardWrite(payload: string, policy: TerminalOsc52Policy): string | null {
  if (policy === 'disabled' || payload.length > MAX_ENCODED_LENGTH + 3) return null;
  const separator = payload.indexOf(';');
  if (separator < 0 || !/^[cp]{0,2}$/.test(payload.slice(0, separator))) return null;
  const encoded = payload.slice(separator + 1);
  if (encoded.length > MAX_ENCODED_LENGTH || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  try {
    const bytes = atob(encoded);
    if (bytes.length > OSC52_MAX_BYTES || btoa(bytes) !== encoded) return null;
    return decoder.decode(Uint8Array.from(bytes, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}
