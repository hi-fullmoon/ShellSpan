import {expect,it} from 'vitest';
import {nativeSemanticsPlan,matchesNativeSemanticStep} from './native-semantics-plan';
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
