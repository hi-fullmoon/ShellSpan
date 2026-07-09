import { describe, expect, it, beforeEach, vi } from 'vitest';
import { terminalRegistry } from './terminalRegistry';

// xterm + addons work in jsdom for write/buffer; fit yields 0x0 (harmless).
// Polyfill ResizeObserver if undefined.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = (globalThis.ResizeObserver ?? RO) as typeof ResizeObserver;

vi.mock('@/lib/tauri', () => ({
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn().mockResolvedValue(() => {}),
  listenToSshStatus: vi.fn().mockResolvedValue(() => {}),
  listenToSshClosed: vi.fn().mockResolvedValue(() => {}),
}));

describe('terminalRegistry', () => {
  beforeEach(() => {
    terminalRegistry.disposeAll();
  });

  it('create attaches container to a host and write appends to buffer', () => {
    const setStatus = vi.fn();
    const setClosed = vi.fn();
    const controller = terminalRegistry.create('s1', setStatus, setClosed);
    const host = document.createElement('div');
    controller.attach(host);
    expect(host.firstChild).toBe(controller.container);
    controller.write('hello');
    expect(controller.terminal.buffer.active.length).toBeGreaterThan(0);
  });

  it('detach keeps buffer intact; reattach to a different host preserves buffer', () => {
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const host1 = document.createElement('div');
    const host2 = document.createElement('div');
    controller.attach(host1);
    controller.write('abc');
    const lenAfterWrite = controller.terminal.buffer.active.length;
    controller.detach();
    expect(host1.firstChild).toBeNull();
    controller.attach(host2);
    expect(host2.firstChild).toBe(controller.container);
    expect(controller.terminal.buffer.active.length).toBe(lenAfterWrite);
  });

  it('dispose removes the controller and container from host', () => {
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const host = document.createElement('div');
    controller.attach(host);
    terminalRegistry.dispose('s1');
    expect(terminalRegistry.get('s1')).toBeUndefined();
    expect(host.firstChild).toBeNull();
  });

  it('detach nulls resizeObserver; reattach creates a fresh observer', () => {
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const host1 = document.createElement('div');
    controller.attach(host1);
    expect(controller.resizeObserver).not.toBeNull();
    const firstObserver = controller.resizeObserver;
    controller.detach();
    expect(controller.resizeObserver).toBeNull();
    const host2 = document.createElement('div');
    controller.attach(host2);
    expect(controller.resizeObserver).not.toBeNull();
    expect(controller.resizeObserver).not.toBe(firstObserver);
  });

  it('attach to a different host without detach replaces the observer', () => {
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    const host1 = document.createElement('div');
    controller.attach(host1);
    const firstObserver = controller.resizeObserver;
    const host2 = document.createElement('div');
    controller.attach(host2);
    expect(controller.resizeObserver).not.toBe(firstObserver);
  });

  it('double dispose is a no-op', () => {
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn());
    expect(() => {
      controller.dispose();
      controller.dispose();
    }).not.toThrow();
  });
});