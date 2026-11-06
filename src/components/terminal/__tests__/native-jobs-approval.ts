/** Limits the test driver's approvals; does not change production policy. */
export function validNativeJobWaitOutputLimit(value:unknown):boolean {
  return value===undefined||typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=1_048_576;
}

export function matchesNativeJobsApproval(
  value: unknown,
  commands: ReadonlyMap<string, boolean>,
  handles: readonly string[],
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = value as Record<string, unknown>;
  if ('command' in args) {
    if (typeof args.command !== 'string' || !commands.has(args.command)) return false;
    if (!Object.keys(args).every(key => ['command', 'background', 'timeoutMs', 'explanation', 'lifecycleTrust'].includes(key))) return false;
    return commands.get(args.command) ? args.background === true : args.background === undefined || args.background === false;
  }
  if (typeof args.processHandle !== 'string' || !handles.includes(args.processHandle)) return false;
  // The separately requested Direct comparison retains its own stdin plan.
  if (!args.processHandle.startsWith('job-')) return true;
  if (!Object.keys(args).every(key => ['processHandle', 'timeoutMs', 'signal', 'explanation'].includes(key))) return false;
  return 'signal' in args
    ? args.signal === 'terminate' && args.timeoutMs === 10_000
    : args.timeoutMs === 1_000;
}

export function matchesNativeJobsStep(step: number, value: unknown, sources: readonly [string, string, string], name: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = ['run_terminal_command','run_terminal_command','wait_process','wait_process','wait_process','kill_process','run_terminal_command'];
  if (name !== expected[step]) return false;
  const args = value as Record<string, unknown>;
  if (step === 0 || step === 1 || step === 6) {
    return args.command === sources[step === 0 ? 0 : step === 1 ? 1 : 2];
  }
  if (step >= 2 && step <= 4) return !('command' in args) && !('signal' in args) && args.timeoutMs === 1000;
  return step === 5 && !('command' in args) && args.signal === 'terminate' && args.timeoutMs === 10000;
}

/** Checks the recorded model proposal before any prepared-argument approval. */
export function matchesNativeJobsOriginalStep(step: number, value: unknown, sources: readonly [string, string, string], name: string, handle?: string): boolean {
  if (!matchesNativeJobsStep(step, value, sources, name)) return false;
  const args = value as Record<string, unknown>;
  if (step === 0 || step === 1 || step === 6) {
    return Object.keys(args).every(key => ['command', 'background', 'timeoutMs', 'explanation', 'lifecycleTrust'].includes(key))
      && (step === 1 ? args.background === true : args.background === undefined || args.background === false)
      && (args.lifecycleTrust === undefined || args.lifecycleTrust === 'cooperative')
      && (args.timeoutMs === undefined || typeof args.timeoutMs === 'number' && Number.isInteger(args.timeoutMs) && args.timeoutMs > 0);
  }
  return !!handle?.startsWith('job-') && args.processHandle === handle
    && Object.keys(args).every(key => ['processHandle', 'timeoutMs', 'signal', 'explanation'].includes(key));
}

interface JobsCallIdentity {readonly sessionId:string;readonly turnId?:string;readonly stepId?:string;readonly callId:string;readonly name:string;}
interface JobsApprovalIdentity {readonly sessionId:string;readonly turnId?:string;readonly stepId?:string;readonly callId:string;readonly approvalId?:string;readonly reason?:string;}
export function countNativeJobsApprovals(calls:readonly JobsCallIdentity[],approved:readonly JobsApprovalIdentity[],requested:readonly JobsApprovalIdentity[]):Readonly<{interactive:number;automaticControl:number;total:number}>{
 const key=(value:JobsCallIdentity|JobsApprovalIdentity)=>{if(!value.sessionId||!value.turnId||!value.stepId||!value.callId)throw Error('Incomplete native job approval identity');return JSON.stringify([value.sessionId,value.turnId,value.stepId,value.callId]);};
 const seen=new Set<string>();let interactive=0,automaticControl=0;
 for(const approval of approved){const id=key(approval),matching=calls.filter(call=>key(call)===id);if(matching.length!==1||seen.has(id))throw Error('Duplicate or unmatched native job approval');seen.add(id);const call=matching[0];
  if(call.name==='run_terminal_command'){if(approval.reason!=='nativeApprovalCommitted'||!approval.approvalId||!requested.some(value=>key(value)===id&&value.approvalId===approval.approvalId&&value.reason==='nativePolicyRequiresApproval'))throw Error('Native terminal source lacks its committed requested approval');interactive++;}
  else if(call.name==='wait_process'||call.name==='kill_process'){if(approval.reason!=='nativePolicyAutoApproved'||approval.approvalId!==undefined||requested.some(value=>key(value)===id))throw Error('Native job control approval policy differs');automaticControl++;}
  else throw Error('Unexpected approved native job tool');
 }
 return {interactive,automaticControl,total:approved.length};
}
