import {nativeByteBoundaryJson} from './native-byte-boundary-plan';
import {nativeFileCoreSetup} from './native-file-chain-approval';
import {nativeValidationCommands} from './native-validation-plan';
import type {TerminalBrokerSessionSnapshot} from '@/types';

export function nativeSemanticEditorReady(current:TerminalBrokerSessionSnapshot|undefined,before:TerminalBrokerSessionSnapshot):boolean{
 return !!current&&current.terminalSessionId===before.terminalSessionId&&current.terminalGeneration===before.terminalGeneration&&current.transportSessionId===before.transportSessionId&&current.open&&current.inputMode==='native-inline'&&current.integrationState==='ready'&&current.promptReady&&!current.activeCommandId&&current.lease?.owner.kind==='user';
}
export function nativeSemanticsPlan(token:string,cwd:string,variant:'headers'|'validation'='headers'):readonly string[]{
 if(!/^[a-f0-9-]{36}$/.test(token)||!cwd)throw Error('Owned semantic identity required');
 const quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
 const commands=[
  "using namespace System.Text\nparam($B04Header=$([Console]::WriteLine('B04_DEFAULT_'+'EFFECT');'HEADER'))\n$B04Bare='PARENT'; function B04ParentFn {'FN'}; if($B04Header -cne 'HEADER' -or [StringBuilder]::new('OK').ToString() -cne 'OK'){throw 'using/default changed'}; "+nativeFileCoreSetup+"; [Console]::WriteLine('B04_HEADER_'+'OK')",
  "param([ValidateScript({[Console]::WriteLine('B04_VALIDATE_'+'UNEXPECTED');throw 'default should not validate'})]$B04Default='DEFAULT')\nbegin { if($B04Bare -cne 'PARENT' -or (B04ParentFn) -cne 'FN'){throw 'parent scope lost'}; $B04BeginCount=1; [Console]::WriteLine('B04_NAMED_'+'BEGIN') }\nprocess { $B04ProcessCount=1; [Console]::WriteLine('B04_NAMED_'+'PROCESS') }\nend { $B04EndCount=1; if($B04Default -cne 'DEFAULT'){throw 'default value changed'}; [Console]::WriteLine('B04_NAMED_'+'END') }",
  `param($B04Failure=$(throw 'B04_EXPECTED_DEFAULT_FAILURE'))\n[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'semantic-body-${token}.txt'),'BODY'); [Console]::WriteLine('B04_BODY_'+'UNEXPECTED')`,
  `if($B04Bare -cne 'PARENT' -or (B04ParentFn) -cne 'FN' -or $B04Header -cne 'HEADER' -or $B04Default -cne 'DEFAULT' -or $B04BeginCount -ne 1 -or $B04ProcessCount -ne 1 -or $B04EndCount -ne 1){throw 'parent state changed'}; if((Get-Location).ProviderPath -cne ${quote(cwd)}){throw 'cwd changed'}; [IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'scratch-effect-${token}.txt'),'ONCE'+[Environment]::NewLine); [Console]::WriteLine('B04_RECOVERY_'+'OK')`,
 ];
 return variant==='validation'?[commands[0],...nativeValidationCommands(token,cwd)]:commands;
}
export function matchesNativeSemanticStep(step:number,name:string,value:unknown,commands:readonly string[]):boolean{
 if(name!=='run_terminal_command'||!value||typeof value!=='object'||Array.isArray(value)||!commands[step])return false;
 const args=value as Record<string,unknown>;
 return Object.keys(args).every(k=>['command','background','timeoutMs','explanation'].includes(k))&&args.command===commands[step]&&(args.background===undefined||args.background===false)&&args.timeoutMs===5000;
}

export function matchesNativeSemanticOriginalStep(step:number,name:string,value:unknown,commands:readonly string[]):boolean{
 return matchesNativeSemanticStep(step,name,value,commands)&&(value as Record<string,unknown>).background===false;
}
export function nativeSemanticGoal(commands:readonly string[],variant:'headers'|'validation'='headers'):string{
 if(commands.length!==4||commands.some(source=>!source||new TextEncoder().encode(source).length>8192))throw Error('Four unchanged bounded semantic sources required');
 const argumentsJson=commands.map((command,index)=>`${index+1}. {"command":${nativeByteBoundaryJson(command)},"background":false,"timeoutMs":5000,"explanation":"Verify frozen ConsoleHost parent-parser semantics."}`).join('\n');
 return 'Perform exactly FOUR run_terminal_command calls, in order, once each;no other tools,Direct,retries or source repair. Each JSON object below is the exact tool argument object;decode its command JSON string once normally. Preserve every character and newline;no trailing CR/LF. Unicode/control escapes are ordinary JSON serialization,not literal characters in the decoded command;do not run an extra decoder. Third command intentionally fails in parameter '+(variant==='validation'?'validation of its explicit BAD argument':'default expression')+' with exit1 before its body;this is expected,do not repair/retry it. After its result,perform call4 to check the same parent state and cwd. Then stop.\n'+argumentsJson;
}

export function nativeSemanticExactGoal(commands:readonly string[],variant:'headers'|'validation'='headers'):string{
 return 'These are owned cooperative ConsoleHost parser acceptance fixtures. The selected surface is boundTerminal and the supplied argument objects are complete. Do not add lifecycleTrust: that field must be absent in every proposed call. Do not request directRequired or an independent lifecycle. Preserve the supplied source and every supplied option exactly. '+nativeSemanticGoal(commands,variant);
}
