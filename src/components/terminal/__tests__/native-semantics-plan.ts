import {nativeFileCoreSetup} from './native-file-chain-approval';
import {nativeValidationCommands} from './native-validation-plan';
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
