export function nativeWindowsStopSource(token:string):string{
 if(!/^[a-f0-9-]{36}$/.test(token))throw Error('Owned stop token required');
 const file=`(Join-Path $env:SHELLSPAN_LOCAL_HOME 'stop-${token}.txt')`;
 return `[IO.File]::AppendAllText(${file},'START'+[Environment]::NewLine); while ($true) { Start-Sleep -Milliseconds 50 }; [IO.File]::AppendAllText(${file},'DONE'+[Environment]::NewLine)`;
}
export function matchesNativeWindowsStop(value:unknown,source:string):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const args=value as Record<string,unknown>;
 return Object.keys(args).every(k=>['command','background','timeoutMs','explanation'].includes(k))&&args.command===source
  &&(args.background===undefined||args.background===false)&&args.timeoutMs===30000;
}
// This validates the cancellation envelope only. The caller must independently
// verify matching endObserved, settled durable intent, prompt and user recovery.
export function matchesWindowsStopResult(status:string,value:unknown,mode:'cancel'|'takeover'):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const data=value as Record<string,unknown>;
 return status==='cancelled'&&data.channel==='terminal'&&data.state===(mode==='cancel'?'cancelled':'takenOver')
  &&data.execution==='unknown'&&typeof data.exitCode==='number'&&data.noAutoReplay===true;
}
