import { invoke } from '@tauri-apps/api/core';
import { invokeProbeNativeSandbox, invokeListAiRoutes, invokeStartAgentRuntime,
  invokeAgentRuntimeFollowup, invokeGetAgentRuntimeSession, invokeGetAgentRuntimeEvents,
  invokeListAgentRuntimeSessions, invokePlanAgentRuntimeFleet, invokeStartAgentRuntimeFleet,
  invokeAbortAgentRuntimeFleet, invokeGetPendingAgentRuntimeApprovalArguments,
  invokeApproveAgentRuntimeTool, invokeRejectAgentRuntimeTool,
} from '@/lib/ipc/tauri';
import type { AgentSessionHeader } from '@/types/agent-session';

const parentId = 'orchestration-terminal-parent';
const checks = {parentGenerated:false,fleetStarted:false,childrenInherited:false,operatorNativeResult:false,
  fleetCompleted:false,approvalsExact:false,modelToolsBounded:false};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pause = () => new Promise(resolve => setTimeout(resolve, 500));
const events = (sessionId: string) => invokeGetAgentRuntimeEvents({sessionId,limit:1000});
let fleetId: string | undefined;
let phase = 'initialization';
let diagnostic: string | undefined;
function inherited(child: AgentSessionHeader, parent: AgentSessionHeader) {
  return child.sandboxPolicy === parent.sandboxPolicy && child.permissionMode === parent.permissionMode
    && child.executionSurface === parent.executionSurface && child.target?.targetId === parent.target?.targetId
    && child.target?.cwd === parent.target?.cwd && child.capabilityScope?.targetIds.every(id => id === parent.target?.targetId) === true;
}
async function run() {
  await invokeProbeNativeSandbox();
  const routes = await invokeListAiRoutes();
  if (routes.defaultSelection?.modelId !== 'MiniMax-M3') throw new Error('Actual selected model required');
  await invokeStartAgentRuntime({sessionId:parentId,selection:routes.defaultSelection});
  await invokeAgentRuntimeFollowup({sessionId:parentId,messageId:crypto.randomUUID(),content:'Answer PARENT_READY without tools.'});
  const parentDeadline = Date.now() + 70000;
  while (Date.now() < parentDeadline) {
    const page = await events(parentId);
    if (page.events.some(event => event.type === 'turn/end')) {
      checks.parentGenerated = page.events.some(event => event.type === 'request/start') && !page.events.some(event => event.type === 'tool/call'); break;
    }
    await pause();
  }
  const parent = await invokeGetAgentRuntimeSession({sessionId:parentId});
  const target = parent.header.target;
  if (!checks.parentGenerated || !target?.cwd) throw new Error('Actual parent root/model missing');
  const parentPage = await events(parentId);
  const allowed = new Set(parentPage.events.flatMap(event => event.type === 'request/header' ? event.data.toolSchemas.map(tool => tool.name) : []));
  const command = 'printf fleet-stage2 > fleet-stage2-marker';
  const planned = await invokePlanAgentRuntimeFleet({parentSessionId:parentId,targets:[{targetId:target.targetId,
    goal:`Owned native acceptance. Explorer, Verifier and Reviewer must not use tools; provide text only. Operator must use exactly one foreground run_terminal_command with command=${JSON.stringify(command)}, cwd=${JSON.stringify(target.cwd)}, background=false; request approval, then report actual result. No other tools, paths, resources, networks or delegation.`}],canarySize:1,waveSize:1,failureThreshold:0});
  fleetId = planned.fleet.fleetId;
  if (!fleetId) throw new Error('Actual fleet ID required');
  let startError: unknown;
  const starting = invokeStartAgentRuntimeFleet({parentSessionId:parentId,fleetId}).catch(error => {
    startError = error; return null;
  });
  const decided = new Set<string>();
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (startError !== undefined) throw startError;
    phase = 'list fleet children';
    const list = await invokeListAgentRuntimeSessions({limit:100});
    const children = list.sessions.filter(item => item.header.subagent?.parentTaskId === parent.header.taskId);
    phase = 'read fleet child events';
    const pages = await Promise.all(children.map(item => events(item.header.sessionId)));
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!; const page = pages[index]!;
      for (const event of page.events) {
        if (event.type !== 'tool/approval' || event.data.status !== 'requested') continue;
        const key = `${child.header.sessionId}:${event.data.callId}`;
        if (decided.has(key)) continue;
        if (!event.turnId || !event.stepId || !event.data.approvalId) throw new Error('Actual scoped approval missing');
        const input = {sessionId:child.header.sessionId,turnId:event.turnId,stepId:event.stepId,requestId:event.data.requestId,callId:event.data.callId,approvalId:event.data.approvalId};
        const call = page.events.find(candidate => candidate.type === 'tool/call' && candidate.data.call.callId === event.data.callId);
        phase = 'read exact pending Operator arguments';
        const args = record(await invokeGetPendingAgentRuntimeApprovalArguments(input) ?? (call?.type === 'tool/call' ? call.data.call.arguments : null));
        const exact = child.header.subagent?.role === 'operator' && call?.type === 'tool/call' && call.data.call.name === 'run_terminal_command'
          && args.command === command && args.background !== true && args.elevated !== true
          && (!args.cwd || args.cwd === target.cwd) && (!args.channel || args.channel === 'direct')
          && ['readPaths','writePaths','networkTargets','localServices'].every(name => !args[name] || Array.isArray(args[name]) && args[name].length === 0);
        decided.add(key);
        if (!exact) {await invokeRejectAgentRuntimeTool(input); throw new Error('Fleet command exceeded the exact owned approval scope');}
        phase = 'approve exact Operator command';
        await invokeApproveAgentRuntimeTool(input);
        checks.approvalsExact = decided.size === 1;
      }
    }
    checks.childrenInherited = children.length === 4 && children.every(item => inherited(item.header,parent.header));
    checks.modelToolsBounded = children.length === 4 && pages.every((page,index) => page.events.some(event => event.type === 'request/start')
      && page.events.every(event => event.type !== 'request/header' || event.data.toolSchemas.every(tool => allowed.has(tool.name)))
      && (children[index]!.header.subagent?.role === 'operator' || !page.events.some(event => event.type === 'tool/call')));
    checks.operatorNativeResult = pages.some((page,index) => children[index]!.header.subagent?.role === 'operator'
      && page.events.filter(event => event.type === 'tool/call').length === 1 && page.events.some(event => {
        if (event.type !== 'tool/result') return false;
        const data = record(event.data.data); const contract = record(data.sandboxContract);
        return event.data.status === 'completed' && data.sandboxBackend === 'macos-seatbelt' && data.exitCode === 0
          && data.terminationConfirmed === true && contract.root === target.cwd && contract.policy === 'workspace'
          && record(data.sandboxCapability).status === 'partial';
      }));
    const current = await invokeGetAgentRuntimeSession({sessionId:parentId});
    if (['completed','failed','aborted'].includes(current.task.fleet?.status ?? '')) {
      checks.fleetCompleted = current.task.fleet?.status === 'completed'; break;
    }
    await pause();
  }
  if (!checks.fleetCompleted) await invokeAbortAgentRuntimeFleet({parentSessionId:parentId,fleetId});
  const started = await starting;
  if (!started) throw startError ?? new Error('Fleet start result missing');
  checks.fleetStarted = started.fleet.fleetId === fleetId;
}
try {await run();} catch (error) { diagnostic = `${phase}: ${String(error)}`; }
if (fleetId && !checks.fleetCompleted) {
  try {await invokeAbortAgentRuntimeFleet({parentSessionId:parentId,fleetId});}
  catch { /* The failed scope report and production AppExit cleanup remain required. */ }
}
await invoke('sandbox_settings_review_native_result',{checks,diagnostic});
