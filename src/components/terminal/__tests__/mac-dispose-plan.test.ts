import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {macDisposePlan} from './mac-dispose-plan';

it('executes the declared ordinary producers with exact NFD and composite-emoji bytes',()=>{
 const plan=macDisposePlan('86765bcd-3821-4a50-8c77-648bdbda171c');
 const actual=execFileSync('/bin/sh',['-c',[plan.armed,plan.queued,plan.successor].join('; ')]);
 expect(actual.equals(Buffer.from(plan.shellStdout))).toBe(true);
 expect(actual.includes(Buffer.from('e\u0301'))).toBe(true);expect(actual.includes(Buffer.from('é'))).toBe(false);
 expect(plan.queued.includes(plan.pendingText)).toBe(false);
 expect(plan.armed.includes(plan.prefix+'ARMED')).toBe(false);
});
it('rejects an unowned path or source as the dispose identity',()=>{
 expect(()=>macDisposePlan('../case')).toThrow('Exact owned');
 expect(()=>macDisposePlan('86765bcd-3821-4a50-8c77-648bdbda171c;exit')).toThrow('Exact owned');
});
