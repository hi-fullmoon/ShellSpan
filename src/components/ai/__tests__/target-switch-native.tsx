import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useRemoteSandboxVerification } from '../workspace/use-remote-sandbox-verification';
import type { AgentSandboxPolicy, AgentSessionTarget } from '@/types/agent-session';
import { invokeCreateAgentRuntimeSession, invokeStartAgentRuntime, invokeListAiRoutes,
  invokeAgentRuntimeFollowup, invokeGetAgentRuntimeEvents, invokeRejectAgentRuntimeTool,
  invokeGetSandboxAuthorizations } from '@/lib/ipc/tauri';

type OwnedTarget = {target:AgentSessionTarget;generation:string};
const rendered=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));

/** Real production hook/IPC, beside the independently observed full workbench. */
export async function verificationMatrix():Promise<Record<string,boolean>>{
  const owned=await invoke<{targets:OwnedTarget[]}>('sandbox_settings_review_targets');
  if(owned.targets.length!==2 || owned.targets[0].target.sessionId===owned.targets[1].target.sessionId)
    throw new Error('Two actual independent owned SSH sources required');
  type Selection={index:number;policy:AgentSandboxPolicy};
  let select: ((selection:Selection)=>void)|undefined;
  let current: ReturnType<typeof useRemoteSandboxVerification>|undefined;
  function Observer(){
    const [selection,setSelection]=useState<Selection>({index:0,policy:'workspace'});
    const item=owned.targets[selection.index];
    const actual=useRemoteSandboxVerification(item.target,selection.policy,item.generation,true);
    const latest=useRef(actual);latest.current=actual;current=latest.current;select=setSelection;
    return null;
  }
  const container=document.createElement('div');container.hidden=true;document.body.append(container);
  const root=createRoot(container);
  flushSync(()=>root.render(<Observer/>));await rendered();
  const check=()=>{if(!current)throw new Error('Real mounted verification observer missing');return current;};
  const choose=async(index:number,policy:AgentSandboxPolicy='workspace')=>{
    flushSync(()=>select?.({index,policy}));await rendered();
  };
  const checks:Record<string,boolean>={};
  try{
    await check().verify();await rendered();
    checks.actualA=check().result?.capability.status==='partial';
    await choose(1);checks.completedResultNotOnB=check().result===undefined;
    await choose(0);checks.completedResultNotRevivedOnA=check().result===undefined;
    await choose(1);
    // B has no verification cache yet: observe an actual SSH/SFTP preflight,
    // without a delay barrier, fake response or altered production timer.
    const pending=check().verify();await rendered();checks.actualInFlight=check().busy;
    await choose(0);checks.inFlightNotOnA=check().result===undefined&&!check().busy;
    await choose(1);await pending;await rendered();checks.oldInFlightNotRevived=check().result===undefined;
    await check().verify();await rendered();
    checks.actualB=check().result?.capability.status==='partial';
    checks.boundToB=check().result?.target.sessionId===owned.targets[1].target.sessionId
      &&check().result?.target.rootPath===owned.targets[1].target.rootPath;
    await choose(1,'readOnly');checks.policyChangeDiscarded=check().result===undefined;
    await choose(1);checks.policyReturnNotRevived=check().result===undefined;
    await choose(0);await check().verify();await rendered();checks.freshA=check().result?.capability.status==='partial';
    if(!Object.values(checks).every(Boolean))throw new Error(`Actual verification matrix failed: ${JSON.stringify(checks)}`);
    return checks;
  }finally{root.unmount();container.remove();}
}

export async function pendingA():Promise<unknown>{
  const owned=await invoke<{targets:OwnedTarget[]}>('sandbox_settings_review_targets');
  const target={...owned.targets[0].target,targetId:`terminal-${owned.targets[0].target.sessionId}`};
  const sessionId=`target-a-${crypto.randomUUID()}`;
  const command='printf target-a > switch-target-a';
  await invokeCreateAgentRuntimeSession({sessionId,taskId:sessionId,goal:'Actual pending approval on owned target A',
    target,sandboxPolicy:'workspace',executionSurface:'direct',permissionMode:'requestApproval'});
  const routes=await invokeListAiRoutes();
  if(!routes.defaultSelection)throw new Error('Actual selected model required');
  await invokeStartAgentRuntime({sessionId,selection:routes.defaultSelection});
  await invokeAgentRuntimeFollowup({sessionId,messageId:crypto.randomUUID(),content:
    `Use exactly one run_terminal_command command=${JSON.stringify(command)}, background=false. The frozen target already supplies the project cwd. Do not add cd or alter the command. Request approval; no other tools or outside resources. Report only the actual result.`});
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){
    const page=(await invokeGetAgentRuntimeEvents({sessionId,limit:1000})).events;
    const event=page.find(row=>row.type==='tool/approval'&&row.data.status==='requested');
    if(event?.type==='tool/approval'&&event.turnId&&event.stepId&&event.data.approvalId){
      const call=page.find(row=>row.type==='tool/call'&&row.data.call.callId===event.data.callId);
      const args=call?.type==='tool/call'?call.data.call.arguments:undefined;
      const values=args&&typeof args==='object'&&!Array.isArray(args)?args as Record<string,unknown>:{};
      const exact=call?.type==='tool/call'&&call.data.call.name==='run_terminal_command'&&values.command===command
        &&values.background!==true&&values.elevated!==true
        &&['readPaths','writePaths','networkTargets','localServices'].every(key=>!values[key]||Array.isArray(values[key])&&values[key].length===0);
      if(!exact){await invokeRejectAgentRuntimeTool({sessionId,turnId:event.turnId,stepId:event.stepId,
        callId:event.data.callId,requestId:event.data.requestId,approvalId:event.data.approvalId});throw new Error('Own command scope mismatch');}
      return {sessionId,command,approvalId:event.data.approvalId,expiresAtUnixMs:event.data.expiresAtUnixMs,
        resources:await invokeGetSandboxAuthorizations(sessionId)};
    }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error('Actual model pending approval missing');
}
