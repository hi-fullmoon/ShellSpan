import { invokeGetAgentRuntimeEvents, invokeApproveAgentRuntimeTool, invokeGetSandboxAuthorizations } from '@/lib/ipc/tauri';

export async function run(sessionId: string): Promise<void> {
  const page = await invokeGetAgentRuntimeEvents({ sessionId, limit: 1000 });
  const request = page.events.find(event => event.type === 'tool/approval' && event.data.status === 'requested');
  if (request?.type !== 'tool/approval' || !request.turnId || !request.stepId || !request.data.approvalId) throw new Error('Actual old approval required');
  let rejected = false;
  try {
    await invokeApproveAgentRuntimeTool({ sessionId, turnId: request.turnId, stepId: request.stepId,
      requestId: request.data.requestId, callId: request.data.callId, approvalId: request.data.approvalId });
  } catch { rejected = true; }
  const authorization = await invokeGetSandboxAuthorizations(sessionId);
  console.info(JSON.stringify({ oldApprovalRejected: rejected, authorization }));
}

export async function beginHour(sessionId: string): Promise<void> {
  const initial = await invokeGetSandboxAuthorizations(sessionId);
  if (initial.state !== 'active' || initial.expiresAtUnixMs === null || initial.readPaths.length !== 1) throw new Error('Actual active session read grant required');
  console.info(JSON.stringify({ hourAuthorizationStart: initial }));
  window.setTimeout(() => {
    void invokeGetSandboxAuthorizations(sessionId).then(final => {
      console.info(JSON.stringify({ hourAuthorizationEnd: final,
        realDeadlineReached: final.checkedAtUnixMs >= initial.expiresAtUnixMs!,
        expired: final.state === 'expired' && final.readPaths.length === 0 }));
    });
  }, Math.max(0, initial.expiresAtUnixMs - Date.now()) + 1500);
}
