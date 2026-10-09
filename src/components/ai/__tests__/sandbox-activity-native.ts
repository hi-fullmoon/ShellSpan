import { invokeCreateAgentRuntimeSession, invokeListAiRoutes, invokeStartAgentRuntime,
  invokeAgentRuntimeFollowup, invokeGetAgentRuntimeSession, invokeGetAgentRuntimeEvents,
  invokeSpawnAgentRuntimeSubagent, invokeListAgentRuntimeSessions, invokePlanAgentRuntimeFleet,
  invokeStartAgentRuntimeFleet, invokeAbortAgentRuntimeFleet, invokeCancelAgentRuntimeChild,
  invokeApproveAgentRuntimeTool, invokeRejectAgentRuntimeTool, invokeBindAgentProjectRoot,
  invokeGetSandboxAuthorizations, invokeSetAgentRuntimeSandboxPolicy,
} from '@/lib/ipc/tauri';
import type { AgentSessionEvent, AgentSessionHeader } from '@/types/agent-session';

const pause = () => new Promise(resolve => setTimeout(resolve, 300));
const events = async (sessionId: string) => (await invokeGetAgentRuntimeEvents({sessionId,limit:1000})).events;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const checks: Record<string, boolean> = {};
const decided = new Set<string>();

async function approveExact(sessionId: string, page: readonly AgentSessionEvent[], command: string): Promise<void> {
  for (const event of page) {
    if (event.type !== 'tool/approval' || event.data.status !== 'requested' || decided.has(event.data.callId)) continue;
    const call = page.find(candidate => candidate.type === 'tool/call' && candidate.data.call.callId === event.data.callId);
    // A subsequent wait_process approval stays pending; cancellation must settle it.
    if (call?.type !== 'tool/call' || call.data.call.name !== 'run_terminal_command') continue;
    if (!event.turnId || !event.stepId || !event.data.approvalId) throw new Error('Scoped actual approval required');
    const input = {sessionId,turnId:event.turnId,stepId:event.stepId,requestId:event.data.requestId,callId:event.data.callId,approvalId:event.data.approvalId};
    const args = record(call.data.call.arguments);
    decided.add(event.data.callId);
    if (args.command !== command || args.background !== true || args.elevated === true
      || ['readPaths','writePaths','networkTargets','localServices'].some(key => Array.isArray(args[key]) && args[key].length > 0)) {
      await invokeRejectAgentRuntimeTool(input); throw new Error('Background command exceeded exact own scope');
    }
    await invokeApproveAgentRuntimeTool(input);
  }
}

async function expectRebindBlocked(parentId: string, root: string): Promise<boolean> {
  try { await invokeBindAgentProjectRoot({sessionId:parentId,root}); return false; }
  catch (cause) { return /Busy|already bound/.test(String(cause)); }
}

async function freshParent(root: string, previous?: AgentSessionHeader): Promise<AgentSessionHeader> {
  const parentId = `activity-parent-${crypto.randomUUID()}`;
  await invokeCreateAgentRuntimeSession({sessionId:parentId,taskId:parentId,goal:'Actual own child/fleet activity, cancellation and binding acceptance',
    ...(previous ? {continuedFromSessionId:previous.sessionId} : {}),
    target:{kind:'local',targetId:'terminal-acceptance-source',sessionId:'acceptance-source',cwd:root},
    sandboxPolicy:'workspace',executionSurface:'direct',permissionMode:'requestApproval'});
  const routes = await invokeListAiRoutes();
  if (!routes.defaultSelection) throw new Error('Real selected route required');
  await invokeStartAgentRuntime({sessionId:parentId,selection:routes.defaultSelection});
  await invokeAgentRuntimeFollowup({sessionId:parentId,messageId:crypto.randomUUID(),content:'Reply ACTIVITY_PARENT_READY without any tools.'});
  const deadline = Date.now() + 75000;
  while (!(await events(parentId)).some(event => event.type === 'turn/end')) {
    if (Date.now() > deadline) throw new Error('Actual parent model deadline elapsed');
    await pause();
  }
  return (await invokeGetAgentRuntimeSession({sessionId:parentId})).header;
}

