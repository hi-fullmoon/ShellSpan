import {createRoot} from 'react-dom/client';
import {getCurrentWindow, currentMonitor} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {TerminalPane} from '../terminal-pane';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession, invokeCloseSession, invokeGetTerminalBrokerSnapshot, listenToSshClosed} from '@/lib/ipc/tauri';
import type {ClosedEvent} from '@/types';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {nativeFileCoreSetup, readNativeFileLoadedCore} from './native-file-chain-approval';
import {nativeDisplayActivePlan, nativeDisplayAutoPlan, nativeDisplayAutoSizes, nativeDisplayGeometry, nativeDisplayPrompt, nativeDisplayViewportSizes} from './native-display-auto-plan';
import {nativeDisplayWindowContained} from './native-display-window-plan';
import {nativeDisplayHistoryAnchor, nativeDisplayHistoryPlans} from './native-display-history-plan';
import {NativeDisplayTrace, nativeDisplayTraceState} from './native-display-trace';
import {nativeDisplayCursorDiagnostic} from './native-display-cursor-diagnostic';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value {if (!value) throw Error(message);}
function object(value: unknown): Record<string, unknown> {assert(value && typeof value === 'object' && !Array.isArray(value), 'Structured display witness required');return value as Record<string, unknown>;}
async function until(test: () => boolean | Promise<boolean>, message: string, milliseconds = 20000) {
  const end = Date.now() + milliseconds;
  while (!await test()) {assert(Date.now() < end, message);await new Promise(resolve => setTimeout(resolve, 20));}
}
function DisplaySession({sessionId}: {sessionId: string}) {
  const session = useTerminalStore(state => state.sessions.find(value => value.sessionId === sessionId));
  return <div className="h-screen w-full overflow-hidden"><TerminalControllerLayer/><div id="native-display-size" className="min-h-0 min-w-0" style={{width: '100%', height: '100%'}}><TerminalPane activeSession={session ?? null} isActive isVisible/></div></div>;
}

