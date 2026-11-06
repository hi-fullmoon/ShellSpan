export function nativeActiveEofPlan(token:string){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token))throw Error('Owned active EOF identity required');
 const marker=`active-eof-${token}.txt`,release=`release-eof-${token}.txt`;
 const command=`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME '${marker}'),'START'+[Environment]::NewLine); while (-not (Test-Path -LiteralPath (Join-Path $env:SHELLSPAN_LOCAL_HOME '${release}'))) { Start-Sleep -Milliseconds 20 }; & $global:__shellspanModule { if ($null -eq $script:PrivatePipe) { throw 'owned private pipe missing' }; $script:PrivatePipe.Dispose() }; [IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME '${marker}'),'AFTER_EOF'+[Environment]::NewLine)`;
 const args={command,background:false,timeoutMs:30000,lifecycleTrust:'cooperative'};
 return {command,args,marker,release,goal:`Call run_terminal_command exactly ONCE with this exact JSON argument object: ${JSON.stringify(args)}. Preserve every field and decoded source character. This is an owned cooperative control-pipe fault test,not a sandbox. No Direct,repair,retry or other tools. Its result may be uncertain;do not replay it. Then stop.`};
}
