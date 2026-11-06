import {stripAnsi} from '@/lib/terminal/terminal-output-buffer';
export interface NativeFileChainPlan {fileName:string;content:string;setup:string;invoke?:string;absolutePath?:string}
// Compare Windows canonical paths without changing the source sent to the Shell.
export function nativeFileChainPathIdentity(path:string):string|null{
  const ordinary=path.startsWith('\\\\?\\')?path.slice(4):path;
  return /^[A-Za-z]:[\\/]/.test(ordinary)?ordinary.split('\\').join('/'):null;
}
export function matchesNativeFileChainStep(step:number,name:string,value:unknown,plan:NativeFileChainPlan):boolean{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const args=value as Record<string,unknown>;
  const keys=(allowed:readonly string[])=>Object.keys(args).every(key=>allowed.includes(key));
  if(step===0||step===3)return name==='run_terminal_command'&&keys(['command','background','timeoutMs','explanation'])
    &&args.command===(step===0?plan.setup:plan.invoke)&&typeof args.command==='string'&&(args.background===undefined||args.background===false)&&args.timeoutMs===5000;
  if(step===1)return name==='write_file'&&keys(['path','content','precondition','fileScope'])&&args.fileScope==='scratch'&&args.path===plan.fileName&&args.content===plan.content
    &&!!args.precondition&&typeof args.precondition==='object'&&!Array.isArray(args.precondition)&&Object.keys(args.precondition).length===1
    &&'mustNotExist'in args.precondition&&args.precondition.mustNotExist===true;
  if(step===2)return name==='read_file'&&keys(['path','encoding','offset','maxBytes','fileScope'])&&args.fileScope==='scratch'&&args.encoding==='utf8'
    &&(args.path===plan.fileName||typeof plan.absolutePath==='string'&&args.path===plan.absolutePath)&&(args.offset===undefined||args.offset===0)
    &&(args.maxBytes===undefined||typeof args.maxBytes==='number'&&Number.isSafeInteger(args.maxBytes)&&args.maxBytes>0&&args.maxBytes<=8192);
  return false;
}
export const nativeFileCoreSetup="$nativeCore=@([Diagnostics.Process]::GetCurrentProcess().Modules | Where-Object {$_.ModuleName -eq 'shellspan_native_input_editors.dll'}); if($nativeCore.Count -ne 1){throw 'native module count mismatch'}; $nativeCorePath=$nativeCore[0].FileName; $nativeCoreSha=(Get-FileHash -LiteralPath $nativeCorePath -Algorithm SHA256).Hash.ToLowerInvariant(); Write-Output ('NATIVE_CORE_'+'LOADED:'+$nativeCorePath+'|'+$nativeCoreSha+'|'+$PID); $global:NativeFileParent='PARENT'; function global:NativeFileParentFn {'FN'}; Write-Output ('B08_'+'SETUP_READY')";

export function readNativeFileLoadedCore(output:unknown):{path:string;sha256:string;pid:number}|null{
 if(typeof output!=='string')return null;
 const records=[...stripAnsi(output).matchAll(/(?:^|\r?\n)NATIVE_CORE_LOADED:([^\r\n|]+)\|([a-f0-9]{64})\|([1-9][0-9]*)(?=\r?\n|$)/g)];
 if(records.length!==1)return null;const [,path,sha256,pidText]=records[0],pid=Number(pidText);
 if(!Number.isSafeInteger(pid)||!nativeFileChainPathIdentity(path)?.toLowerCase().endsWith('/shellspan_native_input_editors.dll'))return null;
 return {path,sha256,pid};
}
