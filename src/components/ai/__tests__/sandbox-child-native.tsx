import { invoke } from '@tauri-apps/api/core';
import { invokeProbeNativeSandbox, invokeListAiRoutes, invokeStartAgentRuntime,
  invokeAgentRuntimeFollowup, invokeGetAgentRuntimeSession, invokeGetAgentRuntimeEvents,
  invokeSpawnAgentRuntimeSubagent, invokeGetPendingAgentRuntimeApprovalArguments,
  invokeApproveAgentRuntimeTool, invokeRejectAgentRuntimeTool,
} from '@/lib/ipc/tauri';

const parentId = 'orchestration-terminal-parent';
const checks = {parentGenerated:false,childInherited:false,exactApproval:false,nativeResult:false,modelToolsBounded:false};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pause = () => new Promise(resolve => setTimeout(resolve, 400));
const events = (sessionId: string) => invokeGetAgentRuntimeEvents({sessionId,limit:1000});
async function run() {
  await invokeProbeNativeSandbox();
  const routes = await invokeListAiRoutes();
  if (routes.defaultSelection?.modelId !== 'MiniMax-M3') throw new Error('Actual selected model required');
  await invokeStartAgentRuntime({sessionId:parentId,selection:routes.defaultSelection});
  await invokeAgentRuntimeFollowup({sessionId:parentId,messageId:crypto.randomUUID(),content:'Answer PARENT_READY without any tools.'});
  const parentDeadline = Date.now() + 65000;
  while (Date.now() < parentDeadline) {
    const page = await events(parentId);
    if (page.events.some(event => event.type === 'turn/end')) {checks.parentGenerated = page.events.some(event => event.type === 'request/start'); break;}
    await pause();
  }
  const parent = await invokeGetAgentRuntimeSession({sessionId:parentId});
  const target = parent.header.target;
  if (!target?.cwd || !checks.parentGenerated) throw new Error('Actual parent root/model missing');
  const command = 'printf child-stage2 > child-stage2-marker';
  const child = await invokeSpawnAgentRuntimeSubagent({parentSessionId:parentId,role:'operator',inheritanceMode:'blank',targetIds:[target.targetId],continuable:false,
    budget:{maxStepsPerTurn:3,maxTurns:1,maxToolCalls:1,maxTokens:20000,timeoutMs:90000},
    goal:`Use exactly one run_terminal_command with the exact command string ${JSON.stringify(command)}, cwd=${JSON.stringify(target.cwd)}, background=false. Request approval. No other tools or outside paths. Report the actual result.`});
  checks.childInherited = child.header.sandboxPolicy === 'workspace' && child.header.permissionMode === 'requestApproval'
    && child.header.executionSurface === 'direct' && child.header.target?.cwd === target.cwd
    && child.header.capabilityScope?.targetIds.every(id => id === target.targetId) === true;
  const parentPage = await events(parentId);
  const allowed = new Set(parentPage.events.flatMap(event => event.type === 'request/header' ? event.data.toolSchemas.map(tool => tool.name) : []));
  const decided = new Set<string>();
  const deadline = Date.now() + 95000;
  while (Date.now() < deadline) {
    const page = await events(child.header.sessionId);
    for (const event of page.events) {
      if (event.type !== 'tool/approval' || event.data.status !== 'requested' || decided.has(event.data.callId)) continue;
      if (!event.turnId || !event.stepId || !event.data.approvalId) throw new Error('Scoped approval identity missing');
      const input = {sessionId:child.header.sessionId,turnId:event.turnId,stepId:event.stepId,requestId:event.data.requestId,callId:event.data.callId,approvalId:event.data.approvalId};
      const committedCall = page.events.find(candidate => candidate.type === 'tool/call'
        && candidate.data.call.callId === event.data.callId);
      if (committedCall?.type !== 'tool/call' || committedCall.data.call.name !== 'run_terminal_command') throw new Error('Exact committed command missing');
      // The pending endpoint returns only ephemeral arguments; ordinary command
      // arguments are already in the immutable committed call, as in production UI.
      const args = record(await invokeGetPendingAgentRuntimeApprovalArguments(input) ?? committedCall.data.call.arguments);
      const exact = args.command === command && args.background !== true
        && args.elevated !== true && (!args.channel || args.channel === 'direct')
        && (!args.cwd || args.cwd === target.cwd)
        && ['readPaths','writePaths','networkTargets','localServices'].every(key => !args[key] || Array.isArray(args[key]) && args[key].length === 0);
      decided.add(event.data.callId);
      if (!exact) {await invokeRejectAgentRuntimeTool(input); throw new Error('Model command differed from the owned exact approval scope');}
      await invokeApproveAgentRuntimeTool(input);
      checks.exactApproval = true;
    }
    checks.modelToolsBounded = page.events.some(event => event.type === 'request/start')
      && page.events.every(event => event.type !== 'request/header' || event.data.toolSchemas.every(tool => allowed.has(tool.name)));
    checks.nativeResult = page.events.filter(event => event.type === 'tool/call').length === 1 && page.events.some(event => {
      if (event.type !== 'tool/result') return false;
      const data = record(event.data.data); const contract = record(data.sandboxContract);
      return event.data.status === 'completed' && data.sandboxBackend === 'macos-seatbelt'
        && data.exitCode === 0 && data.terminationConfirmed === true && contract.policy === 'workspace'
        && contract.root === target.cwd && record(data.sandboxCapability).status === 'partial';
    });
    if (page.events.some(event => event.type === 'turn/end')) break;
    await pause();
  }
}
try {await run();} catch { /* Keep missing or refused evidence false. */ }
await invoke('sandbox_settings_review_native_result',{checks});
