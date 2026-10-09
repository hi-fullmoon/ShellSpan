import { invokeGetAgentRuntimeEvents, invokeApproveAgentRuntimeTool, invokeGetSandboxAuthorizations } from '@/lib/ipc/tauri';

export async function run(sessionId: string): Promise<void> {
  const page = await invokeGetAgentRuntimeEvents({ sessionId, limit: 1000 });
  const request = [...page.events].reverse().find(event => event.type === 'tool/approval' && event.data.status === 'requested'
    && page.events.some(candidate => candidate.type === 'tool/approval' && candidate.data.status === 'approved'
      && candidate.data.requestId === event.data.requestId && candidate.data.approvalId === event.data.approvalId));
  if (request?.type !== 'tool/approval' || !request.turnId || !request.stepId || !request.data.approvalId) throw new Error('Actual old approval required');
  let rejected = false;
  let rejectedWithoutResidentDriver = false;
  try {
    await invokeApproveAgentRuntimeTool({ sessionId, turnId: request.turnId, stepId: request.stepId,
      requestId: request.data.requestId, callId: request.data.callId, approvalId: request.data.approvalId });
  } catch (cause) { rejected = true; rejectedWithoutResidentDriver = String(cause).includes('Agent Session is not started'); }
  const authorization = await invokeGetSandboxAuthorizations(sessionId);
  console.info(JSON.stringify({ oldApprovalRejected: rejected, authorization,
    rejectedWithoutResidentDriver,
    checkedBeforeOriginalApprovalExpiry: typeof request.data.expiresAtUnixMs === 'number' && Date.now() < request.data.expiresAtUnixMs }));
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
