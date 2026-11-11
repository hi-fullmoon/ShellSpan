import {expect,it} from 'vitest';
import {nativeSemanticsPlan,matchesNativeSemanticStep,matchesNativeSemanticOriginalStep,nativeSemanticGoal} from './native-semantics-plan';
import {nativeSemanticEditorReady} from './native-semantics-plan';
import {nativeSemanticExactGoal} from './native-semantics-plan';
import type {TerminalBrokerSessionSnapshot} from '@/types';

it('only clarifies omission of lifecycleTrust without changing original semantic objects or accepting extra options',()=>{
 for(const variant of ['headers','validation'] as const){
  const commands=nativeSemanticsPlan('12345678-1234-1234-1234-123456789abc','D:/owned',variant),original=nativeSemanticGoal(commands,variant),exact=nativeSemanticExactGoal(commands,variant),rows=(text:string)=>text.split('\n').filter(line=>/^[1-4]\. \{/.test(line));
  expect(rows(exact)).toEqual(rows(original));expect(exact).toContain('that field must be absent');
  rows(exact).forEach((line,index)=>{const args=JSON.parse(line.slice(3)) as Record<string,unknown>;expect(matchesNativeSemanticOriginalStep(index,'run_terminal_command',args,commands)).toBe(true);for(const lifecycleTrust of ['cooperative','directRequired'])expect(matchesNativeSemanticOriginalStep(index,'run_terminal_command',{...args,lifecycleTrust},commands)).toBe(false);});
 }
});

it('requires actual editor readiness and the original generation before the next deterministic proposal',()=>{
 const before={terminalSessionId:'terminal-owned',terminalGeneration:2,transportSessionId:'transport-owned'} as TerminalBrokerSessionSnapshot;
 const ready={...before,open:true,inputMode:'native-inline',integrationState:'ready',promptReady:true,lease:{owner:{kind:'user'}}} as TerminalBrokerSessionSnapshot;
 expect(nativeSemanticEditorReady(ready,before)).toBe(true);
 for(const changed of [{promptReady:false},{activeCommandId:'settled-but-still-owned'},{terminalGeneration:3},{terminalSessionId:'other'},{transportSessionId:'other'},{open:false},{inputMode:'legacy'},{integrationState:'degraded'},{lease:{owner:{kind:'revoking'}}},{lease:undefined}]){
  expect(nativeSemanticEditorReady({...ready,...changed} as TerminalBrokerSessionSnapshot,before)).toBe(false);
 }
 expect(nativeSemanticEditorReady(undefined,before)).toBe(false);
});
it('freezes semantic source bytes,order,foreground mode and read-only approval matching',()=>{
 const commands=nativeSemanticsPlan('12345678-1234-1234-1234-123456789abc',"D:/owned/parent's-home");
 expect(commands).toHaveLength(4);expect(commands[0].startsWith('using namespace System.Text\nparam(')).toBe(true);expect(commands.every(s=>new TextEncoder().encode(s).length<=8192&&!/[\r\n]$/.test(s))).toBe(true);
 expect(commands[3]).toContain("'D:/owned/parent''s-home'");
 const args={command:commands[0],background:false,timeoutMs:5000};expect(matchesNativeSemanticStep(0,'run_terminal_command',args,commands)).toBe(true);
 for(const changed of [{...args,command:args.command+'\n'},{...args,background:true},{...args,timeoutMs:6000},{...args,nativeScriptInput:true}])expect(matchesNativeSemanticStep(0,'run_terminal_command',changed,commands)).toBe(false);
 expect(matchesNativeSemanticStep(1,'run_terminal_command',args,commands)).toBe(false);expect(matchesNativeSemanticStep(0,'exec_command',args,commands)).toBe(false);
});
it('keeps explicit argument validation distinct from skipped default-value validation',()=>{
 const token='12345678-1234-1234-1234-123456789abc',normal=nativeSemanticsPlan(token,'D:/owned'),validation=nativeSemanticsPlan(token,'D:/owned','validation');
 expect(validation).toHaveLength(4);expect(validation[0]).toBe(normal[0]);expect(validation[1]).toContain("} 'OK'");expect(validation[2]).toContain("} 'BAD'");expect(validation[2]).toContain('B04_EXPECTED_ARGUMENT_FAILURE');expect(validation[3]).toContain('$global:B04GoodValidationCount -ne 1');
 expect(matchesNativeSemanticStep(1,'run_terminal_command',{command:normal[1],timeoutMs:5000},validation)).toBe(false);
});

it('requires the explicit original foreground option and preserves every semantic source through one standard JSON parse',()=>{
 for(const variant of ['headers','validation'] as const){
  const commands=nativeSemanticsPlan('12345678-1234-1234-1234-123456789abc',"D:/owned/父Shell-e\u0301's-home",variant),goal=nativeSemanticGoal(commands,variant),argumentsJson=goal.split('\n').filter(line=>/^\d\. /.test(line));
  expect(argumentsJson).toHaveLength(4);expect(/[^\x20-\x7e\n]/.test(goal)).toBe(false);
  argumentsJson.forEach((line,index)=>{const args=JSON.parse(line.slice(3)) as Record<string,unknown>;expect(args.command).toBe(commands[index]);expect(matchesNativeSemanticOriginalStep(index,'run_terminal_command',args,commands)).toBe(true);expect(matchesNativeSemanticOriginalStep(index,'run_terminal_command',{command:commands[index],timeoutMs:5000},commands)).toBe(false);expect(matchesNativeSemanticOriginalStep(index,'run_terminal_command',{...args,command:JSON.stringify(commands[index])},commands)).toBe(false);});
 }
 expect(()=>nativeSemanticGoal(['changed'])).toThrow('Four unchanged bounded');
});
