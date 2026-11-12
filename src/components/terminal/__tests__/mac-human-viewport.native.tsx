import {useState, type MouseEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {Button} from '@/components/ui/button';
import {Card, CardAction, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {invokeCloseSession, invokeCreateLocalSession, invokeGetTerminalBrokerSnapshot, invokeListAiRoutes} from '@/lib/ipc/tauri';
import {initI18n, t} from '@/locales';
import {useAppStore} from '@/stores/appStore';
import {useTerminalStore} from '@/stores/terminalStore';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {TerminalPane} from '../terminal-pane';
import {terminalRegistry} from '../registry/terminal-registry';
import {macHumanCapture} from './mac-human-capture';
import {isMacFileChainProfile} from './native-file-chain-posix';
import {macDisplayOutputCommand} from './native-display-manual-posix';
import {isManualSelection, manualPointerRow, nativeDisplaySamples, type ManualPointerGesture} from './native-display-manual-plan';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}

async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 20000;
  while (!await predicate()) {
    assert(Date.now() < deadline, message);
    await new Promise(done => setTimeout(done, 20));
  }
}

export async function startMacHumanViewport(token: string, family: 'zsh' | 'bash') {
  await initI18n('zh-CN');
  await getCurrentWindow().show();
  const routes = await invokeListAiRoutes();
  assert(!routes.routes.length && !routes.defaultSelection, 'Viewport case requires an empty model route store');
  useAppStore.setState({terminalCopyOnSelect: false});
  const capture = await macHumanCapture(token, 'human', {parsedOutputOrder: true});
  const session = await invokeCreateLocalSession(100, 30);
  await capture.expect(session.sessionId, session.ptyInfo);
  useTerminalStore.getState().addSession(session);
  useTerminalStore.getState().setActiveSession(session.sessionId);

  const mount = document.getElementById('root');
  assert(mount, 'Actual viewport page has no mount');
  const root = createRoot(mount);
  const snapshot = () => invokeGetTerminalBrokerSnapshot(session.sessionId);
  const controller = () => {
    assert(capture.controller, 'Actual viewport controller is not mounted');
    return capture.controller;
  };
  const observe = () => {
    const terminal = controller().terminal, buffer = terminal.buffer.normal;
    const position = terminal.getSelectionPosition();
    return {columns: terminal.cols, rows: terminal.rows, viewportY: buffer.viewportY, baseY: buffer.baseY,
      top: buffer.getLine(buffer.viewportY)?.translateToString(true), selection: terminal.getSelection(), position,
      anchorOffset: position ? position.start.y - buffer.viewportY : undefined};
  };
  const fitEnvironment = () => ({
    at: Date.now(),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    devicePixelRatio: window.devicePixelRatio,
    viewport: observe(),
  });
  const idle = async () => {
    const state = (await snapshot()).session;
    return !!state?.promptReady && !state.inputObservation?.commandInputPending && !state.inputObservation?.nativeRecoveryRequired;
  };
  const output = async (text: string, lastLine: string) => {
    const offset = capture.raw.length;
    assert(await controller().writeUserInput(macDisplayOutputCommand(text)), 'Actual viewport output was blocked');
    await until(() => capture.raw.slice(offset).includes(lastLine + '\r\n'), 'Actual viewport output did not arrive');
    await until(idle, 'Actual viewport Shell did not return to its prompt');
  };

  type Step = 'ready' | 'park' | 'follow';
  let step: Step = 'ready', ready = false, busy = false, closed = false;
  let message = t('terminal.human.preparing'), refresh = () => {};
  let host: HTMLDivElement | null = null, operatorStartedAt = 0;
  let up = false, down = false, gesture: ManualPointerGesture | undefined;
  let dragStart: {x: number; y: number; row: number} | undefined;
  const receipts: Record<string, unknown>[] = [];
  const inTerminal = (event: Event) => event.target instanceof Node && controller().container.contains(event.target);
  const wheel = (event: WheelEvent) => {
    if (!event.isTrusted || busy || step === 'ready' || !inTerminal(event) || event.deltaY === 0) return;
    if (step === 'park' && event.deltaY < 0) up = true;
    if (step === 'follow' && event.deltaY > 0) down = true;
    if (capture.physical.length < 256) capture.physical.push({type: 'wheel', step, trusted: true, at: Date.now(), deltaY: event.deltaY});
  };
  const pointerRow = (event: PointerEvent) => {
    const terminal = controller().terminal;
    const bounds = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    return bounds ? manualPointerRow(event.clientY, bounds.top, bounds.height, terminal.rows) : null;
  };
  const pointerDown = (event: PointerEvent) => {
    dragStart = undefined;
    if (step !== 'park' || busy || !event.isTrusted || event.button !== 0 || !inTerminal(event)) return;
    const row = pointerRow(event);
    if (row !== null) dragStart = {x: event.clientX, y: event.clientY, row};
  };
  const pointerUp = (event: PointerEvent) => {
    const start = dragStart;
    dragStart = undefined;
    if (!start || !event.isTrusted || !inTerminal(event)) return;
    const row = pointerRow(event);
    if (row === null) return;
    gesture = {trusted: true, startX: start.x, startY: start.y, startRow: start.row, endX: event.clientX, endY: event.clientY, endRow: row};
    if (capture.physical.length < 256) capture.physical.push({type: 'drag', step, at: Date.now(), ...gesture});
  };
  document.addEventListener('wheel', wheel, {capture: true, passive: true});
  document.addEventListener('pointerdown', pointerDown, true);
  document.addEventListener('pointerup', pointerUp, true);
  const close = async () => {
    if (closed) return;
    await invokeCloseSession(session.sessionId);
    closed = true;
    await until(async () => !(await snapshot()).session?.open, 'Actual viewport PTY did not close');
  };
  const dispose = () => {
    document.removeEventListener('wheel', wheel, true);
    document.removeEventListener('pointerdown', pointerDown, true);
    document.removeEventListener('pointerup', pointerUp, true);
    root.unmount();
    terminalRegistry.dispose(session.sessionId);
  };
  const fail = async (error: unknown) => {
    const cleanup: string[] = [];
    try {
      await close();
    } catch (problem) {
      cleanup.push(String(problem));
    }
    try {
      await capture.diagnose(session.sessionId);
    } catch (problem) {
      cleanup.push(String(problem));
    }
    try {
      await capture.post({ok: false, error: String(error), evidence: {kind: 'mac-human-failure', family, receipts, cleanup, humanReceipt: false}});
    } finally {
      dispose();
    }
  };
  const finish = async (deferred: boolean) => {
    await close();
    if (deferred) await capture.checkpoint('human-deferred', {receipts, broker: await snapshot()});
    await capture.finish(session.sessionId, {family, session, receipts, modelCalls: 0, agentSubmissions: 0,
      humanReceipt: !deferred, manualCasePassed: !deferred, caseScope: 'history-viewport'}, !deferred,
    deferred ? 'HUMAN_OPERATOR_DEFERRED' : undefined);
    dispose();
  };
  const verify = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!ready || busy || !event.isTrusted) return;
    busy = true;
    refresh();
    try {
      if (step === 'ready') {
        operatorStartedAt = Date.now();
        await capture.post({started: true, progress: 'Actual viewport operator started', evidence: {kind: 'manual-native-display-start', trusted: true, operatorStartedAt}});
        capture.releaseInitial();
        const history = Array.from({length: 120}, (_, i) => `HISTORY_${String(i + 1).padStart(3, '0')} stable anchor`);
        await output(history.join('\n'), history[119]);
        await capture.drain();
        assert(observe().baseY > 0, 'Actual history did not create scrollback');
        step = 'park';
        message = t('terminal.acceptance.step6');
        return;
      }
      await capture.drain();
      const before = observe();
      if (step === 'park') {
        const validSelection = isManualSelection(nativeDisplaySamples.history, before.selection, gesture, 'forward')
          || isManualSelection(nativeDisplaySamples.history, before.selection, gesture, 'reverse');
        if (!up || !validSelection || before.viewportY >= before.baseY || !before.top?.startsWith('HISTORY_')
          || before.anchorOffset === undefined || before.anchorOffset < 0 || before.anchorOffset >= before.rows) {
          message = t('terminal.acceptance.historyMismatch');
          return;
        }
        assert(host, 'Viewport layout host disappeared');
        capture.observeSelection();
        const fitScrolls: {at: number; viewportY: number; baseY: number; columns: number}[] = [];
        const terminal = controller().terminal;
        const scroll = terminal.onScroll(viewportY => {
          if (fitScrolls.length === 64) fitScrolls.shift();
          fitScrolls.push({at: Date.now(), viewportY, baseY: terminal.buffer.normal.baseY, columns: terminal.cols});
        });
        const preserved = (state: ReturnType<typeof observe>) => state.viewportY < state.baseY && state.top === before.top
          && state.selection === before.selection && state.anchorOffset === before.anchorOffset;
        try {
          await capture.checkpoint('human-viewport-parked', {before, gesture, trustedWheel: up, broker: await snapshot()}, true);
          const beforeFit = fitEnvironment();
          capture.records.push({label: 'human-viewport-before-fit', ...beforeFit, scrolls: [...fitScrolls]});
          assert(preserved(beforeFit.viewport), 'Actual viewport or selection changed before narrowing');
          host.style.width = '70%';
          controller().fit();
          capture.records.push({label: 'human-viewport-after-fit', ...fitEnvironment(), scrolls: [...fitScrolls]});
        } finally {
          scroll.dispose();
        }
        await until(async () => {
          const state = observe(), backend = (await snapshot()).session;
          return state.columns < before.columns && backend?.geometry.columns === state.columns && backend.geometry.rows === state.rows;
        }, 'Actual local PTY did not acknowledge the narrower layout');
        await capture.drain();
        const narrowed = observe();
        assert(preserved(narrowed), 'Narrowing moved the actual viewport or selection');
        await output('HISTORY_PARKED_NEW_OUTPUT', 'HISTORY_PARKED_NEW_OUTPUT');
        await capture.drain();
        const afterOutput = observe();
        assert(preserved(afterOutput), 'New output moved the parked viewport or selection');
        const receipt = {before, narrowed, afterOutput, gesture, trustedWheel: up, trustedOperatorConfirmation: true};
        receipts.push(receipt);
        await capture.checkpoint('human-viewport-narrowed', {receipt, broker: await snapshot()}, true);
        step = 'follow';
        message = t('terminal.menu.scrollBottom');
        return;
      }
      if (!down || before.viewportY !== before.baseY) {
        message = t('terminal.menu.scrollBottom');
        return;
      }
      capture.observeViewport();
      await output('HISTORY_FOLLOW_NEW_OUTPUT', 'HISTORY_FOLLOW_NEW_OUTPUT');
      await capture.drain();
      const afterOutput = observe();
      assert(afterOutput.viewportY === afterOutput.baseY && afterOutput.baseY > before.baseY, 'Actual viewport did not follow new output');
      const operatorCompletedAt = Date.now();
      assert(operatorCompletedAt - operatorStartedAt <= 900000, 'Actual viewport operator window expired');
      receipts.push({before, afterOutput, trustedWheel: down, trustedOperatorConfirmation: true});
      await capture.post({operatorCompleted: true, progress: 'Actual viewport operator finished', evidence: {
        kind: 'mac-human-operator-complete', trusted: true, operatorStartedAt, operatorCompletedAt}});
      message = t('terminal.human.waitScreenshot');
      refresh();
      await capture.checkpoint('human-final', {receipts, broker: await snapshot()}, true);
      await finish(false);
    } catch (error) {
      await fail(error);
    } finally {
      busy = false;
      if (!closed) refresh();
    }
  };

  function View() {
    const activeSession = useTerminalStore(state => state.sessions.find(item => item.sessionId === session.sessionId) ?? null);
    const [, render] = useState(0);
    refresh = () => render(value => value + 1);
    return <div className="flex h-screen min-h-0 flex-col gap-3 p-3">
      <TerminalControllerLayer/>
      <Card size="sm" radius="compact" variant="outline" className="shrink-0">
        <CardHeader>
          <CardTitle>{t('terminal.human.title', {family})}</CardTitle>
          <CardAction><Button disabled={!ready || busy} onClick={event => void verify(event)}>
            {t(step === 'ready' ? 'terminal.human.start' : 'terminal.human.verify')}
          </Button></CardAction>
        </CardHeader>
        <CardContent>
          <p role="status">{message}</p>
          <Button size="sm" variant="outline" disabled={!ready || busy} onClick={event => {
            if (!event.isTrusted || busy) return;
            busy = true;
            refresh();
            void finish(true).catch(fail);
          }}>{t('terminal.human.defer')}</Button>
        </CardContent>
      </Card>
      <div ref={value => {host = value;}} className="min-h-0 flex-1"><TerminalPane activeSession={activeSession} isActive isVisible/></div>
    </div>;
  }
  try {
    root.render(<View/>);
    await until(() => !!capture.controller?.host, 'Actual viewport pane did not attach');
    await controller().whenOutputReady();
    await until(idle, 'Actual viewport native prompt did not become ready');
    const initial = await snapshot();
    assert(isMacFileChainProfile(initial.session?.nativePeerProfile, family), 'Actual viewport Shell profile differs');
    await capture.checkpoint('human-ready', {initial}, true);
    await capture.post({ready: true, progress: 'Viewport ready for operator start', evidence: {
      kind: 'manual-native-display-ready', family, session, initial, operatorActions: 0, humanReceipt: false}});
    ready = true;
    message = t('terminal.human.ready');
    refresh();
  } catch (error) {
    await fail(error);
  }
}
