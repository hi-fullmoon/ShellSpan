import {expect,it} from 'vitest';
import {nativeUserDraftEofPlan} from './native-user-draft-eof-plan';
const token='dfa69841-ea10-485b-bbda-a59cbb6a99c5';
it('keeps an unsubmitted user draft distinct from the real managed pipe release gate',()=>{
  const plan=nativeUserDraftEofPlan(token);
  expect(plan.marker).not.toBe(plan.release);
  expect(plan.draft).not.toMatch(/[\r\n]/);
  expect(plan.draft).toContain(plan.prefix);
  expect(plan.draft).toContain(plan.marker);
  expect(plan.setup).not.toContain(plan.prefix);
  expect(plan.setup).not.toContain(plan.marker);
});
it('bounds the managed disposal worker without synthesizing control receipts or editor input',()=>{
  const {setup}=nativeUserDraftEofPlan(token);
  expect(setup).toContain('deadline.ElapsedMilliseconds<30000');
  expect(setup).toContain('if(File.Exists(gate))pipe.Dispose()');
  expect(setup).toContain('thread.IsBackground=true');
  expect(setup).not.toMatch(/ss_editor_|SendKeys|AcceptLine|GetBufferState/);
});
it('rejects path or shell substitutions before constructing any source',()=>{
  for(const value of ['../outside',"a';exit",token+'/../'])expect(()=>nativeUserDraftEofPlan(value)).toThrow('Owned');
});
