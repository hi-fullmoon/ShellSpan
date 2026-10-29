import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import TerminalWorkspace from '../index';
import { terminalRegistry } from '../registry/terminal-registry';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { AppShell, MainContent } from '@/components/layout/app-shell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { redactTerminalSecrets } from '@/lib/terminal/terminal-output-buffer';
import {
  invokeCreateLocalSession, invokeCloseSession, invokeListAiRoutes,
  invokeCreateAgentRuntimeSession, invokeStartAgentRuntime, invokeAgentRuntimeFollowup,
  invokeGetAgentRuntimeSession, invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession,
  invokeDeleteAgentRuntimeSession, invokeGetAgentTerminalOwner, invokeGetTerminalBrokerSnapshot,
  listenToAgentRuntimeSession, listenToAgentTerminalLease,
} from '@/lib/ipc/tauri';
import type { AgentSessionEvent, AgentTerminalLeaseEvent } from '@/types/agent-session';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (!await check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

// Uses the real desktop, configured provider, native Session lineage and PTY.
// No transport, model response, lease acknowledgement or session event is replaced.
export async function verifyTerminalDelegation(): Promise<void> {
  const selection = (await invokeListAiRoutes()).defaultSelection;
  assert(selection, 'Configure a real model route before running terminal delegation acceptance');
  await getCurrentWindow().show();
  await getCurrentWindow().setFocus();
  const host = document.getElementById('root');
  assert(host, 'Missing native application host');
  const root = createRoot(host);
  const parentId = `agent-delegation-${crypto.randomUUID()}`;
  const unrelatedId = `agent-delegation-${crypto.randomUUID()}`;
  const childIds = new Set<string>();
  const created: string[] = [];
  const events: AgentSessionEvent[] = [];
  const leases: AgentTerminalLeaseEvent[] = [];
  const cleanups: (() => void)[] = [];
  const terminalResults = new Set<string>();
  const ended = new Set<string>();
  const childMarker = `delegation-child-${crypto.randomUUID()}`;
  const parentMarker = `delegation-parent-${crypto.randomUUID()}`;
  const draftEditor = document.body.appendChild(document.createElement('textarea'));
  draftEditor.value = `Retain this draft while a child uses the terminal: ${crypto.randomUUID()}`;
  const retainedDraft = draftEditor.value;
  let terminalId: string | undefined;
  let otherTerminalId: string | undefined;
  let output = '';
  let failure: string | undefined;
  let restoredParent = false;
  let takingOver = false;
  try {
    useAppStore.setState({ activeSection: 'terminal', restoreWorkspace: false });
    flushSync(() => root.render(<TooltipProvider><AppShell><MainContent>
      <TerminalWorkspace />
    </MainContent></AppShell></TooltipProvider>));
    const terminal = await invokeCreateLocalSession(100, 25);
    terminalId = terminal.sessionId;
    flushSync(() => useTerminalStore.getState().addSession(terminal));
    await eventually(() => useTerminalStore.getState().sessions.some(session =>
      session.sessionId === terminalId && session.status === 'connected' && session.promptReady),
    'The native terminal did not connect and reach its prompt');
    const controller = terminalRegistry.get(terminalId);
    assert(controller, 'Missing production terminal controller');
    const otherTerminal = await invokeCreateLocalSession(100, 25);
    otherTerminalId = otherTerminal.sessionId;
    flushSync(() => useTerminalStore.getState().addSession(otherTerminal));
    cleanups.push(controller.subscribeOutput(chunk => { output += chunk; }));
    cleanups.push(agentTerminalLeaseState.subscribe(() => {
      const view = agentTerminalLeaseState.get(terminalId!);
      if ([...childIds].some(id => terminalResults.has(id)) && !ended.has(parentId)
        && !leases.some(lease => lease.agentSessionId === parentId && lease.state === 'acquired')
        && view?.agentSessionId === parentId) restoredParent = true;
    }));
    cleanups.push(await listenToAgentTerminalLease(({ payload }) => {
      if (payload.sessionId === terminalId) leases.push(payload);
    }));
    cleanups.push(await listenToAgentRuntimeSession(({ payload }) => {
      if (payload.type === 'subagent/descriptor' && payload.sessionId === parentId) {
        childIds.add(payload.data.childSessionId);
      }
      if (payload.sessionId !== parentId && !childIds.has(payload.sessionId)) return;
      if (['turn/start', 'turn/end', 'tool/call', 'tool/result', 'subagent/descriptor'].includes(payload.type)) events.push(payload);
      if (payload.type === 'turn/start') ended.delete(payload.sessionId);
      if (payload.type === 'turn/end') ended.add(payload.sessionId);
      if (payload.type === 'request/failure') failure = `Model request failed: ${payload.data.failure.kind}: ${redactTerminalSecrets(payload.data.failure.message)}`;
      if (payload.type === 'tool/result') {
        if (payload.data.status !== 'completed' && !takingOver) failure = payload.data.summary;
        if (payload.data.name === 'run_terminal_command' && payload.data.status === 'completed') terminalResults.add(payload.sessionId);
      }
    }));
    const target = { kind: 'local', targetId: `terminal-${terminalId}`, sessionId: terminalId } as const;
    for (const id of [parentId, unrelatedId]) {
      await invokeCreateAgentRuntimeSession({
        sessionId: id, taskId: id, goal: 'Verify native parent/child terminal delegation',
        target, permissionMode: 'operator', executionSurface: 'boundTerminal',
        capabilityScope: { toolNames: ['spawn_one_shot_agent', 'run_terminal_command'],
          effects: ['none', 'readOnly', 'stateChange'], targetIds: [target.targetId] },
      });
      created.push(id);
      await invokeStartAgentRuntime({ sessionId: id, selection });
    }
    const shell = (await invokeGetTerminalBrokerSnapshot(terminalId)).session?.integrationShell;
    const powershell = shell === 'windowsPowerShell' || shell === 'powerShell7';
    const printCommand = (marker: string, delay: number): string => powershell
      ? `Start-Sleep -Seconds ${delay}; [Console]::WriteLine('${marker.slice(0, 16)}'+'${marker.slice(16)}')`
      : `sleep ${delay}; printf '%s%s\\n' '${marker.slice(0, 16)}' '${marker.slice(16)}'`;
    const childGoal = `Run run_terminal_command exactly once with this exact command, then reply done. Do not use other tools or change execution surface.\n${printCommand(childMarker, 3)}`;
    const content = `Call spawn_one_shot_agent exactly once with these exact arguments: ${JSON.stringify({
      goal: childGoal, role: 'general', inheritanceMode: 'blank', targetIds: [target.targetId], requiredTools: ['run_terminal_command'],
    })}\nAfter it returns, call run_terminal_command exactly once with this exact command, then reply done. Do not retry failed tools or create other children.\n${printCommand(parentMarker, 1)}`;
    await invokeAgentRuntimeFollowup({ sessionId: parentId, messageId: crypto.randomUUID(), content });
    await eventually(() => agentTerminalLeaseState.get(terminalId!)?.agentSessionId === parentId,
      'The parent did not establish its turn input lock before delegation');
    assert(!leases.some(lease => childIds.has(lease.agentSessionId) && lease.state === 'acquired'),
      'The user must switch views before the first delegated command');
    flushSync(() => {
      useTerminalStore.getState().setActiveSession(otherTerminal.sessionId);
      useAppStore.getState().setActiveSection('workbench');
    });
    draftEditor.focus();
    const assertRetainedView = (): void => {
      assert(useAppStore.getState().activeSection === 'workbench', 'Delegation must preserve the selected page');
      assert(useTerminalStore.getState().activeSessionId === otherTerminal.sessionId,
        'Delegation must preserve the selected unrelated terminal');
      assert(document.activeElement === draftEditor, 'Delegation must preserve user input focus');
      assert(draftEditor.value === retainedDraft,
        `Delegation must preserve the current draft (expected ${retainedDraft.length} characters, got ${draftEditor.value.length})`);
    };
    await eventually(() => {
      assert(!failure, failure ?? 'Delegation failed');
      return leases.some(lease => childIds.has(lease.agentSessionId) && lease.state === 'activity' && lease.commandPhase === 'running');
    }, 'The child never ran a command through the real bound terminal');
    assertRetainedView();
    assert(await controller.writeUserInput('must remain blocked') === false, 'Child command must retain the parent input lock');
    let conflict = false;
    try {
      await invokeAgentRuntimeFollowup({ sessionId: unrelatedId, messageId: crypto.randomUUID(), content: 'Reply done.' });
    } catch (error) { conflict = String(error).includes('TERMINAL_AGENT_CONFLICT'); }
    assert(conflict, 'An unrelated Agent must remain excluded while the child uses the terminal');
    await eventually(async () => {
      assert(!failure, failure ?? 'Delegation failed');
      return ended.has(parentId) && output.includes(childMarker) && output.includes(parentMarker)
        && await invokeGetAgentTerminalOwner(terminalId!) === null;
    }, 'The parent did not resume and release the delegated terminal');
    assertRetainedView();
    assert(childIds.size === 1 && [...childIds].every(id => terminalResults.has(id)), 'A real child must complete its command');
    assert(terminalResults.has(parentId), 'The parent must execute its command after the child settles');
    assert(restoredParent, 'The continuing parent view must be restored after its child ends');
    await eventually(() => agentTerminalLeaseState.get(terminalId!) === undefined, 'The completed turn retained terminal ownership');
    const userMarker = `delegation-user-${crypto.randomUUID()}`;
    assert(await controller.writeUserInput(`${printCommand(userMarker, 0)}\r`) === true,
      'Finishing the parent must release frontend input suppression');
    await eventually(() => output.includes(userMarker)
      && useTerminalStore.getState().sessions.some(session => session.sessionId === terminalId && session.promptReady),
    'Real user input did not execute after the parent finished');

    // The separate takeover scenario starts from its original visible-terminal context.
    flushSync(() => {
      useTerminalStore.getState().setActiveSession(terminal.sessionId);
      useAppStore.getState().setActiveSection('terminal');
    });
    controller.focus();
    const firstChildren = new Set(childIds);
    const runningMarker = `delegation-running-${crypto.randomUUID()}`;
    const cancelledMarker = `delegation-cancelled-${crypto.randomUUID()}`;
    const takeoverGoal = `Run run_terminal_command exactly once with this exact command, then reply done.\n${printCommand(runningMarker, 0)}; ${printCommand(cancelledMarker, 20)}`;
    await invokeAgentRuntimeFollowup({ sessionId: parentId, messageId: crypto.randomUUID(),
      content: `Call spawn_one_shot_agent exactly once with these exact arguments, wait for it, then reply done. Do not retry or create replacement children. ${JSON.stringify({
        goal: takeoverGoal, role: 'general', inheritanceMode: 'blank', targetIds: [target.targetId], requiredTools: ['run_terminal_command'],
      })}` });
    await eventually(() => {
      assert(!failure, failure ?? 'Delegation failed before takeover');
      const view = agentTerminalLeaseState.get(terminalId!);
      return view?.commandPhase === 'running' && childIds.has(view.agentSessionId)
        && !firstChildren.has(view.agentSessionId) && output.includes(runningMarker);
    }, 'Takeover requires the new child command to be running on the real PTY');
    takingOver = true;
    agentTerminalLeaseState.get(terminalId)!.requestTakeover();
    await eventually(async () => !agentTerminalLeaseState.get(terminalId!)
      && await invokeGetAgentTerminalOwner(terminalId!) === null
      && (await invokeGetTerminalBrokerSnapshot(terminalId!)).session?.promptReady === true,
    'Taking over a child did not stop its owning parent and restore the shell');
    assert(!output.includes(cancelledMarker), 'The interrupted child command must not finish after takeover');
    assert(await controller.writeUserInput('\u000c') === true, 'Confirmed child takeover must release all frontend input locks');
    assert((await invokeGetAgentRuntimeSession({ sessionId: parentId })).status !== 'running',
      'Taking over the child must stop the parent turn');
    await fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, {
      method: 'POST', body: JSON.stringify({ progress: 'Verified delegated view and focus preservation, real child execution, parent resumption, unrelated Agent exclusion and child takeover.',
        evidence: { terminalDelegation: { parentId, childIds: [...childIds], restoredParent, events, leases, outputTail: output.slice(-8192) } } }),
    });
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    root.unmount();
    draftEditor.remove();
    for (const id of [...childIds, ...created]) {
      await invokeCancelAgentRuntime({ sessionId: id });
      await invokeArchiveAgentRuntimeSession({ sessionId: id });
      await invokeDeleteAgentRuntimeSession({ sessionId: id });
    }
    if (terminalId) {
      await invokeCloseSession(terminalId);
      terminalRegistry.dispose(terminalId);
    }
    if (otherTerminalId) {
      await invokeCloseSession(otherTerminalId);
      terminalRegistry.dispose(otherTerminalId);
    }
  }
}
