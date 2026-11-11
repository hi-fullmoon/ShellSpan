import type {TerminalBrokerSessionSnapshot} from '@/types';
export function verifyNativeFileDecline(state:unknown,before:TerminalBrokerSessionSnapshot,after:TerminalBrokerSessionSnapshot){
 if(!state||typeof state!=='object'||Array.isArray(state))throw Error('Structured declined-write witness required');
 const value=state as Record<string,unknown>;
 if(!before.terminalSessionId||!before.transportSessionId||!Number.isSafeInteger(before.terminalGeneration)||before.terminalGeneration<1||!before.currentDirectory||!Number.isSafeInteger(before.nextInputSequence))throw Error('Declined write lacks an original frozen terminal binding');
 if(!Array.isArray(value.files)||value.files.length!==0||!Array.isArray(value.effectEntries)||value.effectEntries.length!==0)throw Error('Rejected approval created a script or effect');
 for(const key of ['terminalSessionId','terminalGeneration','transportSessionId','currentDirectory','nextInputSequence'] as const)if(before[key]!==after[key])throw Error('Declined write changed frozen terminal identity, cwd or input');
 if(after.inputMode!=='native-inline'||after.activeCommandId||after.inputObservation?.activeCommand)throw Error('Declined write entered a native input operation');
 return{scriptCreated:false,effectCreated:false,terminalInputUnchanged:true,frozenTargetUnchanged:true};
}
