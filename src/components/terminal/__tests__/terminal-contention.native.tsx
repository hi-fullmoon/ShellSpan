import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import TerminalWorkspace from '../index';
import { terminalRegistry } from '../registry/terminal-registry';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { useTerminalTaskNavigation } from '../agent-terminal-task-navigation';
import { AppShell, MainContent } from '@/components/layout/app-shell';
import { FocusLayout } from '@/components/focus/focus-layout';
import { AiPanel } from '@/components/ai/ai-panel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useFocusStore } from '@/stores/focusStore';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { initI18n, t } from '@/locales';
import {
  invokeCreateLocalSession, invokeCloseSession, invokeListAiRoutes, invokeGetAgentTerminalOwner, invokeGetTerminalBrokerSnapshot,
  invokeCreateAgentRuntimeSession, invokeStartAgentRuntime, invokeAgentRuntimeFollowup,
  invokeGetAgentRuntimeSession, invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession,
  invokeDeleteAgentRuntimeSession, invokeGetAgentRuntimeArtifact, listenToAgentRuntimeSession, listenToAgentTerminalLease,
  invokeGetCommittedAgentRuntimeEvents,
} from '@/lib/ipc/tauri';
import { createAgentSessionAdapter } from '@/lib/ai/agent-session-adapter';
import '@/styles/base.css';
import type { AgentSessionEvent } from '@/types/agent-session';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function eventually(check: () => boolean | Promise<boolean>, message: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
async function reportProgress(progress: string) {
  await fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, {
    method: 'POST', body: JSON.stringify({ progress }),
  });
}
function workspaceRoot(focus: boolean): HTMLElement | null {
  return document.querySelector(focus
    ? '[data-slot="focus-agent"] [data-slot="ai-workspace-root"]'
    : '[data-slot="ai-panel"][data-ai-scope="terminal"] [data-slot="ai-workspace-root"]');
}
function draftEditor(focus: boolean): HTMLElement {
  const editor = workspaceRoot(focus)?.querySelector<HTMLElement>('[data-composer-editor]');
  assert(editor, 'Production composer editor is missing');
  return editor;
}
function draftText(focus: boolean): string {
  return draftEditor(focus).innerText.trimEnd();
}
async function setDraft(focus: boolean, text: string, nativeKeyboard = false) {
  const editor = draftEditor(focus);
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  assert(selection, 'No browser text selection');
  selection.removeAllRanges();
  selection.addRange(range);
  let nativeInput: unknown;
  if (nativeKeyboard) {
    const response = await fetch(`/__native-composer-input/${new URL(location.href).searchParams.get('token')}`, {
      method: 'POST', body: JSON.stringify({ text }),
    });
    const result = await response.text();
    assert(response.ok, `Native user keyboard input failed: ${result}`);
    nativeInput = JSON.parse(result);
  } else assert(document.execCommand('insertText', false, text), 'Native editor insertion failed');
  try {
    await eventually(() => draftText(focus) === text, 'The production editor did not retain its draft');
    if (nativeKeyboard) await fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, {
      method: 'POST', body: JSON.stringify({ progress: 'Captured actual native keyboard input and complete production draft.',
        evidence: { composerInput: { expected: text, actual: draftText(focus), nativeInput } } }),
    });
  } catch {
    throw new Error(`The production editor did not retain its draft: ${JSON.stringify({
      expected: text, actual: draftText(focus), originalEditorConnected: editor.isConnected,
      currentEditorIsOriginal: draftEditor(focus) === editor,
      currentEditorFocused: document.activeElement === draftEditor(focus),
      sessionId: workspaceRoot(focus)?.dataset.sessionId,
    })}`);
  }
}
function submitDraft(focus: boolean) {
  const button = workspaceRoot(focus)?.querySelector<HTMLButtonElement>('.ai-composer-primary');
  assert(button && !button.disabled, 'Production submit action is unavailable');
  button.click();
}

async function confirmTabClose(id: string) {
  const button = document.querySelector<HTMLButtonElement>(`[data-session-tab="${id}"] button[aria-label="close"]`);
  assert(button, 'Production close button is missing');
  flushSync(() => button.click());
  await eventually(() => !!document.querySelector('[role="alertdialog"]'), 'Close confirmation is missing');
  const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
    .find(candidate => candidate.textContent === t('common.close'));
  assert(confirm, 'Close confirmation action is missing');
  flushSync(() => confirm.click());
}

