export const nativeCaptureTailCommand='[ShellSpanAcceptanceTail]::Run()';
export const nativeCaptureTailEofCommand="& $global:__shellspanModule { if ($null -eq $script:PrivatePipe) { throw 'owned private pipe missing' }; $script:PrivatePipe.Dispose() }; [ShellSpanAcceptanceTail]::Run()";
export function nativeCaptureTailPlan(eof=false){
  const args={command:eof?nativeCaptureTailEofCommand:nativeCaptureTailCommand,background:false,timeoutMs:5000,lifecycleTrust:'cooperative'};
  return {command:args.command,args,eof,goal:`Call run_terminal_command exactly ONCE with this exact JSON object: ${JSON.stringify(args)}. This calls a bounded, owned native test program in the current shell.${eof?' It first physically closes only the owned private control pipe; source output cannot establish settlement.':''} It can remain uninterruptible until its independently controlled gate is released. If the result is uncertain, do not repair,retry,replay,use Direct or call any other tool. Then stop.`};
}
export interface AcceptanceCommandCapture {commandId:string;operationId:string;bytes:number[];captureOpen:boolean;truncated:boolean;nativeFenceRegistered:boolean;nativeFenceComplete:boolean;startSequence:number;endSequence?:number}
export function readAcceptanceCommandCapture(value:unknown):AcceptanceCommandCapture {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Actual command capture missing');
  const row=value as Record<string,unknown>;
  if(typeof row.commandId!=='string'||typeof row.operationId!=='string'||!Array.isArray(row.bytes)||!row.bytes.every(x=>typeof x==='number'&&Number.isInteger(x)&&x>=0&&x<=255)||!['captureOpen','truncated','nativeFenceRegistered','nativeFenceComplete'].every(key=>typeof row[key]==='boolean')||typeof row.startSequence!=='number'||!(row.endSequence===undefined||row.endSequence===null||typeof row.endSequence==='number'))throw Error('Invalid command capture observation');
  return row as unknown as AcceptanceCommandCapture;
}
