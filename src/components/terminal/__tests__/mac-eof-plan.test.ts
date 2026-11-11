import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {macEofPlan} from './mac-eof-plan';
const token='86765bcd-3821-4a50-8c77-648bdbda171c';
it('runs the real ordinary HUP producer with original NFD and composite-emoji bytes',()=>{
 const plan=macEofPlan(token),actual=execFileSync('/bin/sh',['-c',plan.setup+'; kill -HUP $$']);
 expect(actual.equals(Buffer.from(plan.nonPtyHupExpected,'utf8'))).toBe(true);
 expect(actual.includes(Buffer.from('e\u0301','utf8'))).toBe(true);expect(actual.includes(Buffer.from('é','utf8'))).toBe(false);
});
it('keeps the real natural-exit producer’s incomplete UTF8 tail as original bytes',()=>{
 const plan=macEofPlan(token),actual=execFileSync('/bin/sh',['-c',plan.natural]);
 const expected=Buffer.concat([Buffer.from('\u001b]1337;SetUserVar=ShellSpanNativeInput=MQ==\u0007'+plan.prefix+'NATURAL\n'),Buffer.from([0xe2,0x82])]);
 expect(actual.equals(expected)).toBe(true);
});
it('refuses a path or command in place of the owned case identity',()=>{
 expect(()=>macEofPlan('../case')).toThrow();expect(()=>macEofPlan(token+';exit')).toThrow();
});
it('retains a real missing-module unload failure even when a later stdout marker succeeds',()=>{
 const plan=macEofPlan(token),result=spawnSync('/bin/bash',['--noprofile','--norc','-c',plan.privateClose('bash')],{encoding:'utf8'});
 expect(result.error).toBeUndefined();expect(result.status).toBe(0);expect(result.stderr.length).toBeGreaterThan(0);
 expect(result.stdout).toBe(plan.prefix+'PRIVATE_CLOSE_STATUS_1\n'+plan.prefix+'PRIVATE_CLOSED\n');
 expect(result.stdout.includes(plan.prefix+'PRIVATE_CLOSE_STATUS_0\n')).toBe(false);
});
