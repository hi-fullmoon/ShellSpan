import {expect,it} from 'vitest';
import {matchesNativeJobsApproval,matchesNativeJobsStep,matchesNativeJobsOriginalStep,countNativeJobsApprovals} from './native-jobs-approval';

it('approves only frozen source modes and exact native job controls', () => {
  const commands = new Map([['setup', false], ['background', true]]);
  const allowed = (args: Record<string, unknown>) => matchesNativeJobsApproval(args, commands, ['job-owned']);
  expect(allowed({command:'setup'})).toBe(true);
  expect(allowed({command:'background',background:true})).toBe(true);
  expect(allowed({processHandle:'job-owned',timeoutMs:1000})).toBe(true);
  expect(allowed({processHandle:'job-owned',signal:'terminate',timeoutMs:10000})).toBe(true);
  for (const args of [
    {command:'changed'}, {command:'setup',background:true}, {command:'background'},
    {processHandle:'job-other',timeoutMs:1000}, {processHandle:'job-owned',timeoutMs:30000},
    {processHandle:'job-owned',signal:'kill',timeoutMs:10000},
    {processHandle:'job-owned',timeoutMs:1000,data:'unexpected stdin'},
    {command:'setup',processHandle:'job-owned',timeoutMs:1000},
  ]) expect(allowed(args)).toBe(false);
});

it('requires unchanged recorded source, native mode and returned handle across all seven original proposals', () => {
  const sources = ['setup\nwith\ttext', 'background\nbody', 'final'] as const;
  const names = ['run_terminal_command','run_terminal_command','wait_process','wait_process','wait_process','kill_process','run_terminal_command'];
  const check = (step:number,args:unknown,handle='job-owned') => matchesNativeJobsOriginalStep(step,args,sources,names[step],handle);
  expect(check(0,{command:sources[0],background:false,lifecycleTrust:'cooperative'})).toBe(true);
  expect(check(1,{command:sources[1],background:true})).toBe(true);
  expect(check(6,{command:sources[2],timeoutMs:5000})).toBe(true);
  for(const step of [2,3,4])expect(check(step,{processHandle:'job-owned',timeoutMs:1000})).toBe(true);
  expect(check(5,{processHandle:'job-owned',signal:'terminate',timeoutMs:10000})).toBe(true);
  for(const args of [
    {command:sources[0]+'\n'}, {command:sources[0].replace(/\n/g,'\\n')},
    {command:sources[0],background:true}, {command:sources[0],lifecycleTrust:'strict'},
    {command:sources[0],timeoutMs:0}, {command:sources[0],processHandle:'job-owned'},
  ])expect(check(0,args)).toBe(false);
  expect(check(1,{command:sources[1],background:false})).toBe(false);
  expect(check(2,{processHandle:'job-foreign',timeoutMs:1000})).toBe(false);
  expect(check(2,{processHandle:'job-owned',timeoutMs:1000,data:'injected stdin'})).toBe(false);
  expect(check(2,{processHandle:'process-direct',timeoutMs:1000},'process-direct')).toBe(false);
});

it('keeps native approvals in the frozen seven-call order', () => {
  const sources = ['setup','background','final'] as const;
  const names=['run_terminal_command','run_terminal_command','wait_process','wait_process','wait_process','kill_process','run_terminal_command'];
  const check=(step:number,args:unknown)=>matchesNativeJobsStep(step,args,sources,names[step]??'unknown');
  expect(check(0,{command:'setup'})).toBe(true);
  expect(check(1,{command:'background'})).toBe(true);
  for(const step of [2,3,4]) expect(check(step,{processHandle:'job-owned',timeoutMs:1000})).toBe(true);
  expect(check(5,{processHandle:'job-owned',signal:'terminate',timeoutMs:10000})).toBe(true);
  expect(check(6,{command:'final'})).toBe(true);
  expect(matchesNativeJobsStep(2,{processHandle:'job-owned',timeoutMs:1000},sources,'kill_process')).toBe(false);
  for(const step of [1,2,3,4,5,6,7]) expect(check(step,{command:'setup'})).toBe(false);
});

it('keeps three requested source approvals separate from four native auto-approved controls',()=>{
 const names=['run_terminal_command','run_terminal_command','wait_process','wait_process','wait_process','kill_process','run_terminal_command'];
 const calls=names.map((name,index)=>({sessionId:'agent-owned',turnId:'turn-owned',stepId:'step-'+index,callId:'call-'+index,name}));
 const requested=calls.filter(x=>x.name==='run_terminal_command').map(x=>({...x,approvalId:'approval-'+x.callId,reason:'nativePolicyRequiresApproval'}));
 const approved=calls.map(x=>x.name==='run_terminal_command'?{...x,approvalId:'approval-'+x.callId,reason:'nativeApprovalCommitted'}:{...x,reason:'nativePolicyAutoApproved'});
 expect(countNativeJobsApprovals(calls,approved,requested)).toEqual({interactive:3,automaticControl:4,total:7});
 expect(()=>countNativeJobsApprovals(calls,[...approved,approved[0]],requested)).toThrow('Duplicate');
 expect(()=>countNativeJobsApprovals(calls,approved.map((x,index)=>index===2?{...x,reason:'nativeApprovalCommitted'}:x),requested)).toThrow('control approval');
 expect(()=>countNativeJobsApprovals(calls,approved,requested.slice(1))).toThrow('committed requested');
 expect(()=>countNativeJobsApprovals(calls,approved,[...requested,{...calls[2],approvalId:'unexpected',reason:'nativePolicyRequiresApproval'}])).toThrow('control approval');
});
