export const navigationDrafts={owner:'draftakeep',other:'draftbkeep'} as const;
export function nativeNavigationManualPlan(token:string){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token))throw Error('Owned navigation identity required');
 const source=`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'navigation-${token}.txt'),'START'+[Environment]::NewLine); while ($true) { Start-Sleep -Milliseconds 50 }; [IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'navigation-${token}.txt'),'END'+[Environment]::NewLine)`;
 const args={command:source,background:false,timeoutMs:180000,lifecycleTrust:'cooperative'};
 return {source,args,goal:`Call run_terminal_command exactly ONCE with this exact JSON argument object: ${JSON.stringify(args)}. Preserve every field and decoded source character. This is a cooperative owned manual-navigation/cancellation test,not a sandbox. No Direct,repair,retries or other tools. Wait for its settlement,then stop.`};
}
export function matchesNavigationArgs(value:unknown,source:string,prepared=false):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 if(prepared)return Object.keys(args).length===3&&Object.keys(args).every(key=>['command','explanation','timeoutMs'].includes(key))&&args.command===source&&args.timeoutMs===180000&&typeof args.explanation==='string'&&args.explanation.trim().length>0;
 return Object.keys(args).every(key=>['command','explanation','timeoutMs','background','lifecycleTrust'].includes(key))&&args.command===source&&args.background===false&&args.timeoutMs===180000&&args.lifecycleTrust==='cooperative';
}