async function verify() {
  const params = new URL(location.href).searchParams, token = params.get('token'), shell = params.get('nativeP3');
  const diagnosticReflow = params.get('nativeDisplayReflowDiagnostic') === 'true';
  const cursorDiagnostic = params.get('nativeDisplayCursorDiagnostic') === 'true';
  const activeInput = params.get('nativeDisplayActiveInput') === 'true';
  assert(token && (shell === 'powerShell7' || shell === 'windowsPowerShell'), 'Exact owned Windows display case required');
  const report = (value: unknown) => fetch(`/__agent-stream-result/${token}`, {method: 'POST', body: JSON.stringify(value)});
  const witness = async (path: string) => {const response = await fetch(`/${path}/${token}`);assert(response.ok, 'Owned native display witness unavailable');return object(await response.json());};
  await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
  const appWindow = getCurrentWindow(), monitor = await currentMonitor();assert(monitor, 'Actual display monitor unavailable');
  const workArea = {x: monitor.workArea.position.x, y: monitor.workArea.position.y, width: monitor.workArea.size.width, height: monitor.workArea.size.height};
  const outerPosition = await appWindow.outerPosition(), outerSize = await appWindow.outerSize();
  const initialWindow = {x: outerPosition.x, y: outerPosition.y, width: outerSize.width, height: outerSize.height};
  await appWindow.maximize();
  let clientBounds = initialWindow;
  await until(async () => {const position = await appWindow.innerPosition(), size = await appWindow.innerSize();clientBounds = {x: position.x, y: position.y, width: size.width, height: size.height};return await appWindow.isMaximized() && nativeDisplayWindowContained(workArea, clientBounds);}, 'Owned display client is outside the actual work area');
  const viewportBoundary = {workArea, initialWindow, clientBounds, maximized: true, physicalPixels: true};
  useAppStore.setState({terminalCopyOnSelect: false});
  let raw = '', visible = '', captureFailure: string | undefined, closed: ClosedEvent | undefined, observer: Record<string, unknown> | undefined, normalExit = false;
  let trace: NativeDisplayTrace | undefined, traceWitness: unknown, visibleWitness: unknown;
  const records: Record<string, unknown>[] = [], viewportRecords: Record<string, unknown>[] = [], historySelectionSetups: Record<string, unknown>[] = [], resizes: {columns: number; rows: number; at: number}[] = [];
  const dispose: (() => void)[] = [];let ordinaryInputCalls = 0;
  const session = await invokeCreateLocalSession(100, 30);
  // Registry notification is synchronous; backend output is released only after its async listeners are installed.
  dispose.push(terminalRegistry.subscribe(() => {
    const controller = terminalRegistry.get(session.sessionId);if (!controller || trace) return;
    const terminal = controller.terminal, buffer = terminal.buffer.active;
    trace = new NativeDisplayTrace({columns: terminal.cols, rows: terminal.rows,
      empty: buffer.baseY === 0 && buffer.cursorX === 0 && buffer.cursorY === 0 && Array.from({length: buffer.length}, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '').every(line => line === ''),
      unicodeVersion: terminal.unicode.activeVersion, nativeDisplayBinding: session.ptyInfo?.nativeDisplayBinding,
      options: {windowsPty: terminal.options.windowsPty, scrollback: terminal.options.scrollback, fontFamily: terminal.options.fontFamily, fontSize: terminal.options.fontSize, lineHeight: terminal.options.lineHeight, letterSpacing: terminal.options.letterSpacing, reflowCursorLine: terminal.options.reflowCursorLine}});
    const ownedTrace = trace;
    dispose.push(controller.subscribeOutput(value => {
      if (!value) return;
      if (raw.length + value.length > 900000) {captureFailure = 'Original session output exceeds bound';return;}raw += value;
    }));
    dispose.push(controller.subscribeDisplayOutput(({source, data}) => {
      const sequence = ownedTrace.output(data, source);if (sequence < 0) return;visible += data;
      // Enqueue after the registry writes this actual chunk; this is a display parser barrier, never PTY input.
      queueMicrotask(() => terminal.write('', () => ownedTrace.parsed(sequence)));
    }));
    const resize = terminal.onResize(({cols, rows}) => {resizes.push({columns: cols, rows, at: Date.now()});ownedTrace.resize(cols, rows);});dispose.push(() => resize.dispose());
  }));
  useTerminalStore.getState().addSession(session);useTerminalStore.getState().setActiveSession(session.sessionId);
  const root = createRoot(document.getElementById('root')!);root.render(<DisplaySession sessionId={session.sessionId}/>);
  let rawUploadAttempted = false, rawWitness: unknown;
  let failureView: (() => unknown) | undefined;
  let activeDraft: {index: number; prefix: string; suffix: string; submitSent: boolean} | undefined;
  const storeRaw = async () => {
    if (rawUploadAttempted) return rawWitness ?? null;
    rawUploadAttempted = true;
    const response = await fetch(`/__native-display-output/${token}`, {method: 'POST', body: new TextEncoder().encode(raw)});
    assert(response.ok, 'Owned decoded PTY output retention failed');rawWitness = await response.json();return rawWitness;
  };
  const storeTrace = async () => {
    if (traceWitness) return traceWitness;
    if (!trace) return null;
    const response = await fetch(`/__native-display-trace/${token}`, {method: 'POST', body: JSON.stringify(trace.snapshot(visible))});
    assert(response.ok, 'Owned display trace retention failed');traceWitness = await response.json();return traceWitness;
  };
  const storeVisible = async () => {
    if (visibleWitness) return visibleWitness;
    const response = await fetch(`/__native-display-visible-output/${token}`, {method: 'POST', body: new TextEncoder().encode(visible)});
    assert(response.ok, 'Actual visible output retention failed');visibleWitness = await response.json();return visibleWitness;
  };
  try {
    await until(() => !!terminalRegistry.get(session.sessionId)?.host, 'Actual TerminalPane did not attach');
    const controller = terminalRegistry.get(session.sessionId)!;await controller.whenOutputReady();
    assert(trace?.initial.empty, 'Complete display observer was not installed on an empty controller');
    const idle = async () => {const value = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;return !!value?.promptReady && !value.inputObservation?.commandInputPending;};
    await until(idle, 'Actual native prompt unavailable');
    const before = await invokeGetTerminalBrokerSnapshot(session.sessionId);assert(isCurrentNativeEditorProfile(before.session?.nativePeerProfile, shell), 'Exact native display profile unavailable');
    dispose.push(await listenToSshClosed(session.sessionId, ({payload}) => {closed = payload;}));
    await report({progress: 'Actual TerminalPane ready for original Shell/module and exit-handle observation.', evidence: {kind: 'actual-native-display-auto-ready', token, before, diagnosticReflow, cursorDiagnostic, activeInput, viewportBoundary}});
    await until(async () => {const value = await witness('__native-job-observer');if (!value.ready) return false;observer = value;return true;}, 'Original native display Shell observer missing', 60000);
    await until(async () => {const value = await witness('__native-display-exit');if (!value.ready) return false;const ready = object(value.ready);return ready.shellPid === observer?.shellPid && ready.created === observer?.handleCreated && ready.handleHeld === true;}, 'Original display Shell handle not held', 60000);
    const write = async (source: string) => {await until(idle, 'Display input was not idle');assert(await controller.writeUserInput(source + '\r'), 'Ordinary owned display command blocked');ordinaryInputCalls++;};
    await write(nativeFileCoreSetup + (cursorDiagnostic ? '; ' + nativeDisplayCursorDiagnostic(token) : ''));
    await until(() => readNativeFileLoadedCore(raw)?.sha256 === observer?.moduleSha256, 'Actual loaded display DLL differs from inspected Shell');await until(idle, 'Core observation did not return to prompt');
    const copied = () => {assert(!useAppStore.getState().terminalCopyOnSelect, 'Fixture must never copy to the system clipboard');trace!.action({kind: 'selectAll'});controller.terminal.selectAll();const value = controller.terminal.getSelection();trace!.action({kind: 'clearSelection'});controller.terminal.clearSelection();return value;};
    failureView = () => ({text: copied(), columns: controller.terminal.cols, rows: controller.terminal.rows,
      cursor: {x: controller.terminal.buffer.active.cursorX, y: controller.terminal.buffer.active.cursorY}, activeDraft,
      scope: 'Readonly display diagnostics;not a native buffer,acceptance or execution receipt'});
    const cwd = before.session?.currentDirectory;
    const expectedPrompt = nativeDisplayPrompt(cwd);
    const promptObservation = () => {const text = copied().trimEnd();return {applicable: expectedPrompt !== null, expected: expectedPrompt, intact: expectedPrompt !== null && text.endsWith(expectedPrompt), tail: text.slice(-320)};};
    for (const [index, size] of nativeDisplayAutoSizes.entries()) {
      const holder = document.getElementById('native-display-size');assert(holder, 'Display resize container missing');const previous = {columns: controller.terminal.cols, rows: controller.terminal.rows};
      const promptBeforeResize = promptObservation();
      const sceneRawStart = raw.length;
      const activePlan = activeInput ? nativeDisplayActivePlan(token, index) : undefined;
      activeDraft = activePlan ? {index, prefix: activePlan.prefix, suffix: activePlan.suffix, submitSent: false} : undefined;
      let draftBeforeResize: string | undefined;
      if (activePlan) {
        await until(idle, 'Active display input did not begin at an idle prompt');
        assert(await controller.writeUserInput(activePlan.prefix), 'Partial ordinary user input blocked');ordinaryInputCalls++;
        await until(() => copied().trimEnd().endsWith(expectedPrompt + ' ' + activePlan.prefix), 'Unsubmitted Unicode input not visible before resize');
        draftBeforeResize = copied();
      }
      if (diagnosticReflow) controller.terminal.options.reflowCursorLine = true;
      const reflowBeforeResize = controller.terminal.options.reflowCursorLine;
      holder.style.width = size.width;holder.style.height = size.height;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await until(async () => {const geometry = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.geometry;return controller.terminal.cols > 19 && (index === 0 || previous.columns !== controller.terminal.cols || previous.rows !== controller.terminal.rows) && !!geometry && geometry.columns === controller.terminal.cols && geometry.rows === controller.terminal.rows;}, 'Backend did not acknowledge actual container geometry');
      const promptAfterResize = promptObservation();const geometryObservedAt = Date.now();
      const columns = controller.terminal.cols, rows = controller.terminal.rows, plan = activePlan ?? nativeDisplayAutoPlan(token, index, columns), offset = activePlan ? sceneRawStart : raw.length;
      const draftAfterResize = activePlan ? copied() : undefined;
      if (activePlan) {assert(await controller.writeUserInput(activePlan.suffix + '\r'), 'Continuation of ordinary user input blocked');ordinaryInputCalls++;if (activeDraft) activeDraft.submitSent = true;}
      else await write(plan.source);
      await until(() => copied().includes(plan.end), 'Actual printed display scene missing');await until(idle, 'Display scene did not return to prompt');
      const text = copied(), geometry = nativeDisplayGeometry(text, plan.geometry);assert(geometry && geometry.columns === columns && geometry.rows === rows, 'Actual Console geometry differs from the UI/backend');
      let cursor = 0;const positions = plan.lines.map(line => {const at = text.indexOf(line, cursor);assert(at >= 0, 'Actual source output lost or changed characters after resize');cursor = at + line.length;return at;});
      await new Promise<void>(resolve => controller.terminal.write('', resolve));await trace.checkpoint('scene-' + index, nativeDisplayTraceState(controller.terminal));
      const response = await fetch(`/__native-display-capture/${token}/${index}`, {method: 'POST'});if (!response.ok) throw Error('Owned display capture refused: ' + (await response.text()).slice(0, 2048));
      const image: unknown = await response.json();
      records.push({index, activeInput, draft: activePlan ? {prefix: activePlan.prefix, suffix: activePlan.suffix, beforeResize: draftBeforeResize, afterResize: draftAfterResize, unsubmittedBeforeResize: true} : undefined, container: size, columns, rows, geometry, geometryObservedAt, recordedAt: Date.now(), source: plan.source, expected: plan.lines, positions, text, prompt: {beforeResize: promptBeforeResize, afterResize: promptAfterResize, afterScene: promptObservation()}, rawRange: {start: offset, end: raw.length}, image, rendering: {unicodeVersion: controller.terminal.unicode.activeVersion, windowsPty: controller.terminal.options.windowsPty, reflowBeforeResize, reflowAfterScene: controller.terminal.options.reflowCursorLine, canvasElements: holder.querySelectorAll('canvas').length, domRows: holder.querySelectorAll('.xterm-rows').length}});
    }
    assert(new Set(records.map(value => String(value.columns))).size >= 3 && new Set(records.map(value => String(value.rows))).size >= 3, 'Actual resize scenes did not cover changing width and height');
    if (!diagnosticReflow && !cursorDiagnostic) {
      const terminal = controller.terminal, holder = document.getElementById('native-display-size');assert(holder, 'Viewport resize container missing');
      holder.style.height = '320px';
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await until(async () => {const geometry = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.geometry;return !!geometry && geometry.columns === terminal.cols && geometry.rows === terminal.rows;}, 'Initial horizontal viewport geometry was not acknowledged');
      await new Promise<void>(resolve => terminal.write('', resolve));
      const apis = {selection: terminal.getSelection, select: terminal.select, line: terminal.buffer.normal.getLine};
      assert(['Windows', 'Win16', 'Win32', 'WinCE'].includes(navigator.platform), 'Expected an actual Windows browser selection contract');
      const selectionLineEnding = '\r\n';
      const historyPlans = [...nativeDisplayHistoryPlans(token), {kind: 'following', lines: [], topPrefix: ''}];
      for (const historyPlan of historyPlans) {
        const parked = historyPlan.kind !== 'following';
        trace.action({kind: 'clearSelection'});terminal.clearSelection();
        // Locate a new initial selection once. Never call the locator after resizing this selection.
        const anchor = parked ? nativeDisplayHistoryAnchor(terminal.buffer.normal, terminal.cols, historyPlan.lines) : null;
        const expected = historyPlan.lines.join(selectionLineEnding);
        if (parked) {
          assert(anchor && anchor.row < terminal.buffer.normal.baseY, 'Actual history does not contain a unique parked anchor');trace.action({kind: 'select', column: anchor.column, row: anchor.row, length: anchor.length});terminal.select(anchor.column, anchor.row, anchor.length);trace.action({kind: 'scrollToLine', row: anchor.row});terminal.scrollToLine(anchor.row);
          const selection = terminal.getSelection();historySelectionSetups.push({kind: historyPlan.kind, platform: navigator.platform, selectionLineEnding, anchor, expected, selection, at: Date.now()});
          assert(selection === expected, 'Initial history selection differs: ' + JSON.stringify({kind: historyPlan.kind, expected, selection}));
        }
        else {trace.action({kind: 'scrollToBottom'});terminal.scrollToBottom();}
        const top = terminal.buffer.normal.getLine(terminal.buffer.normal.viewportY)?.translateToString(true);
        if (parked) assert(top?.startsWith(historyPlan.topPrefix), 'Initial parked viewport differs');
        const initialRows = terminal.rows;
        for (const size of nativeDisplayViewportSizes(parked)) {
          holder.style.width = size.width;holder.style.height = size.height;
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          await until(async () => {const geometry = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.geometry;return !!geometry && geometry.columns === terminal.cols && geometry.rows === terminal.rows;}, 'Viewport geometry was not acknowledged');
          await new Promise<void>(resolve => terminal.write('', resolve));
          const buffer = terminal.buffer.normal, observed = {columns: terminal.cols, rows: terminal.rows, viewportY: buffer.viewportY, baseY: buffer.baseY, top: buffer.getLine(buffer.viewportY)?.translateToString(true), selection: terminal.getSelection(), position: terminal.getSelectionPosition()};
          if (parked) assert(terminal.rows === initialRows, 'Selection check changed rows instead of isolating horizontal reflow');
          viewportRecords.push({kind: historyPlan.kind, parked, initialAnchor: anchor, topPrefix: historyPlan.topPrefix, container: size, expected, ...observed, checkedAt: Date.now()});
          assert(terminal.getSelection === apis.selection && terminal.select === apis.select && buffer.getLine === apis.line, 'Viewport check replaced a public xterm API');
          assert(parked ? observed.viewportY < observed.baseY && observed.top?.startsWith(historyPlan.topPrefix) && observed.selection === expected : observed.viewportY === observed.baseY && observed.selection === '', 'Actual history viewport or selection changed during reflow: ' + JSON.stringify(observed));
          await trace.checkpoint('viewport-' + (viewportRecords.length - 1), nativeDisplayTraceState(terminal));
          const capture = await fetch(`/__native-display-capture/${token}/${6 + viewportRecords.length - 1}`, {method: 'POST'});assert(capture.ok, 'Owned viewport capture failed');viewportRecords[viewportRecords.length - 1].image = await capture.json();
        }
      }
      trace.action({kind: 'clearSelection'});terminal.clearSelection();
    }
    await until(idle, 'Display Shell did not release input');assert(await controller.writeUserInput('exit\r'), 'Ordinary display Shell exit blocked');ordinaryInputCalls++;
    await until(() => !!closed, 'Actual display Shell did not close');assert(closed?.reasonKind === 'remote_exit' && closed.reason === 'local shell exited' && !closed.retryable, 'Display Shell ended by forced close');
    let exit: Record<string, unknown> | undefined;
    await until(async () => {const value = await witness('__native-display-exit');if (!value.result) return false;exit = object(value.result);return exit.ended === true && exit.exitCode === 0 && exit.shellPid === observer?.shellPid && exit.created === observer?.handleCreated;}, 'Original display Shell normal exit not observed');normalExit = true;
    await invokeCloseSession(session.sessionId);
    await new Promise<void>(resolve => controller.terminal.write('', resolve));const traceResult = trace.snapshot(visible);await storeTrace();await storeVisible();assert(!captureFailure, captureFailure ?? 'Session capture failed');assert(traceResult.replayable, 'Display trace ordering is unproved: ' + traceResult.issues.join('; '));
    await report({ok: true, evidence: {kind: 'actual-native-display-auto', diagnosticReflow, cursorDiagnostic, activeInput, viewportBoundary, defaultAcceptanceClaim: !diagnosticReflow && !cursorDiagnostic, before, observer, loadedCore: readNativeFileLoadedCore(raw), records, viewportRecords, historySelectionSetups, displayTrace: traceWitness, visibleOutput: visibleWitness, viewportPhysicalInput: false, viewportSearchOrReselectionAfterResize: false, resizes, decodedOutput: await storeRaw(), rawCharacters: raw.length, visibleCharacters: visible.length, closed, exit, normalExit, ordinaryInputCalls, modelCalls: 0, agentSubmissions: 0, clipboardReads: 0, clipboardWrites: 0, manualCasesPassed: false, scope: 'Actual TerminalPane/live original PTY output retained separately from actual visible writes,including local status/control bytes and filtered session data. Ordered visible output/resize/actions and complete original display checkpoint JSON retained for independent browser rendering. Initial selection uses public coordinates;no search/reselection after resize. No returned-text normalization,model/Agent,physical clipboard or full background-interleaving claim.'}});
  } catch (error) {
    let displayFailure: unknown;
    try { displayFailure = failureView?.(); } catch { displayFailure = {unavailable: true}; }
    await report({ok: false, error: String(error), evidence: {kind: 'actual-native-display-auto-failure', diagnosticReflow, cursorDiagnostic, activeInput, defaultAcceptanceClaim: false, error: String(error), records, viewportRecords, historySelectionSetups, resizes, displayFailure, displayTrace: await storeTrace().catch(() => null), visibleOutput: await storeVisible().catch(() => null), decodedOutput: await storeRaw().catch(() => null), rawCharacters: raw.length, visibleCharacters: visible.length, observer, closed, normalExit, ordinaryInputCalls, modelCalls: 0, clipboardReads: 0, clipboardWrites: 0}});throw error;
  } finally {for (const stop of dispose.reverse()) stop();await invokeCloseSession(session.sessionId).catch(() => {});terminalRegistry.dispose(session.sessionId);root.unmount();}
}
void verify().catch(() => {});
