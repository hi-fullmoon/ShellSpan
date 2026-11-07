import {afterEach, expect, it, vi} from 'vitest';
import {Terminal} from '@xterm/xterm';
import {createNativeOriginDiagnostic} from './native-origin-diagnostic';

afterEach(() => vi.useRealTimers());
it('records only public geometry, preserves text and APIs, and stops after disposal', () => {
  vi.useFakeTimers();
  const terminal = new Terminal({cols: 80, rows: 24, allowProposedApi: true});
  const cellRead = vi.spyOn(terminal.buffer.active, 'getLine');
  const write = vi.spyOn(terminal, 'write').mockImplementation((_value, callback) => callback?.());
  const collector = createNativeOriginDiagnostic(terminal);
  const request = {sessionId: 'ui', terminalSessionId: 'terminal', terminalGeneration: 1,
    requestId: 'owned', requestIndex: 1, timeoutMs: 1000,
    geometry: {columns: 80, rows: 24, cursorX: 0, cursorY: 0}};
  collector.observe(request);vi.advanceTimersByTime(1000);
  expect(collector.records).toHaveLength(1);
  expect(collector.records[0].samples.map(sample => sample.phase)).toEqual(['event', 'drained', 'later', 'deadline']);
  expect(collector.records[0].samples.every(sample => sample.columns === 80 && sample.rows === 24)).toBe(true);
  expect(cellRead).not.toHaveBeenCalled();expect(write).toHaveBeenCalledExactlyOnceWith('', expect.any(Function));
  collector.observe({...request, requestIndex: 2});collector.dispose();
  const samples = collector.records[1].samples.length;vi.runAllTimers();
  expect(collector.records[1].samples).toHaveLength(samples);
  collector.observe({...request, requestIndex: 3});expect(collector.records).toHaveLength(2);
  terminal.dispose();
});
it('bounds the number of requests without adding any input or terminal listeners', () => {
  vi.useFakeTimers();const terminal = new Terminal({allowProposedApi: true});
  const write = vi.spyOn(terminal, 'write').mockImplementation((_value, callback) => callback?.());
  const inputListener = vi.fn(() => {throw new Error('Diagnostic must not access terminal input listeners');});
  Object.defineProperty(terminal, 'onData', {configurable: true, get: inputListener});
  const collector = createNativeOriginDiagnostic(terminal);
  for (let requestIndex = 1; requestIndex <= 40; requestIndex++) collector.observe({sessionId: 'ui',
    terminalSessionId: 'terminal', terminalGeneration: 1, requestId: String(requestIndex), requestIndex,
    timeoutMs: 1000, geometry: {columns: 80, rows: 24, cursorX: 0, cursorY: 0}});
  vi.runAllTimers();expect(collector.records).toHaveLength(32);expect(write).toHaveBeenCalledTimes(32);
  expect(inputListener).not.toHaveBeenCalled();collector.dispose();terminal.dispose();
});
