import { invoke } from '@tauri-apps/api/core';
import {
  invokeProbeNativeSandbox, invokeListAiRoutes, invokeStartAgentRuntime, invokeAgentRuntimeFollowup,
  invokeGetAgentRuntimeSession, invokeGetAgentRuntimeEvents, invokeSpawnAgentRuntimeSubagent,
  invokeSendAgentRuntimeChildInput, invokePlanAgentRuntimeFleet as invokeFleetPlan,
  invokeStartAgentRuntimeFleet as invokeFleetStart, invokeAbortAgentRuntimeFleet as invokeFleetAbort,
  invokeListAgentRuntimeSessions,
} from '@/lib/ipc/tauri';
import type { AgentSessionHeader, AgentSessionSnapshot } from '@/types/agent-session';

const narrowParentId = 'orchestration-parent';
const parentId = 'orchestration-terminal-parent';
const checks = { parentGenerated:false, explicitNarrowRoleRejected:false, childGenerated:false, childInherited:false, childNoTools:false,
  outsideTargetRejected:false, oneShotContinuationRejected:false, fleetStarted:false,
  fleetChildrenInherited:false, fleetCompleted:false, fleetNoTools:false };
const pause = () => new Promise(resolve => setTimeout(resolve, 500));
const events = (sessionId: string) => invokeGetAgentRuntimeEvents({sessionId,limit:1000});
async function settled(sessionId: string) {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const [snapshot, page] = await Promise.all([invokeGetAgentRuntimeSession({sessionId}),events(sessionId)]);
    if (page.events.some(event => event.type === 'turn/end') && snapshot.status !== 'running' && snapshot.status !== 'waiting') return {snapshot,page};
    await pause();
  }
  throw new Error('Actual model settlement was not observed within the finite window');
}
function inherited(child: AgentSessionHeader, parent: AgentSessionHeader) {
  const allowed = parent.capabilityScope;
  return child.sandboxPolicy === parent.sandboxPolicy && child.permissionMode === parent.permissionMode
    && child.executionSurface === parent.executionSurface && child.target?.targetId === parent.target?.targetId
    && child.target?.cwd === parent.target?.cwd && Boolean(child.capabilityScope
      && child.capabilityScope.targetIds.every(id => id === parent.target?.targetId)
      && (!allowed || child.capabilityScope.toolNames.every(name => allowed.toolNames.includes(name))
        && child.capabilityScope.effects.every(effect => allowed.effects.includes(effect))));
}
async function run() {
  await invokeProbeNativeSandbox();
  const routes = await invokeListAiRoutes();
  if (!routes.defaultSelection || routes.defaultSelection.modelId !== 'MiniMax-M3') throw new Error('Current actual model required');
  await invokeStartAgentRuntime({sessionId:narrowParentId,selection:routes.defaultSelection});
  await invokeAgentRuntimeFollowup({sessionId:narrowParentId,messageId:crypto.randomUUID(),content:'Answer only NARROW_SCOPE_READY. Do not call any tools.'});
  await settled(narrowParentId);
  try { await invokeSpawnAgentRuntimeSubagent({parentSessionId:narrowParentId,goal:'No tools.',role:'explorer',inheritanceMode:'blank',targetIds:['terminal-acceptance-source'],continuable:false}); }
  catch (error) { checks.explicitNarrowRoleRejected = String(error).includes('role allowlist has no intersection with the parent capability'); }
  await invokeStartAgentRuntime({sessionId:parentId,selection:routes.defaultSelection});
  await invokeAgentRuntimeFollowup({sessionId:parentId,messageId:crypto.randomUUID(),content:'Answer only PARENT_SCOPE_READY. Do not call any tools or access files.'});
  const parent = await settled(parentId);
  checks.parentGenerated = parent.snapshot.status === 'idle' && parent.page.events.some(event => event.type === 'request/start') && parent.page.events.some(event => event.type === 'assistant/message');
  const targetId = parent.snapshot.header.target?.targetId;
  if (!targetId) throw new Error('Actual parent target missing');
  const child = await invokeSpawnAgentRuntimeSubagent({parentSessionId:parentId,goal:'Without tools or file access, answer only EXPLORER_SCOPE_OK.',role:'explorer',inheritanceMode:'blank',targetIds:[targetId],budget:{maxStepsPerTurn:2,maxTurns:1,maxToolCalls:1,maxTokens:20000,timeoutMs:60000},continuable:false});
  const childDone = await settled(child.header.sessionId);
  checks.childGenerated = ['idle','completed'].includes(childDone.snapshot.status) && childDone.page.events.some(event => event.type === 'request/start') && childDone.page.events.some(event => event.type === 'assistant/message');
  checks.childInherited = inherited(childDone.snapshot.header,parent.snapshot.header);
  checks.childNoTools = !childDone.page.events.some(event => event.type === 'tool/call');
  try { await invokeSpawnAgentRuntimeSubagent({parentSessionId:parentId,goal:'No tool use.',role:'explorer',inheritanceMode:'blank',targetIds:[crypto.randomUUID()],continuable:false}); }
  catch { checks.outsideTargetRejected = true; }
  try { await invokeSendAgentRuntimeChildInput({parentSessionId:parentId,childSessionId:child.header.sessionId,content:'Must not resume this one-shot child.'}); }
  catch { checks.oneShotContinuationRejected = true; }
  const fleet = await invokeFleetPlan({parentSessionId:parentId,targets:[{targetId,goal:'Answer only FLEET_SCOPE_OK. No tools, files, commands or further delegation.'}],canarySize:1,waveSize:1,failureThreshold:0});
  const fleetId = fleet.fleet.fleetId;
  if (!fleetId) throw new Error('Actual fleet identifier missing');
  const started = await invokeFleetStart({parentSessionId:parentId,fleetId});
  checks.fleetStarted = started.fleet.fleetId === fleetId;
  const deadline = Date.now() + 90_000;
  let final: AgentSessionSnapshot | undefined;
  while (Date.now() < deadline) {
    final = await invokeGetAgentRuntimeSession({sessionId:parentId});
    if (['completed','failed','aborted'].includes(final.task.fleet?.status ?? '')) break;
    await pause();
  }
  checks.fleetCompleted = final?.task.fleet?.status === 'completed';
  if (!checks.fleetCompleted) await invokeFleetAbort({parentSessionId:parentId,fleetId});
  const list = await invokeListAgentRuntimeSessions({limit:100});
  const children = list.sessions.filter(item => item.header.subagent?.parentTaskId === parent.snapshot.header.taskId && item.header.sessionId !== child.header.sessionId);
  checks.fleetChildrenInherited = children.length >= 3 && children.every(item => inherited(item.header,parent.snapshot.header));
  const childEvents = await Promise.all(children.map(item => events(item.header.sessionId)));
  const allowedNames = new Set(parent.page.events.flatMap(event => event.type === 'request/header' ? event.data.toolSchemas.map(tool => tool.name) : []));
  checks.fleetNoTools = childEvents.length >= 3 && childEvents.every(page => page.events.some(event => event.type === 'request/start') && !page.events.some(event => event.type === 'tool/call') && page.events.every(event => event.type !== 'request/header' || event.data.toolSchemas.every(tool => allowedNames.has(tool.name))))
    && childDone.page.events.every(event => event.type !== 'request/header' || event.data.toolSchemas.every(tool => allowedNames.has(tool.name)));
}
try { await run(); } catch { /* The report keeps failed/unobserved checks false. */ }
await invoke('sandbox_settings_review_orchestration_result', {checks});
