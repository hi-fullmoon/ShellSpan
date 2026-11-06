export function nativeLateReceiptPlan(token:string){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token))throw Error('Owned late receipt identity required');
 const marker=`late-receipt-${token}.txt`,command=`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME '${marker}'),'ONCE'+[Environment]::NewLine)`,args={command,background:false,timeoutMs:5000,lifecycleTrust:'cooperative'};
 return {marker,command,args,goal:`Call run_terminal_command exactly ONCE with this exact JSON argument object: ${JSON.stringify(args)}. Keep every field and decoded source character. This owned cooperative deadline/late-receipt test may return uncertain. Do not repair,retry,replay,change the deadline,use Direct or other tools. Then stop.`};
}
export function matchesLateReceiptArgs(value:unknown,source:string,prepared=false):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const args=value as Record<string,unknown>,keys=prepared?['command','timeoutMs','explanation']:['command','background','timeoutMs','lifecycleTrust','explanation'];
 return Object.keys(args).every(x=>keys.includes(x))&&args.command===source&&args.timeoutMs===5000&&(args.explanation===undefined||typeof args.explanation==='string')&&(prepared||args.background===false&&args.lifecycleTrust==='cooperative');
}
