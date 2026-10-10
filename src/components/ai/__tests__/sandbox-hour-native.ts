import { invoke } from '@tauri-apps/api/core';
import { invokeCreateAgentRuntimeSession, invokeListAiRoutes, invokeStartAgentRuntime,
  invokeAgentRuntimeFollowup, invokeGetAgentRuntimeEvents, invokeApproveAgentRuntimeTool,
  invokeRejectAgentRuntimeTool, invokeGetSandboxAuthorizations } from '@/lib/ipc/tauri';

const sessionId = 'hour-acceptance';
const pause = () => new Promise(resolve => setTimeout(resolve, 300));
const events = async () => (await invokeGetAgentRuntimeEvents({sessionId,limit:1000})).events;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
let command = '';
let ownedFile = '';
let ownedRoot = '';
const decided = new Set<string>();

async function readOnce(scope: 'once'|'session'): Promise<void> {
  const previous = await events();
  const previousSeq = previous[previous.length - 1]?.seq ?? 0;
  await invokeAgentRuntimeFollowup({sessionId,messageId:crypto.randomUUID(),content:
    `Use exactly one run_terminal_command with command=${JSON.stringify(command)}, cwd=${JSON.stringify(ownedRoot)}, background=false, readPaths=[${JSON.stringify(ownedFile)}]. This is an owned non-sensitive external fixture file. Request explicit approval, then report the actual result and end the turn. No other tools or resources; never simulate a result.`});
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const page = (await events()).filter(event => event.seq > previousSeq);
    for (const event of page) {
      if (event.type !== 'tool/approval' || event.data.status !== 'requested' || decided.has(event.data.approvalId ?? '')) continue;
      if (!event.turnId || !event.stepId || !event.data.approvalId) throw new Error('Actual scoped approval required');
      const call = page.find(candidate => candidate.type === 'tool/call' && candidate.data.call.callId === event.data.callId);
      const args = record(call?.type === 'tool/call' ? call.data.call.arguments : null);
      const input = {sessionId,turnId:event.turnId,stepId:event.stepId,callId:event.data.callId,requestId:event.data.requestId,approvalId:event.data.approvalId};
      const exact = call?.type === 'tool/call' && call.data.call.name === 'run_terminal_command' && args.command === command
        && args.background !== true && args.elevated !== true && (!args.cwd || args.cwd === ownedRoot)
        && Array.isArray(args.readPaths) && args.readPaths.length === 1 && args.readPaths[0] === ownedFile
        && ['writePaths','networkTargets','localServices'].every(key => !args[key] || Array.isArray(args[key]) && args[key].length === 0);
      decided.add(event.data.approvalId);
      if (!exact) {await invokeRejectAgentRuntimeTool(input);throw new Error('Read command exceeded the exact new owned scope');}
      await invokeApproveAgentRuntimeTool(input,scope);
    }
    if (page.some(event => event.type === 'turn/end')) {
      const results = page.filter(event => event.type === 'tool/result');
      if (results.length !== 1 || !results.some(event => event.type === 'tool/result'
        && record(event.data.data).stdout === 'stage2-owned-read-input'
        && record(event.data.data).exitCode === 0 && record(event.data.data).terminationConfirmed === true)) {
        throw new Error('Actual owned read terminal result missing');
      }
      return;
    }
    await pause();
  }
  throw new Error('Actual model/read approval deadline elapsed');
}

export async function run(root: string, file: string): Promise<void> {
  if (!/^\/[A-Za-z0-9/_.-]+$/.test(file) || !file.includes('/shellspan-stage2-owned-read-') || !file.endsWith('/read-input.txt')) throw new Error('Exact new own ordinary file required');
  ownedRoot=root;ownedFile=file;command=`cat ${file}`;
  await invokeCreateAgentRuntimeSession({sessionId,taskId:sessionId,goal:'Actual original Runtime one-hour read authorization expiry',
    target:{kind:'local',targetId:'terminal-acceptance-source',sessionId:'acceptance-source',cwd:root},sandboxPolicy:'workspace',executionSurface:'direct',permissionMode:'requestApproval'});
  const routes=await invokeListAiRoutes();
  if (!routes.defaultSelection || routes.defaultSelection.modelId!=='MiniMax-M3') throw new Error('Actual selected MiniMax-M3 required');
  await invokeStartAgentRuntime({sessionId,selection:routes.defaultSelection});
  await readOnce('session');
  const initial=record(await invoke('sandbox_settings_review_observe_hour'));
  const authorization=record(initial.authorization);
  const expires=authorization.expiresAtUnixMs;
  if(typeof expires!=='number') throw new Error('Actual original deadline missing');
  console.info(JSON.stringify({hourInitial:initial}));
  // The backend observer survives page reloads and records expiry independently.
  while(Date.now()<expires+1500) await new Promise(resolve=>setTimeout(resolve,1000));
  const expired=await invokeGetSandboxAuthorizations(sessionId);
  if(expired.state!=='expired'||expired.readPaths.length!==0) throw new Error('Actual original grant did not expire');
  await readOnce('once');
  console.info(JSON.stringify({hourFinal:await invoke('sandbox_settings_review_finish_hour')}));
}

export async function finish(root:string,file:string):Promise<void>{
  ownedRoot=root;ownedFile=file;command=`cat ${file}`;
  const expired=await invokeGetSandboxAuthorizations(sessionId);
  if(expired.state!=='expired'||expired.readPaths.length!==0)throw new Error('Original live expired grant required; restart cannot substitute');
  await readOnce('once');
  console.info(JSON.stringify({hourFinal:await invoke('sandbox_settings_review_finish_hour')}));
}
