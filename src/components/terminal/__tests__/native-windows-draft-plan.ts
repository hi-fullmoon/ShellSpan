import type {TerminalCommandObservation} from '@/types';
export type WindowsDraftCancelStage='typing'|'fullInput';
export function isWindowsDraftCancelStage(command:TerminalCommandObservation|undefined,agentSessionId:string,stage:WindowsDraftCancelStage):boolean{
 if(!command||command.agentSessionId!==agentSessionId||!command.sourceMayBeEnqueued||command.submissionIntentDurable||command.mayHaveSubmitted)return false;
 return stage==='typing'?command.phase==='typing'&&!command.fullInputConfirmed:command.phase==='inputConfirmed'&&command.fullInputConfirmed;
}
export function nativeWindowsDraftSource(token:string):{source:string;prefix:string}{
 if(!/^[a-f0-9-]{36}$/.test(token))throw Error('Owned draft token required');
 const prefix='# APP_DRAFT_'+token,body=`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'draft-${token}.txt'),'UNEXPECTED'+[Environment]::NewLine)`;
 let source=prefix+'\n',line=0;while(source.length+64+body.length+2<2048)source+=`#L${String(line++).padStart(3,'0')} ${'a'.repeat(57)}\n`;
 source+='#'+'a'.repeat(2048-source.length-body.length-2)+'\n'+body;
 if(source.length!==2048)throw Error('Draft size mismatch');return {source,prefix};
}
export function matchesWindowsDraftArgs(value:unknown,source:string,prepared=false):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 return Object.keys(args).every(k=>(prepared?['command','timeoutMs','explanation']:['command','background','timeoutMs','lifecycleTrust','explanation']).includes(k))&&args.command===source
  &&(args.explanation===undefined||typeof args.explanation==='string')&&(prepared||args.background===false&&args.lifecycleTrust==='cooperative')&&args.timeoutMs===10000;
}
