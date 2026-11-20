import type { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { TerminalExportFormat } from '@/lib/ipc/tauri';

export function terminalBufferText(terminal: Terminal, first = 0, last = terminal.buffer.active.length - 1): string {
  const buffer = terminal.buffer.active;
  const chunks: string[] = [];
  for (let index = Math.max(0, first); index <= last && index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) break;
    const continuation = index < last && buffer.getLine(index + 1)?.isWrapped;
    chunks.push(line.translateToString(!continuation));
    if (!continuation && index < last) chunks.push('\n');
  }
  return chunks.join('').trimEnd();
}

export async function serializeTerminalBuffer(terminal: Terminal, format: TerminalExportFormat): Promise<string> {
  await new Promise<void>((resolve) => terminal.write('', resolve));
  if (format === 'text') return terminalBufferText(terminal);
  const addon = new SerializeAddon();
  terminal.loadAddon(addon);
  try {
    return addon.serialize({ excludeModes: true });
  } finally {
    addon.dispose();
  }
}
