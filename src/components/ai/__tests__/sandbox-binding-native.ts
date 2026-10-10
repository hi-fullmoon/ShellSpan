import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '@/stores/terminalStore';
import { invokeSandboxSettingsReviewSource, invokeCreateAgentRuntimeSession, invokeListAiRoutes,
  invokeStartAgentRuntime, invokeAgentRuntimeFollowup, invokeGetAgentRuntimeEvents,
  invokeApproveAgentRuntimeTool, invokeRejectAgentRuntimeTool, invokeVerifyRemoteSandboxTarget,
  invokeGetSandboxAuthorizations, invokeRevokeSandboxReads, invokeBindAgentProjectRoot,
  invokeSetAgentRuntimeSandboxPolicy } from '@/lib/ipc/tauri';
import type { AgentSessionTarget } from '@/types/agent-session';

let sessionId = '';
let decision: Parameters<typeof invokeApproveAgentRuntimeTool>[0] | undefined;
let target: Parameters<typeof invokeVerifyRemoteSandboxTarget>[0] | undefined;
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
const events = async () => (await invokeGetAgentRuntimeEvents({sessionId,limit:1000})).events;

export async function pending(root: string, fresh = false, background = false): Promise<unknown> {
  sessionId=background ? 'binding-activity' : `binding-${crypto.randomUUID()}`;
  const source = await invokeSandboxSettingsReviewSource();
  const command = background ? 'printf started > binding-background-started; sleep 90; printf ended > binding-background-ended'
    : fresh ? 'printf fresh > binding-fresh' : 'printf binding > binding-approved';
  target={kind:'remote',targetId:`terminal-${source.sessionId}`,sessionId:source.sessionId,profileId:source.profileId,
    host:source.host,port:source.port,username:source.username,rootPath:root};
  await invokeCreateAgentRuntimeSession({sessionId,taskId:sessionId,goal:'Real SSH source-generation approval acceptance',
    target,
    sandboxPolicy:'workspace',executionSurface:'direct',permissionMode:'requestApproval'});
  const routes = await invokeListAiRoutes();
  if (!routes.defaultSelection) throw new Error('Existing real model selection required');
  await invokeStartAgentRuntime({sessionId,selection:routes.defaultSelection});
  await invokeAgentRuntimeFollowup({sessionId,messageId:crypto.randomUUID(),content:
    `Use exactly one run_terminal_command command=${JSON.stringify(command)}, background=${background}. The frozen project already supplies cwd=${JSON.stringify(root)}. Do not add cd, quote differently or change the command. Request approval. Use no other tools or outside resources; report the actual result and end the turn. Do not wait or kill the background job; the client will revoke it.`});
  const deadline = Date.now()+90000;
  while (Date.now()<deadline) {
    const page = await events();
    const approval = page.find(event=>event.type==='tool/approval' && event.data.status==='requested');
    if (approval?.type==='tool/approval' && approval.turnId && approval.stepId && approval.data.approvalId) {
      decision = {sessionId,turnId:approval.turnId,stepId:approval.stepId,callId:approval.data.callId,
        requestId:approval.data.requestId,approvalId:approval.data.approvalId};
      const call=page.find(event=>event.type==='tool/call' && event.data.call.callId===approval.data.callId);
      const args=call?.type==='tool/call' ? call.data.call.arguments : undefined;
      if (!args || typeof args!=='object' || Array.isArray(args)) throw new Error('Actual tool arguments missing');
      const values=args as Record<string,unknown>;
      if (call?.type!=='tool/call' || call.data.call.name!=='run_terminal_command' || values.command!==command
        || (values.background===true)!==background || values.elevated===true || values.cwd && values.cwd!==root
        || ['readPaths','writePaths','networkTargets','localServices'].some(key=>Array.isArray(values[key]) && values[key].length>0)) {
        await invokeRejectAgentRuntimeTool(decision); throw new Error('Requested command exceeded own scope');
      }
      return {sessionId,approvalId:decision.approvalId,command,root};
    }
    await pause();
  }
  throw new Error('Actual model approval deadline elapsed');
}