async function verify() {
  const cleanupIds = new URL(location.href).searchParams.getAll('cleanupSession');
  if (cleanupIds.length) {
    for (const id of cleanupIds) {
      assert(/^(?:focus-)?agent-contention-[0-9a-f-]{36}$/.test(id), 'Cleanup is restricted to contention test sessions');
      await invokeCancelAgentRuntime({ sessionId: id });
      await invokeArchiveAgentRuntimeSession({ sessionId: id });
      await invokeDeleteAgentRuntimeSession({ sessionId: id });
    }
    return;
  }
  await initI18n(useAppStore.getState().locale);
  await getCurrentWindow().show();
  await getCurrentWindow().setFocus();
  document.documentElement.dataset.theme = 'light';
  const noModel = new URL(location.href).searchParams.get('noModel') === 'true';
  const selection = noModel ? null : (await invokeListAiRoutes()).defaultSelection;
  const root = createRoot(document.getElementById('root')!);
  const ids = [`agent-contention-${crypto.randomUUID()}`, `focus-agent-contention-${crypto.randomUUID()}`];
  const created: string[] = [];
  const lifecycle: AgentSessionEvent[] = [];
  const assertClosedAfterMetadataRefresh = async () => {
    const adapter = createAgentSessionAdapter();
    const refreshes: { sessionId: string; operation: string; status: string; ended: boolean }[] = [];
    try {
      for (const id of ids) {
        for (const operation of ['skills', 'files']) {
          try {
            if (operation === 'skills') await adapter.listSkills?.(id);
            else await adapter.listFileReferences?.(id, '', new AbortController().signal);
          } catch { /* A closed source may reject discovery; it must stay ended. */ }
          const snapshot = await invokeGetAgentRuntimeSession({ sessionId: id });
          refreshes.push({ sessionId: id, operation, status: snapshot.status, ended: snapshot.ended });
        }
      }
      const journals = await Promise.all(ids.map(sessionId => invokeGetCommittedAgentRuntimeEvents({ sessionId, limit: 100 })));
      await fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, {
        method: 'POST', body: JSON.stringify({ progress: 'Captured read-only metadata refresh after real terminal close.',
          evidence: { refreshes, lifecycle, journals: journals.map(page => page.events.filter(event => ['session/resumed', 'session/ended', 'agent/status'].includes(event.type))) } }),
      });
      assert(refreshes.every(snapshot => snapshot.ended && snapshot.status === 'cancelled'),
        'Read-only metadata refresh reopened a cancelled terminal conversation');
    } finally { adapter.dispose(); }
  };
  const completed = new Map<string, number>();
  const toolEvidence: { kind: string; sessionId: string; status?: string; value: unknown; event: AgentSessionEvent }[] = [];
  const leaseEvidence: unknown[] = [];
  const artifactEvidence: unknown[] = [];
  const readOwnedToolJournals = async () => {
    const committedTools: AgentSessionEvent[] = [];
    for (const sessionId of ids.filter(id => created.includes(id))) {
      let afterSeq: number | undefined;
      for (let pageIndex = 0; ; pageIndex++) {
        assert(pageIndex < 100, 'Owned contention journal exceeded its evidence bound');
        const page = await invokeGetCommittedAgentRuntimeEvents({ sessionId, afterSeq, limit: 100 });
        committedTools.push(...page.events.filter(event => ['tool/call', 'tool/execution', 'tool/result'].includes(event.type)));
        if (page.nextCursor === undefined) break;
        assert(afterSeq === undefined || page.nextCursor > afterSeq, 'Owned contention journal cursor did not advance');
        afterSeq = page.nextCursor;
      }
    }
    return committedTools;
  };
  let failure: string | undefined;
  let takingOver = false;
  let closingTerminal = false;
  let terminalId: string | undefined;
  let otherTerminalId: string | undefined;
  let idleTerminalId: string | undefined;
  let terminalClosed = false;
  let otherTerminalClosed = false;
  let output = '';
  const cleanups: (() => void)[] = [];
  try {
    useAppStore.setState({ activeSection: 'terminal', restoreWorkspace: false });
    useAiPanelStore.getState().setOpen(true, 'terminal');
    flushSync(() => root.render(<TooltipProvider><AppShell>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <FocusLayout><MainContent><TerminalWorkspace /></MainContent></FocusLayout>
        <AiPanel />
      </div>
    </AppShell><Toaster /></TooltipProvider>));
    const bounds = document.getElementById('root')!.getBoundingClientRect();
    assert(bounds.width >= innerWidth - 1 && bounds.height >= innerHeight - 1, 'The real application shell must fill the viewport');
    const session = await invokeCreateLocalSession(100, 25);
    terminalId = session.sessionId;
    flushSync(() => useTerminalStore.getState().addSession(session));
    await eventually(() => useTerminalStore.getState().sessions.some(item => item.sessionId === terminalId && item.status === 'connected' && item.promptReady), 'Real local terminal never became ready');
    const controller = terminalRegistry.get(terminalId);
    assert(controller, 'No real terminal controller');
    const shell=(await invokeGetTerminalBrokerSnapshot(terminalId)).session?.integrationShell;
    const powershell=shell==='windowsPowerShell'||shell==='powerShell7';
    if (new URL(location.href).searchParams.get('composerInputDiagnostic') === 'true') {
      assert(noModel, 'Composer input diagnostic must not call a model');
      await invokeCreateAgentRuntimeSession({ sessionId: ids[1], taskId: ids[1], goal: 'Check actual composer input.',
        executionSurface: 'boundTerminal', target: { kind: 'local', targetId: `terminal-${terminalId}`, sessionId: terminalId },
      });
      created.push(ids[1]);
      flushSync(() => { useFocusStore.getState().enter(); useFocusStore.getState().setTarget(session.sessionId); });
      useTerminalTaskNavigation.getState().setRequest({ workspace: 'focus', agentSessionId: ids[1], terminalSessionId: terminalId });
      await eventually(() => workspaceRoot(true)?.dataset.sessionId === ids[1], 'Diagnostic Focus composer did not open');
      await setDraft(true, 'Call run_terminal_command exactly once on the bound visible terminal with this exact command. Do not use Direct, background execution, other tools, or alter the command. Reply done after it completes.\nStart-Sleep -Seconds 0; [Console]::WriteLine(\'原生输入字😀\')', powershell);
      await reportProgress('Actual production Focus composer retained the complete two-line draft; no model calls.');
      return;
    }
    if (noModel) {
      await reportProgress('Checking real PTY close and durable Agent cancellation without model credentials.');
      cleanups.push(controller.subscribeOutput(chunk => { output += chunk; }));
      for (const [index, id] of ids.entries()) {
        await invokeCreateAgentRuntimeSession({ sessionId: id, taskId: id, goal: 'Check terminal close.',
          executionSurface: index === 0 ? 'boundTerminal' : 'direct',
          target: { kind: 'local', targetId: `terminal-${terminalId}`, sessionId: terminalId },
        });
        created.push(id);
      }
      useTerminalTaskNavigation.getState().setRequest({ workspace: 'terminal', agentSessionId: ids[0], terminalSessionId: terminalId });
      await eventually(() => useTerminalTaskNavigation.getState().displayedSessionByWorkspace.terminal === ids[0],
        'The production Terminal controller must publish its loaded conversation');
      flushSync(() => useAiPanelStore.getState().setOpen(false, 'terminal'));
      assert(useTerminalTaskNavigation.getState().displayedSessionByWorkspace.terminal === null,
        'Closing the panel must clear the displayed conversation');
      flushSync(() => { useFocusStore.getState().enter(); useFocusStore.getState().setTarget(terminalId!); });
      useTerminalTaskNavigation.getState().setRequest({ workspace: 'focus', agentSessionId: ids[1], terminalSessionId: terminalId });
      await eventually(() => useTerminalTaskNavigation.getState().displayedSessionByWorkspace.focus === ids[1],
        'The production Focus controller must publish its own loaded conversation');
      flushSync(() => { useFocusStore.getState().leave(); useAiPanelStore.getState().setOpen(true, 'terminal'); });
      const other = await invokeCreateLocalSession(100, 25);
      otherTerminalId = other.sessionId;
      flushSync(() => useTerminalStore.getState().addSession(other));
      const unrelated = `agent-contention-${crypto.randomUUID()}`;
      await invokeCreateAgentRuntimeSession({ sessionId: unrelated, taskId: unrelated, goal: 'Check independent terminal.',
        executionSurface: 'boundTerminal', target: { kind: 'local', targetId: `terminal-${other.sessionId}`, sessionId: other.sessionId },
      });
      created.push(unrelated);
      const marker = `close-running-${crypto.randomUUID()}`;
      assert(await controller.writeUserInput(powershell ? `[Console]::WriteLine('${marker.slice(0,16)}'+'${marker.slice(16)}'); Start-Sleep -Seconds 30\r` : `printf '%s%s\\n' '${marker.slice(0, 16)}' '${marker.slice(16)}'; sleep 30\r`), 'Real terminal input was rejected');
      await eventually(() => output.includes(marker), 'Real command did not start');
      await confirmTabClose(terminalId);
      await eventually(() => !useTerminalStore.getState().sessions.some(item => item.sessionId === terminalId), 'Successful close must remove its tab');
      terminalClosed = true;
      for (const id of ids) {
        const snapshot = await invokeGetAgentRuntimeSession({ sessionId: id });
        assert(snapshot.ended && snapshot.status === 'cancelled', 'Closing must cancel durable Agent tasks on both execution surfaces');
      }
      await assertClosedAfterMetadataRefresh();
      assert(!(await invokeGetAgentRuntimeSession({ sessionId: unrelated })).ended, 'Another terminal task must remain unchanged');
      await invokeCloseSession(other.sessionId);
      otherTerminalClosed = true;
      const toastsBefore = useToastStore.getState().toasts.length;
      await confirmTabClose(other.sessionId);
      await eventually(() => !useTerminalStore.getState().sessions.some(item => item.sessionId === other.sessionId), 'An already-closed backend must still remove its tab');
      assert(useToastStore.getState().toasts.length === toastsBefore, 'Idempotent close must not report an error');
      await invokeCloseSession(other.sessionId);
      const idle = await invokeCreateLocalSession(100, 25);
      idleTerminalId = idle.sessionId;
      flushSync(() => useTerminalStore.getState().addSession(idle));
      await eventually(() => Boolean(useTerminalStore.getState().sessions.find(item => item.sessionId === idle.sessionId)?.promptReady), 'Idle-timeout terminal did not reach its prompt');
      const idleController = terminalRegistry.get(idle.sessionId);
      assert(idleController, 'Missing idle-timeout terminal controller');
      assert(await idleController.writeUserInput(powershell?'exit\r':'unset HISTFILE; TMOUT=1\r'), 'Real shell disconnect input was rejected');
      await eventually(() => useTerminalStore.getState().sessions.find(item => item.sessionId === idle.sessionId)?.status === 'disconnected', 'Real shell did not disconnect after its idle timeout');
      const idleToastsBefore = useToastStore.getState().toasts.length;
      await confirmTabClose(idle.sessionId);
      await eventually(() => !useTerminalStore.getState().sessions.some(item => item.sessionId === idle.sessionId), 'Idle-disconnected terminal tab was retained');
      assert(useToastStore.getState().toasts.length === idleToastsBefore, 'Closing an idle-disconnected terminal must not report an error');
      return;
    }
    assert(selection, 'A configured real model is required');
    const identity = (await invokeGetTerminalBrokerSnapshot(terminalId)).session;
    assert(identity, 'Missing broker identity for the real PTY');
    const operations = new Set<string>();
    cleanups.push(await listenToAgentTerminalLease(({ payload }) => {
      if (payload.sessionId !== terminalId || !ids.includes(payload.agentSessionId)) return;
      leaseEvidence.push(payload);
      if (payload.state === 'acquired') operations.add(payload.operationId);
    }));
    cleanups.push(controller.subscribeOutput(chunk => { output += chunk; }));
    cleanups.push(await listenToAgentRuntimeSession(async ({ payload }) => {
      if (!ids.includes(payload.sessionId)) return;
      if (['session/resumed', 'session/ended', 'agent/status', 'turn/start', 'turn/end'].includes(payload.type)) lifecycle.push(payload);
      if (payload.type === 'request/failure') failure = `Real model failure: ${payload.data.failure.kind}`;
      if (payload.type === 'tool/call') toolEvidence.push({ kind: 'call', sessionId: payload.sessionId, value: payload.data.call, event: payload });
      if (payload.type === 'tool/result') {
        let result: unknown = payload.data.data;
        if (result && typeof result === 'object' && 'artifactRef' in result && typeof result.artifactRef === 'string') {
          try {
            const artifact = await invokeGetAgentRuntimeArtifact({ sessionId: payload.sessionId, artifactId: result.artifactRef, maxBytes: 16 * 1024 * 1024 });
            assert(!artifact.truncated && artifact.metadata.kind === 'tool-result', 'Terminal proof requires the complete persisted tool result');
            assert('sha256' in result && artifact.metadata.sha256 === result.sha256, 'Tool-result artifact identity changed');
            const bytes = Uint8Array.from(atob(artifact.bodyBase64), character => character.charCodeAt(0));
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
            assert(digest === artifact.metadata.sha256 && bytes.length === artifact.metadata.sizeBytes, 'Persisted tool-result bytes do not match their metadata');
            artifactEvidence.push({ sessionId: payload.sessionId, metadata: artifact.metadata, computedSha256: digest, bytes: bytes.length });
            result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          } catch (error) {
            failure = `Cannot read complete terminal execution proof: ${error instanceof Error ? error.message : String(error)}`;
            return;
          }
        }
        toolEvidence.push({ kind: 'result', sessionId: payload.sessionId, status: payload.data.status, value: result, event: payload });
        if ((closingTerminal || takingOver && payload.sessionId === ids[0]) && payload.data.status !== 'completed') return;
        if (payload.data.status !== 'completed' || !result || typeof result !== 'object'
          || !('channel' in result) || result.channel !== 'terminal'
          || !('exitCode' in result) || result.exitCode !== 0
          || !('terminalSessionId' in result) || result.terminalSessionId !== identity.terminalSessionId
          || !('terminalGeneration' in result) || result.terminalGeneration !== identity.terminalGeneration
          || !('operationId' in result) || typeof result.operationId !== 'string' || !operations.has(result.operationId)) {
          failure = `Real terminal tool failed proof: status=${payload.data.status}; keys=${result && typeof result === 'object' ? Object.keys(result).join(',') : typeof result}`;
        } else completed.set(payload.sessionId, (completed.get(payload.sessionId) ?? 0) + 1);
      }
    }));
    for (const id of ids) {
      await invokeCreateAgentRuntimeSession({ sessionId: id, taskId: id, goal: 'Execute the user requested command on the bound visible terminal.',
        executionSurface: 'boundTerminal', permissionMode: 'operator',
        target: { kind: 'local', targetId: `terminal-${terminalId}`, sessionId: terminalId },
        capabilityScope: { toolNames: ['run_terminal_command'], effects: ['none', 'readOnly', 'stateChange'], targetIds: [`terminal-${terminalId}`] },
      });
      created.push(id);
      await reportProgress(`Starting real ${id.startsWith('focus-') ? 'Focus' : 'Terminal'} Agent through the configured model route.`);
      await invokeStartAgentRuntime({ sessionId: id, selection });
    }
    const idle = await invokeCreateLocalSession(100, 25);
    idleTerminalId = idle.sessionId;
    flushSync(() => useTerminalStore.getState().addSession(idle));
    const idleAgentId = `agent-contention-${crypto.randomUUID()}`;
    await invokeCreateAgentRuntimeSession({ sessionId: idleAgentId, taskId: idleAgentId,
      goal: 'Keep an idle conversation while switching terminal tabs.', executionSurface: 'boundTerminal',
      target: { kind: 'local', targetId: `terminal-${idle.sessionId}`, sessionId: idle.sessionId },
    });
    created.push(idleAgentId);
    useTerminalTaskNavigation.getState().setRequest({ workspace: 'terminal', agentSessionId: idleAgentId, terminalSessionId: idle.sessionId });
    await eventually(() => workspaceRoot(false)?.dataset.sessionId === idleAgentId, 'Idle Agent conversation did not open');
    const markerA = `contention-a-${crypto.randomUUID()}`;
    const markerB = `contention-b-${crypto.randomUUID()}`;
    const command = (marker: string, delay: number) => powershell ? `Start-Sleep -Seconds ${delay}; [Console]::WriteLine('${marker.slice(0,16)}'+'${marker.slice(16)}')` : `sleep ${delay}; printf '%s%s\\n' '${marker.slice(0, 16)}' '${marker.slice(16)}'`;
    const exactCommandPrompt = (command: string) => `Call run_terminal_command exactly once on the bound visible terminal with this exact command. Do not use Direct, background execution, other tools, or alter the command. Reply done after it completes.\n${command}`;
    const prompt = (marker: string, delay: number) => exactCommandPrompt(command(marker, delay));
    const send = (id: string, content: string, messageId = crypto.randomUUID()) => invokeAgentRuntimeFollowup({ sessionId: id, messageId, clientSubmissionId: messageId, content });
    await send(ids[0], prompt(markerA, 10));
    await eventually(() => agentTerminalLeaseState.get(terminalId!)?.agentSessionId === ids[0]
      && agentTerminalLeaseState.get(terminalId!)?.terminalOwned === true, 'First Agent never acquired the real PTY', 180_000);
    assert(await invokeGetAgentTerminalOwner(terminalId) === ids[0], 'Backend owner differs from first Agent');
    const transientWarnings: string[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.textContent?.includes(t('terminal.occupancy.submitBlocked'))) {
            transientWarnings.push(node.textContent);
          }
        }
      }
    });
    observer.observe(document.getElementById('root')!, { subtree: true, childList: true });
    const activateTab = (id: string): void => {
      const tab = document.querySelector<HTMLElement>(`[data-session-tab="${id}"]`);
      assert(tab, 'Production terminal tab is missing');
      flushSync(() => tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
    };
    try {
      // First visit waits for native history; subsequent visits restore cached state.
      for (let attempt = 0; attempt < 3; attempt++) {
        activateTab(terminalId);
        await eventually(() => workspaceRoot(false)?.dataset.sessionId === ids[0], 'The running Agent was not restored after switching tabs');
        await new Promise(requestAnimationFrame);
        assert(agentTerminalLeaseState.get(terminalId)?.agentSessionId === ids[0], 'Tab regression requires an active real terminal owner');
        assert(!workspaceRoot(false)?.textContent?.includes(t('terminal.occupancy.submitBlocked')), 'The owning Agent must not show a terminal conflict');
        if (attempt < 2) {
          activateTab(idle.sessionId);
          await eventually(() => workspaceRoot(false)?.dataset.sessionId === idleAgentId, 'The idle Agent was not restored');
        }
      }
      assert(transientWarnings.length === 0, 'Switching from an idle Agent to its running terminal owner flashed a conflict warning');
    } finally { observer.disconnect(); }
    flushSync(() => { useFocusStore.getState().enter(); useFocusStore.getState().setTarget(session.sessionId); });
    useTerminalTaskNavigation.getState().setRequest({ workspace: 'focus', agentSessionId: ids[1], terminalSessionId: terminalId });
    await eventually(() => workspaceRoot(true)?.dataset.sessionId === ids[1], 'Focus task did not open in the production UI');
    await reportProgress('First real Agent owns the PTY; checking competing submission and task navigation.');
    await eventually(() => !!document.querySelector('[data-slot="focus-terminal"] [data-testid="agent-terminal-lease-bar"]'), 'Terminal header must display terminal ownership');
    for (const split of [0.3, 0.6]) {
      flushSync(() => useFocusStore.getState().setSplit(split));
      await new Promise(requestAnimationFrame);
      const panel = workspaceRoot(true);
      const terminal = document.querySelector<HTMLElement>('[data-slot="focus-terminal"]');
      const notice = terminal?.querySelector<HTMLElement>('[data-testid="agent-terminal-lease-bar"]');
      assert(panel && notice && terminal, 'Production Focus panes are missing');
      assert(!document.querySelector('[data-slot="ai-workspace-root"] [data-slot="terminal-occupancy-notice"]'), 'Composers must not repeat terminal ownership');
      assert(!document.querySelector('[data-slot="ai-workspace-root"] [data-slot="terminal-occupancy-released"]'), 'Composers must not retain ownership release notices');
      assert(document.querySelector<HTMLElement>('[data-slot="focus-layout"]')!.clientWidth >= innerWidth - 1, 'Focus must use the full application content width');
      assert(panel.clientWidth >= 300 && terminal.clientWidth >= 320, 'Focus and terminal must both have usable widths');
      assert(notice.scrollWidth <= notice.clientWidth, 'Occupancy notice must fit the real resizable panel');
      assert(notice.querySelectorAll('button').length === 2, 'Task navigation and confirmed takeover must both be visible');
    }
    const draftB = prompt(markerB, 0);
    await setDraft(true, draftB, powershell);
    await eventually(() => workspaceRoot(true)?.textContent?.includes(t('terminal.occupancy.submitBlocked')) === true, 'Focus must warn before a conflicting submission');
    const blockedSubmit = workspaceRoot(true)?.querySelector<HTMLButtonElement>('.ai-composer-primary');
    assert(blockedSubmit?.disabled, 'Focus must disable sending while another Agent owns the terminal');
    blockedSubmit.click();
    assert(draftText(true) === draftB, 'Rejected Focus submit must retain its full draft');
    const retryId = crypto.randomUUID();
    let rejected = false;
    try { await send(ids[1], draftB, retryId); } catch (error) { rejected = String(error).includes('TERMINAL_AGENT_CONFLICT'); }
    assert(rejected, 'Backend must reject competing admission');
    assert(agentTerminalLeaseState.get(terminalId)?.agentSessionId === ids[0], 'Conflict must not replace the displayed owner');
    assert(await controller.writeUserInput('blocked') === false, 'User input must remain blocked');
    const taskButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="focus-terminal"] [data-testid="agent-terminal-lease-bar"] button'))
      .find(button => button.textContent === t('terminal.occupancy.viewTask'));
    assert(taskButton, 'Production task entry is missing');
    taskButton.click();
    await eventually(() => workspaceRoot(false)?.dataset.sessionId === ids[0], 'View task did not open the actual owning conversation');
    assert(!useFocusStore.getState().enabled, 'Terminal task entry must open the Terminal workspace');
    await eventually(() => !Array.from(document.querySelectorAll('[data-testid="agent-terminal-lease-bar"] button'))
      .some(button => button.textContent === t('terminal.occupancy.viewTask')),
    'The task entry must disappear once its owning conversation is displayed');
    await eventually(async () => {
      assert(!failure, failure ?? 'Model failed');
      return completed.get(ids[0]) === 1 && output.includes(markerA) && await invokeGetAgentTerminalOwner(terminalId!) === null;
    }, 'First Agent did not finish and release ownership', 180_000);
    assert(!completed.has(ids[1]) && !output.includes(markerB), 'Rejected input must never run automatically after release');
    const before = await invokeGetAgentRuntimeSession({ sessionId: ids[1] });
    assert(before.inbox.nextTurn.length === 0 && before.inbox.nextStep.length === 0, 'Rejected input must not be queued');
    flushSync(() => useFocusStore.getState().enter());
    await eventually(() => !workspaceRoot(true)?.textContent?.includes(t('terminal.occupancy.submitBlocked'))
      && workspaceRoot(true)?.querySelector<HTMLButtonElement>('.ai-composer-primary')?.disabled === false,
    'Focus must restore manual sending after terminal ownership is released');
    assert(draftText(true) === draftB, 'Focus must retain the rejected draft until explicit retry');
    submitDraft(true);
    await eventually(async () => {
      assert(!failure, failure ?? 'Model failed');
      return completed.get(ids[1]) === 1 && output.includes(markerB) && await invokeGetAgentTerminalOwner(terminalId!) === null;
    }, 'Explicit retry from the second real Agent did not complete', 180_000);
    const concurrentMarkers = ids.map(() => `contention-race-${crypto.randomUUID()}`);
    await reportProgress('Manual retry completed; checking simultaneous admission and confirmed takeover.');
    const race = await Promise.allSettled(ids.map((id, index) => send(id, prompt(concurrentMarkers[index], 2))));
    const winner = race.findIndex(result => result.status === 'fulfilled');
    assert(winner >= 0 && race.filter(result => result.status === 'fulfilled').length === 1, 'Exactly one simultaneous Agent submission must be accepted');
    const loser = 1 - winner;
    const losingResult = race[loser];
    assert(losingResult.status === 'rejected' && String(losingResult.reason).includes('TERMINAL_AGENT_CONFLICT'), 'Simultaneous loser must receive an explicit conflict');
    await eventually(async () => {
      assert(!failure, failure ?? 'Model failed');
      return output.includes(concurrentMarkers[winner]) && await invokeGetAgentTerminalOwner(terminalId!) === null;
    }, 'Simultaneous winner did not finish', 180_000);
    assert(!output.includes(concurrentMarkers[loser]), 'Simultaneous loser must never execute after the winner releases');

    const takeoverMarker = `contention-takeover-${crypto.randomUUID()}`;
    const runningMarker = `contention-running-${crypto.randomUUID()}`;
    await send(ids[0], exactCommandPrompt(`${command(runningMarker, 0)}; ${command(takeoverMarker, 20)}`));
    await eventually(() => agentTerminalLeaseState.get(terminalId!)?.agentSessionId === ids[0]
      && agentTerminalLeaseState.get(terminalId!)?.commandPhase === 'running'
      && output.includes(runningMarker), 'Takeover requires a command proven to be running on the real PTY', 180_000);
    takingOver = true;
    agentTerminalLeaseState.get(terminalId)!.requestTakeover();
    assert(await controller.writeUserInput('blocked') === false, 'Requesting takeover must not immediately unlock input');
    await eventually(async () => !agentTerminalLeaseState.get(terminalId!)
      && await invokeGetAgentTerminalOwner(terminalId!) === null, 'Takeover did not confirm backend fencing');
    await eventually(async () => (await invokeGetTerminalBrokerSnapshot(terminalId!)).session?.promptReady === true,
      'The real shell did not return to a ready prompt after takeover');
    assert(await controller.writeUserInput('\u000c') === true, 'Confirmed takeover must restore real user input');
    assert(!output.includes(takeoverMarker), 'Cancelled command must not complete after takeover');
    flushSync(() => useFocusStore.getState().leave());
    flushSync(() => useTerminalTaskNavigation.getState().setRequest({
      workspace: 'terminal', agentSessionId: ids[0], terminalSessionId: terminalId!,
    }));
    const newSession = Array.from(workspaceRoot(false)?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.getAttribute('aria-label') === t('ai.newConversation'));
    assert(newSession && !newSession.disabled, 'Production new-conversation action is unavailable');
    flushSync(() => newSession.click());
    await eventually(() => useTerminalTaskNavigation.getState().request === null, 'Obsolete task navigation was not cancelled');
    assert(!workspaceRoot(false)?.dataset.sessionId, 'A late task lookup must not overwrite a newer conversation visit');

    await reportProgress('Checking real running-terminal close, Agent cancellation and repeated close.');
    const other = await invokeCreateLocalSession(100, 25);
    otherTerminalId = other.sessionId;
    flushSync(() => useTerminalStore.getState().addSession(other));
    const unrelated = `agent-contention-${crypto.randomUUID()}`;
    await invokeCreateAgentRuntimeSession({ sessionId: unrelated, taskId: unrelated, goal: 'Remain idle.',
      executionSurface: 'boundTerminal', permissionMode: 'operator',
      target: { kind: 'local', targetId: `terminal-${other.sessionId}`, sessionId: other.sessionId },
    });
    created.push(unrelated);
    await invokeStartAgentRuntime({ sessionId: unrelated, selection });
    const closeRunning = `close-running-${crypto.randomUUID()}`;
    const closeFinished = `close-finished-${crypto.randomUUID()}`;
    await send(ids[1], exactCommandPrompt(`${command(closeRunning, 0)}; ${command(closeFinished, 30)}`));
    await eventually(() => {
      assert(!failure, failure ?? 'Real tool failed before running-terminal close');
      return output.includes(closeRunning) && agentTerminalLeaseState.get(terminalId!)?.commandPhase === 'running';
    }, 'Close requires a real running command', 180_000);
    const beforeClose = await Promise.all(ids.map(sessionId => invokeGetAgentRuntimeSession({ sessionId })));
    assert(!beforeClose[1].ended, 'Close acceptance requires the second Agent to remain live');
    closingTerminal = true;
    await confirmTabClose(terminalId);
    await eventually(() => !useTerminalStore.getState().sessions.some(item => item.sessionId === terminalId), 'Successful close must remove the tab');
    terminalClosed = true;
    const afterClose = await Promise.all(ids.map(sessionId => invokeGetAgentRuntimeSession({ sessionId })));
    const summarizeClose = (snapshot: typeof beforeClose[number]) => ({ sessionId: snapshot.header.sessionId,
      target: snapshot.header.target?.sessionId, status: snapshot.status, ended: snapshot.ended });
    await fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, {
      method: 'POST', body: JSON.stringify({ progress: 'Captured actual terminal-close lifecycle before test resource cleanup.',
        evidence: { beforeClose: beforeClose.map(summarizeClose), afterClose: afterClose.map(summarizeClose), lifecycle } }),
    });
    for (const [index, snapshot] of afterClose.entries()) {
      const previous = beforeClose[index];
      assert(snapshot.ended && snapshot.status === (previous.ended ? previous.status : 'cancelled'),
        `Closing must cancel live associated Agents and preserve ended history: before=${previous.status}/${previous.ended}, after=${snapshot.status}/${snapshot.ended}`);
    }
    assert(await invokeGetAgentTerminalOwner(terminalId) === null, 'Closing must release Agent ownership');
    assert(!output.includes(closeFinished), 'Closing must interrupt the running command');
    const unrelatedSnapshot = await invokeGetAgentRuntimeSession({ sessionId: unrelated });
    assert(!unrelatedSnapshot.ended, 'Closing one terminal must preserve Agents on another terminal');
    await assertClosedAfterMetadataRefresh();

    // A stale tab whose transport was already closed still completes normally
    // through real IPC and the production close hook.
    await invokeCloseSession(other.sessionId);
    otherTerminalClosed = true;
    const toastsBefore = useToastStore.getState().toasts.length;
    await confirmTabClose(other.sessionId);
    await eventually(() => !useTerminalStore.getState().sessions.some(item => item.sessionId === other.sessionId), 'An already-closed backend must still remove its tab');
    assert(useToastStore.getState().toasts.length === toastsBefore, 'Idempotent close must not report an error');
    await invokeCloseSession(other.sessionId);
    const committedTools = await readOwnedToolJournals();
    assert(!failure, failure ?? 'Real contention proof failed');
    await fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, {
      method: 'POST', body: JSON.stringify({ progress: 'Captured complete owned tool journals, terminal leases and verified artifact hashes.',
        evidence: { toolChain: { identity, operations: [...operations], leases: leaseEvidence, tools: toolEvidence, artifacts: artifactEvidence, committedTools } } }),
    });
  } catch (error) {
    try {
      const snapshots = await Promise.all(created.map(async sessionId => {
        const snapshot = await invokeGetAgentRuntimeSession({ sessionId });
        return { sessionId, status: snapshot.status, ended: snapshot.ended,
          nextStep: snapshot.inbox.nextStep.length, nextTurn: snapshot.inbox.nextTurn.length };
      }));
      await fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, {
        method: 'POST', body: JSON.stringify({ progress: 'Captured real contention failure before owned resource cleanup.',
          evidence: { failureContext: { error: error instanceof Error ? error.message : String(error), failure, snapshots,
            completed: Object.fromEntries(completed), tools: toolEvidence, committedTools: await readOwnedToolJournals(), leases: leaseEvidence, artifacts: artifactEvidence, outputTail: output.slice(-16000),
            lease: terminalId ? agentTerminalLeaseState.get(terminalId) : null,
            broker: terminalId ? await invokeGetTerminalBrokerSnapshot(terminalId) : null } } }),
      });
    } catch { /* Preserve the original failure if diagnostic collection fails. */ }
    throw error;
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    root.unmount();
    for (const id of created) {
      await invokeCancelAgentRuntime({ sessionId: id });
      await invokeArchiveAgentRuntimeSession({ sessionId: id });
      await invokeDeleteAgentRuntimeSession({ sessionId: id });
    }
    if (terminalId) { if (!terminalClosed) await invokeCloseSession(terminalId); terminalRegistry.dispose(terminalId); }
    if (otherTerminalId) { if (!otherTerminalClosed) await invokeCloseSession(otherTerminalId); terminalRegistry.dispose(otherTerminalId); }
    if (idleTerminalId) { await invokeCloseSession(idleTerminalId); terminalRegistry.dispose(idleTerminalId); }
  }
}
void verify().then(() => ({ ok: true }), (error: unknown) => ({ ok: false,
  error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
})).then(result => fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, { method: 'POST', body: JSON.stringify(result) }));
