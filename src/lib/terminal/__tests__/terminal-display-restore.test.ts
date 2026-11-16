import { Terminal } from '@xterm/xterm';
import { expect, it } from 'vitest';
import capture from '@/tests/fixtures/terminal-display-recovery.json';
import { restoreTerminalDisplay } from '../terminal-display-restore';

// The snapshot and live frames are captured from the production Rust broker.
it('restores the alternate screen and applies newer output exactly once', async () => {
  const { binding, snapshot, covered, tail } = capture;
  const terminal = new Terminal({ cols: snapshot.columns, rows: snapshot.rows });
  const drained = () => new Promise<void>((resolve) => terminal.write('', resolve));
  const replay = restoreTerminalDisplay(binding, (text) => terminal.write(text), () => {
    throw new Error('unexpected display sequence gap');
  });
  try {
    replay.receive(covered);
    expect(replay.ready()).toBe(false);
    replay.apply(snapshot);
    await drained();
    expect(terminal.buffer.active.type).toBe('alternate');
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('Manual editor');
    expect(terminal.buffer.active.cursorY).toBe(2);
    expect(terminal.buffer.active.cursorX).toBe(3);
    replay.receive(tail);
    replay.receive(tail);
    await drained();
    expect(terminal.buffer.active.type).toBe('normal');
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('Ready');
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('$ continued');
  } finally {
    terminal.dispose();
  }
});

it('applies output buffered during refresh after the snapshot boundary', async () => {
  const { binding, snapshot, covered, tail } = capture;
  const terminal = new Terminal({ cols: snapshot.columns, rows: snapshot.rows });
  const replay = restoreTerminalDisplay(binding, (text) => terminal.write(text), () => {
    throw new Error('unexpected display sequence gap');
  });
  try {
    replay.receive(tail);
    replay.receive(covered);
    replay.apply(snapshot);
    await new Promise<void>((resolve) => terminal.write('', resolve));
    expect(replay.ready()).toBe(true);
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('$ continued');
  } finally {
    terminal.dispose();
  }
});