export async function reconnect(): Promise<unknown> {
  const disconnected=await invoke('sandbox_settings_review_connection',{reconnect:false});
  if (!target) throw new Error('Original owned target required');
  useTerminalStore.getState().setStatus(target.sessionId,{sessionId:target.sessionId,status:'disconnected'});
  await pause();
  const connected=await invoke('sandbox_settings_review_connection',{reconnect:true});
  const source=await invokeSandboxSettingsReviewSource();
  useTerminalStore.getState().reconnectSession(target.sessionId,source,source.profileId);
  useTerminalStore.getState().setStatus(source.sessionId,{sessionId:source.sessionId,status:source.status});
  await pause();
  const verified=await invokeVerifyRemoteSandboxTarget(target,'workspace');
  const routes=await invokeListAiRoutes();
  if (!routes.defaultSelection) throw new Error('Existing real model selection required');
  await invokeStartAgentRuntime({sessionId,selection:routes.defaultSelection});
  return {disconnected,connected,verified};
}

export async function decideOld(): Promise<unknown> {
  if (!decision) throw new Error('Original exact approval required');
  let error: string | undefined;
  try { await invokeApproveAgentRuntimeTool(decision); } catch(cause) { error=String(cause); }
  await pause();
  const page=await events();
  return {sessionId,error,approvals:page.filter(event=>event.type==='tool/approval'),
    executions:page.filter(event=>event.type==='tool/execution'),results:page.filter(event=>event.type==='tool/result')};
}

export async function approveFresh(): Promise<unknown> {
  if (!decision) throw new Error('Exact fresh own approval required');
  await invokeApproveAgentRuntimeTool(decision);
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    const results=(await events()).filter(event=>event.type==='tool/result');
    if(results.some(event=>event.type==='tool/result' && event.data.status==='completed'))return {sessionId,results};
    await pause();
  }
  throw new Error('Fresh real native terminal missing');
}

export async function activity(root: string): Promise<unknown> {
  const newTarget=await invoke<AgentSessionTarget>('sandbox_settings_review_new_project');
  if(!newTarget.rootPath)throw new Error('Actual new owned project required');
  await pending(root,false,true);
  if(!decision)throw new Error('Actual background approval missing');
  await invokeApproveAgentRuntimeTool(decision);
  const startDeadline=Date.now()+30000;
  let started=false;
  while(Date.now()<startDeadline){
    try { started=await invoke<string>('sandbox_settings_review_activity_started')==='started'; } catch { /* The exact owned effect is not present yet. */ }
    if(started)break;
    await pause();
  }
  if(!started){await invokeRevokeSandboxReads(sessionId);throw new Error('Actual SSH startup effect missing');}
  const active=await invokeGetSandboxAuthorizations(sessionId);
  if(active.activeProcesses!==1)throw new Error('Exactly one actual background process required');
  let bindingError='';let policyError='';
  try{await invokeBindAgentProjectRoot({sessionId,root:newTarget.rootPath});}catch(cause){bindingError=String(cause);}
  try{await invokeSetAgentRuntimeSandboxPolicy({sessionId,policy:'readOnly'});}catch(cause){policyError=String(cause);}
  if(!/Busy|already bound/.test(bindingError)||!policyError.includes('BUSY'))throw new Error('Activity mutation gates did not reject');
  const connection=await reconnect();
  const beforeCleanup=await invokeGetSandboxAuthorizations(sessionId);
  const process=await invoke<Record<string,unknown>>('sandbox_settings_review_activity_process');
  if(beforeCleanup.activeProcesses===0 && process.terminationConfirmed!==true)
    throw new Error('Reconnect cannot declare cleanup without the actual process terminal receipt');
  await invokeRevokeSandboxReads(sessionId);
  const stopped=await invokeGetSandboxAuthorizations(sessionId);
  if(stopped.activeProcesses!==0||stopped.state!=='none')throw new Error('Actual confirmed cancellation required');
  return {sessionId,newRoot:newTarget.rootPath,bindingError,policyError,connection,active,beforeCleanup,process,stopped};
}
