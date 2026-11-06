import type {TerminalCommandObservation,TerminalInputObservation} from '@/types';

/** Historical evidence for a test report; never authorizes terminal input. */
export function recordedNativeUncertainty(
  events:readonly {readonly inputObservation?:TerminalInputObservation}[],
  agentSessionId:string,
):TerminalCommandObservation|undefined{
  for(let index=events.length-1;index>=0;index--){
    const command=events[index].inputObservation?.activeCommand;
    if(command?.agentSessionId===agentSessionId&&command.phase==='uncertain')return command;
  }
  return undefined;
}
