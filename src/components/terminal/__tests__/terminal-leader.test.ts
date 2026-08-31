import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTerminalLeaderKeydown, resetTerminalLeader } from '../terminal-leader';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';

const keydown = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

const lastDetail = (listener: ReturnType<typeof vi.fn>): { direction: string } =>
  (listener.mock.calls[listener.mock.calls.length - 1][0] as CustomEvent).detail;

describe('terminal-leader', () => {
  beforeEach(() => {
    useAppStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS } });
    resetTerminalLeader();
  });

  afterEach(() => {
    resetTerminalLeader();
    vi.useRealTimers();
  });

  it('consumes the leader key and dispatches a focus command on the next key', () => {
    const navigate = vi.fn();
    document.addEventListener('shellspan:navigate-terminal-pane', navigate);

    expect(handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }))).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    expect(handleTerminalLeaderKeydown(keydown({ key: 'h' }))).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(lastDetail(navigate).direction).toBe('left');

    document.removeEventListener('shellspan:navigate-terminal-pane', navigate);
  });

  it('resolves all four focus directions', () => {
    const navigate = vi.fn();
    document.addEventListener('shellspan:navigate-terminal-pane', navigate);

    const cases: Array<[string, string]> = [
      ['h', 'left'],
      ['j', 'bottom'],
      ['k', 'top'],
      ['l', 'right'],
    ];
    for (const [key, direction] of cases) {
      handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
      expect(handleTerminalLeaderKeydown(keydown({ key }))).toBe(true);
      expect(lastDetail(navigate).direction).toBe(direction);
    }
    expect(navigate).toHaveBeenCalledTimes(4);

    document.removeEventListener('shellspan:navigate-terminal-pane', navigate);
  });

  it('matches the command key even while Ctrl is still held', () => {
    const navigate = vi.fn();
    document.addEventListener('shellspan:navigate-terminal-pane', navigate);

    handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
    expect(handleTerminalLeaderKeydown(keydown({ key: 'l', ctrlKey: true }))).toBe(true);
    expect(lastDetail(navigate).direction).toBe('right');

    document.removeEventListener('shellspan:navigate-terminal-pane', navigate);
  });

  it('dispatches split and close commands', () => {
    const split = vi.fn();
    const close = vi.fn();
    document.addEventListener('shellspan:split-terminal-pane', split);
    document.addEventListener('shellspan:close-terminal-tab', close);

    handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
    expect(handleTerminalLeaderKeydown(keydown({ key: 'v' }))).toBe(true);
    expect(lastDetail(split).direction).toBe('right');

    handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
    expect(handleTerminalLeaderKeydown(keydown({ key: 's' }))).toBe(true);
    expect(lastDetail(split).direction).toBe('bottom');

    handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
    expect(handleTerminalLeaderKeydown(keydown({ key: 'x' }))).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);

    document.removeEventListener('shellspan:split-terminal-pane', split);
    document.removeEventListener('shellspan:close-terminal-tab', close);
  });

  it('swallows unknown command keys and disarms', () => {
    handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
    expect(handleTerminalLeaderKeydown(keydown({ key: 'q' }))).toBe(true);
    // Disarmed: the next plain key passes through to the pty.
    expect(handleTerminalLeaderKeydown(keydown({ key: 'q' }))).toBe(false);
  });

  it('passes through non-leader keys when not armed', () => {
    expect(handleTerminalLeaderKeydown(keydown({ key: 'h' }))).toBe(false);
    expect(handleTerminalLeaderKeydown(keydown({ key: 'f', metaKey: true }))).toBe(false);
    expect(handleTerminalLeaderKeydown(keydown({ key: 'k', ctrlKey: true }))).toBe(false);
  });

  it('passes alt/meta chords through while armed and disarms', () => {
    handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
    expect(handleTerminalLeaderKeydown(keydown({ key: '1', metaKey: true }))).toBe(false);
    expect(handleTerminalLeaderKeydown(keydown({ key: 'h' }))).toBe(false);
  });

  it('disarms after the timeout', () => {
    vi.useFakeTimers();
    handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
    vi.advanceTimersByTime(1100);
    expect(handleTerminalLeaderKeydown(keydown({ key: 'h' }))).toBe(false);
  });

  it('keeps the leader armed through key repeats of the leader itself', () => {
    const navigate = vi.fn();
    document.addEventListener('shellspan:navigate-terminal-pane', navigate);

    handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }));
    expect(handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true, repeat: true }))).toBe(true);
    expect(handleTerminalLeaderKeydown(keydown({ key: 'h' }))).toBe(true);
    expect(lastDetail(navigate).direction).toBe('left');

    document.removeEventListener('shellspan:navigate-terminal-pane', navigate);
  });

  it('follows customized leader and sub-key bindings', () => {
    useAppStore.getState().setShortcut('terminalLeader', 'mod+;');
    useAppStore.getState().setShortcut('terminalFocusLeft', 'a');
    const navigate = vi.fn();
    document.addEventListener('shellspan:navigate-terminal-pane', navigate);

    // The old default leader no longer arms.
    expect(handleTerminalLeaderKeydown(keydown({ key: 'b', ctrlKey: true }))).toBe(false);
    expect(handleTerminalLeaderKeydown(keydown({ key: ';', metaKey: true }))).toBe(true);
    expect(handleTerminalLeaderKeydown(keydown({ key: 'a' }))).toBe(true);
    expect(lastDetail(navigate).direction).toBe('left');

    document.removeEventListener('shellspan:navigate-terminal-pane', navigate);
  });

  it('ignores non-keydown events', () => {
    expect(
      handleTerminalLeaderKeydown(new KeyboardEvent('keyup', { key: 'b', ctrlKey: true })),
    ).toBe(false);
  });
});