async function exercise(parent: AgentSessionHeader, fleet: boolean, rebound: string): Promise<AgentSessionHeader> {
  const tag = fleet ? 'fleet' : 'child';
  const command = `printf started > ${tag}-activity-started; sleep 90; printf ended > ${tag}-activity-ended`;
  const goal = `Real owned activity acceptance. Use exactly one run_terminal_command command=${JSON.stringify(command)}, cwd=${JSON.stringify(parent.target?.cwd)}, background=true, with no resources outside the project. Request approval. After the running background process result, request wait_process for that exact process, timeoutMs=60000. Never kill or run another command; the client will cancel while it is active.`;
  let childId: string | undefined;
  let fleetId: string | undefined;
  let starting: Promise<unknown> | undefined;
  let startError: unknown;
  try {
    if (fleet) {
      const planned = await invokePlanAgentRuntimeFleet({parentSessionId:parent.sessionId,targets:[{targetId:parent.target!.targetId,
        goal:`Explorer, Verifier and Reviewer must use no tools; return text only. Operator: ${goal}`}],canarySize:1,waveSize:1,failureThreshold:0});
      fleetId = planned.fleet.fleetId;
      if (!fleetId) throw new Error('Actual fleet identity required');
      starting = invokeStartAgentRuntimeFleet({parentSessionId:parent.sessionId,fleetId}).catch(cause => {startError=cause;});
    } else {
      const child = await invokeSpawnAgentRuntimeSubagent({parentSessionId:parent.sessionId,role:'operator',inheritanceMode:'blank',
        targetIds:[parent.target!.targetId],continuable:true,goal,
        budget:{maxStepsPerTurn:5,maxTurns:2,maxToolCalls:2,maxTokens:24000,timeoutMs:180000}});
      childId = child.header.sessionId;
    }
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (startError) throw startError;
      if (!childId) {
        childId = (await invokeListAgentRuntimeSessions({limit:100})).sessions.find(item => item.header.parentSessionId === parent.sessionId && item.header.subagent?.role === 'operator')?.header.sessionId;
      }
      if (childId) {
        const page = await events(childId);
        await approveExact(childId,page,command);
        const authorization = await invokeGetSandboxAuthorizations(childId);
        if (authorization.activeProcesses > 0 && page.some(event => event.type === 'tool/result' && record(event.data.data).lifecycle === 'running')) {
          const child = await invokeGetAgentRuntimeSession({sessionId:childId});
          checks[`${tag}Inherited`] = child.header.sandboxPolicy === 'workspace' && child.header.permissionMode === 'requestApproval'
            && child.header.target?.cwd === parent.target?.cwd && child.header.executionSurface === 'direct';
          checks[`${tag}ActiveBackground`] = true;
          checks[`${tag}RebindBlocked`] = await expectRebindBlocked(parent.sessionId,rebound);
          try {await invokeSetAgentRuntimeSandboxPolicy({sessionId:parent.sessionId,policy:'readOnly'});checks[`${tag}PolicyBlocked`]=false;}
          catch {checks[`${tag}PolicyBlocked`]=true;}
          if (fleetId) await invokeAbortAgentRuntimeFleet({parentSessionId:parent.sessionId,fleetId});
          else await invokeCancelAgentRuntimeChild({parentSessionId:parent.sessionId,childSessionId:childId});
          checks[`${tag}Cancelled`] = (await invokeGetAgentRuntimeSession({sessionId:childId})).status === 'cancelled';
          checks[`${tag}NoActiveResources`] = (await invokeGetSandboxAuthorizations(childId)).activeProcesses === 0;
          // Existing project roots are immutable. Rebinding creates a new
          // explicitly selected conversation; it never rewrites the old child.
          const reboundHeader = await freshParent(rebound,parent);
          checks[`${tag}ReboundAfterCancel`] = reboundHeader.target?.cwd === rebound
            && (await invokeGetSandboxAuthorizations(reboundHeader.sessionId)).state === 'none'
            && (await invokeGetAgentRuntimeSession({sessionId:parent.sessionId})).header.target?.cwd === parent.target?.cwd;
          if (starting) await starting;
          return reboundHeader;
        }
      }
      await pause();
    }
    throw new Error(`${tag} actual activity deadline elapsed`);
  } finally {
    if (fleetId) await invokeAbortAgentRuntimeFleet({parentSessionId:parent.sessionId,fleetId}).catch(() => undefined);
    else if (childId) await invokeCancelAgentRuntimeChild({parentSessionId:parent.sessionId,childSessionId:childId}).catch(() => undefined);
  }
}

export async function run(root: string): Promise<void> {
  for (const key of Object.keys(checks)) delete checks[key];
  decided.clear();
  let diagnostic: string | undefined;
  try {
    const parent = await freshParent(root);
    checks.parentRealModel = (await events(parent.sessionId)).some(event => event.type === 'request/start');
    const rebound = await exercise(parent,false,`${root}/child-rebind`);
    await exercise(rebound,true,`${root}/fleet-rebind`);
  } catch (cause) { diagnostic=String(cause); }
  console.info(JSON.stringify({activityChecks:checks,diagnostic,passed:Object.keys(checks).length===15&&Object.values(checks).every(Boolean)}));
}
