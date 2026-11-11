import {expect, it, vi} from 'vitest';
import {createHash, webcrypto} from 'node:crypto';
import {NativeDisplayTrace, type NativeDisplayTraceInitial} from './native-display-trace';
const initial: NativeDisplayTraceInitial = {columns: 80, rows: 24, empty: true, unicodeVersion: '15-graphemes', nativeDisplayBinding: undefined, options: {}};
it('retains exact UTF16 ranges through Unicode chunks and a parsed-before-resize boundary', () => {
  const trace = new NativeDisplayTrace(initial), first = '中 é 👩🏽‍💻\r\n', second = 'tail\t ';
  const a = trace.output(first);trace.parsed(a);trace.resize(47, 18);
  const b = trace.output(second);trace.parsed(b);
  const result = trace.snapshot(first + second);expect(result.replayable).toBe(true);
  const outputs = result.events.filter(event => event.type === 'output');
  expect(outputs.map(event => (first + second).slice(event.offset, event.offset + event.characters))).toEqual([first, second]);
  expect(outputs[1].offset).toBe(first.length);expect(result.offsetUnit).toBe('UTF16-code-units');expect(result.inputOrLifecycleAuthority).toBe(false);
});
it('rejects a resize with queued prior output even if parsing later completes', () => {
  const trace = new NativeDisplayTrace(initial);const n = trace.output('pending');trace.resize(58,18);trace.parsed(n);
  expect(trace.snapshot('pending').replayable).toBe(false);
});
it('rejects a late observer and missing ranges instead of inventing an initial screen', () => {
  const trace = new NativeDisplayTrace({...initial, empty: false});trace.output('tail');trace.parsed(0);
  expect(trace.snapshot('prefix' + 'tail').issues).toEqual(['Initial display was not empty when observation began', 'Observed decoded output does not match trace range']);
});
it('records selection coordinates once without synthesizing output or an input receipt', () => {
  const trace = new NativeDisplayTrace(initial);trace.action({kind: 'select',column:0,row:12,length:201+22});trace.action({kind:'scrollToLine',row:12});trace.resize(47,18);
  const result = trace.snapshot('');expect(result.replayable).toBe(true);expect(result.outputEvents).toBe(0);
  expect(result.events.map(event=>event.type)).toEqual(['action','action','resize']);
});
it('rejects unknown parse acknowledgements and output overflow', () => {
  const trace = new NativeDisplayTrace(initial);trace.parsed(0);expect(trace.output('x'.repeat(900001))).toBe(-1);
  expect(trace.snapshot('').replayable).toBe(false);
});
it('hashes an exact checkpoint with real SHA256 and rejects an undrained checkpoint', async () => {
  vi.stubGlobal('crypto', webcrypto);
  try {
    const trace = new NativeDisplayTrace(initial), state = JSON.stringify({selection: '中 é 👩🏽‍💻\r\nsecond'});
    trace.output('pending');await trace.checkpoint('before-parse', state);trace.parsed(0);
    const result = trace.snapshot('pending'), event = result.events.find(value => value.type === 'checkpoint');
    expect(event?.stateSha256).toBe(createHash('sha256').update(state).digest('hex'));
    expect(event?.stateJson).toBe(state);
    expect(result.issues).toContain('Checkpoint occurred before previously observed output was parsed');
  } finally {vi.unstubAllGlobals();}
});
it('distinguishes actual local status bytes from session bytes without regenerating either', () => {
  const trace = new NativeDisplayTrace(initial), status = '\u001b[33m实际状态\u001b[0m\r\n', session = '原始显示\t ';
  trace.parsed(trace.output(status, 'local'));trace.parsed(trace.output(session, 'session'));
  const result = trace.snapshot(status + session);
  expect(result.version).toBe(2);expect(result.streamKind).toBe('actual-visible-output');
  expect(result.events.filter(event => event.type === 'output').map(event => event.source)).toEqual(['local', 'session']);
  expect(result.replayable).toBe(true);
});
it('retains the original public search action instead of reconstructing its selection',()=>{
 const trace=new NativeDisplayTrace(initial);trace.action({kind:'searchNext',term:'actual historical 中文 e\u0301'});
 const value=trace.snapshot('');expect(value.events).toEqual([{type:'action',action:{kind:'searchNext',term:'actual historical 中文 e\u0301'},outputSequence:-1,parsedThrough:-1}]);
 expect(value.outputEvents).toBe(0);expect(value.inputOrLifecycleAuthority).toBe(false);
});
it('keeps exact public paste data and ordering separate from visible bytes and earlier trace versions',()=>{
 const trace=new NativeDisplayTrace(initial),original='printf 中文 e\u0301 👩🏽‍💻\nsecond\t  ';
 trace.parsed(trace.output('actual output\r\n'));trace.action({kind:'paste',data:original});
 const value=trace.snapshot('actual output\r\n');
 expect(value.version).toBe(5);expect(value.replayable).toBe(true);expect(value.outputCharacters).toBe(15);
 expect(value.events[1]).toEqual({type:'action',action:{kind:'paste',data:original},outputSequence:0,parsedThrough:0});
 expect(value.inputOrLifecycleAuthority).toBe(false);expect(new NativeDisplayTrace(initial).snapshot('').version).toBe(2);
});
it('keeps rendering lifecycle observations explicit without granting command authority',()=>{
 const trace=new NativeDisplayTrace(initial);trace.action({kind:'unicodeVersion',version:'6'});trace.action({kind:'transportClosed'});
 const value=trace.snapshot('');expect(value.version).toBe(3);expect(value.outputEvents).toBe(0);expect(value.inputOrLifecycleAuthority).toBe(false);
 expect(value.events.map(event=>event.type==='action'?event.action:null)).toEqual([{kind:'unicodeVersion',version:'6'},{kind:'transportClosed'}]);
});
it('retains a real rebind request between old queued output and the captured boundary without inventing a drain',()=>{
 const trace=new NativeDisplayTrace(initial),ptyInfo={transportKind:'localPty' as const,inputMode:'raw' as const};
 trace.output('old\u001b[?25h','local');trace.action({kind:'rebindDisplay',ptyInfo});trace.parsed(0);
 trace.parsed(trace.output('\u001b\\','local'));trace.parsed(trace.output('new','session'));
 const value=trace.snapshot('old\u001b[?25h\u001b\\new');
 expect(value.version).toBe(4);expect(value.replayable).toBe(true);expect(value.inputOrLifecycleAuthority).toBe(false);
 expect(value.events[1]).toEqual({type:'action',action:{kind:'rebindDisplay',ptyInfo},outputSequence:0,parsedThrough:-1});
 expect(value.events.filter(event=>event.type==='output').map(event=>event.characters)).toEqual([9,2,3]);
});
