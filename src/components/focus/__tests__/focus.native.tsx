import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FocusLayout } from '../focus-layout';
import { useState } from 'react';
import { TerminalContextMenu } from '@/components/terminal/terminal-context-menu';
import { TerminalControllerLayer } from '@/components/terminal/terminal-controller-layer';
import { TerminalTabBar } from '@/components/terminal/terminal-tab-bar';
import { TerminalCarousel } from '@/components/terminal/terminal-carousel';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { initI18n, t } from '@/locales';
import { invokeCreateLocalSession, invokeCloseSession, invokeCreateAgentRuntimeSession,
  invokeContinueAgentRuntimeOnTarget, invokeGetAgentRuntimeSession, invokeCancelAgentRuntime,
  invokeArchiveAgentRuntimeSession, invokeDeleteAgentRuntimeSession } from '@/lib/ipc/tauri';
import { applyTheme } from '@/lib/theme';
import { useAiDraftStore } from '@/stores/aiDraftStore';
import { sessionRouteKey } from '@/lib/ai/panel-route';
import { useAppStore } from '@/stores/appStore';
import { TitleBar } from '@/components/titlebar/title-bar';
import { useProfileStore } from '@/stores/profileStore';
import { useAppShortcuts } from '@/hooks/useAppShortcuts';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!check()) { assert(Date.now() < deadline, message); await new Promise(r => setTimeout(r, 25)); }
}

// Real production terminal primitives attached to native PTYs. No transport,
// model, terminal controller, session event or connection response is replaced.
function NativeTerminals() {
  const sessions = useTerminalStore(s => s.sessions);
  const active = useTerminalStore(s => s.activeSessionId);
  const [context, setContext] = useState<{ session: TerminalSession; x: number; y: number } | null>(null);
  return <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-native-terminal-root>
    <TerminalControllerLayer />
    <TerminalTabBar onTabActivate={id => useTerminalStore.getState().setActiveSession(id)}
      onTabContextMenu={(session, x, y) => setContext({ session, x, y })} />
    <TerminalContextMenu open={Boolean(context)} session={context?.session ?? null} x={context?.x ?? 0} y={context?.y ?? 0} onClose={() => setContext(null)} />
    <div className="relative min-h-0 flex-1"><TerminalCarousel sessions={sessions} activeSessionId={active} isActive isVisible
      onActivate={id => useTerminalStore.getState().setActiveSession(id)}
      onSettle={id => terminalRegistry.get(id)?.focus()} /></div>
  </div>;
}

function NativeFocusWorkspace() {
  useAppShortcuts();
  return <><TitleBar /><FocusLayout><NativeTerminals /></FocusLayout></>;
}

async function verify() {
  await initI18n('zh-CN');
  applyTheme('light');
  const host = document.getElementById('root')!;
  let root = createRoot(host);
  const terminalIds: string[] = [];
  const closedTerminals = new Set<string>();
  const agentIds: string[] = [];
  const unique = crypto.randomUUID();
  try {
    await useProfileStore.getState().hydrateFromDb();
    flushSync(() => root.render(<NativeFocusWorkspace />));
    flushSync(() => useFocusStore.getState().enter());
    await eventually(() => host.querySelectorAll('[data-slot="focus-start-notice"]').length === 1, 'Missing single focus onboarding notice');
    const checkStartNoticeStyle = () => {
      const notice = host.querySelector<HTMLElement>('[data-slot="focus-start-notice"]')!;
      const action = notice.querySelector<HTMLButtonElement>('button')!;
      const description = notice.querySelector<HTMLElement>('[data-slot="alert-description"]')!;
      const text = description.querySelector<HTMLElement>(':scope > span')!;
      const icon = notice.querySelector<SVGElement>(':scope > svg')!;
      const actionStyle = getComputedStyle(action);
      assert(actionStyle.fontSize === '11px' && action.getBoundingClientRect().height === 24, 'Focus notice action differs from the existing compact Agent notices');
      assert(actionStyle.borderTopWidth === '0px', 'Focus notice action added an outline absent from similar notices');
      assert(getComputedStyle(description).alignItems === 'flex-start', 'Focus notice uses different text/action alignment');
      assert(Math.abs(icon.getBoundingClientRect().top - text.getBoundingClientRect().top - parseFloat(getComputedStyle(text).paddingTop)) <= 1, 'Focus notice icon does not align with its first text line');
      const noticeBox = notice.getBoundingClientRect();
      const actionBox = action.getBoundingClientRect();
      assert(actionBox.left >= noticeBox.left && actionBox.right <= noticeBox.right, 'Focus notice action overflows a narrow panel');
    };
    const initialContainer = host.querySelector<HTMLElement>('.focus-layout')!;
    for (const width of [1280, 400, 320]) {
      initialContainer.style.width = `${Math.min(width, innerWidth)}px`;
      await new Promise(r => setTimeout(r, 100));
      checkStartNoticeStyle();
    }
    assert(!host.textContent?.includes(t('agent.availability.needsTerminal')), 'Focus duplicates the generic terminal availability notice');
    assert(host.querySelector('[data-slot="focus-start-notice"]')?.textContent?.includes(t('focus.connectFirst')), 'Empty focus does not explain how to start');
    let connectRequested = false;
    const observeConnect = () => { connectRequested = true; };
    document.addEventListener('shellspan:new-terminal-tab', observeConnect);
    try { flushSync(() => (host.querySelector('[data-slot="focus-start-notice"] button') as HTMLButtonElement).click()); }
    finally { document.removeEventListener('shellspan:new-terminal-tab', observeConnect); }
    assert(connectRequested && useFocusStore.getState().terminalOpen, 'Focus onboarding did not open terminal creation');
    for (let index = 0; index < 3; index++) {
      const summary = await invokeCreateLocalSession(100, 25);
      terminalIds.push(summary.sessionId);
      flushSync(() => useTerminalStore.getState().addSession(summary));
    }
    await eventually(() => useTerminalStore.getState().sessions.every(s => s.status === 'connected'), 'Native PTYs did not become connected');
    const offeredTerminal = useTerminalStore.getState().activeSessionId;
    await eventually(() => host.querySelector('[data-slot="focus-start-notice"] button')?.textContent?.trim() === t('focus.useTerminal'), 'Connected terminal was not offered as a target');
    checkStartNoticeStyle();
    flushSync(() => (host.querySelector('[data-slot="focus-start-notice"] button') as HTMLButtonElement).click());
    assert(useFocusStore.getState().targetSessionId === offeredTerminal, 'Onboarding adopted a different terminal from the one displayed');
    await eventually(() => !host.querySelector('[data-slot="focus-start-notice"]'), 'Focus onboarding did not clear after selecting a target');
    await eventually(() => Boolean(host.querySelector('[data-slot="focus-terminal-header"] [data-slot="focus-controls"]')), 'Focus controls missing from terminal header');
    assert(!host.querySelector('[data-slot="titlebar-actions"] [data-slot="focus-controls"]'), 'Terminal toggle still occupies the titlebar');
    assert(!host.querySelector('[data-slot="focus-terminal-target"]'), 'The redundant target toolbar must be removed');
    assert(!host.querySelector('[data-slot="ai-workspace-header"] [data-slot="focus-target-selector"]'), 'Agent target selection still occupies the conversation header');
    assert(!host.querySelector('[data-slot="titlebar-actions"] [data-slot="focus-target-selector"]'), 'Agent target selection still occupies the titlebar');
    assert(getComputedStyle(host.querySelector('[data-slot="focus-agent"]')!).getPropertyValue('--ai-text').trim(), 'Focus did not inherit the Agent design tokens');
    assert(useFocusStore.getState().setTarget(terminalIds[0]), 'Cannot explicitly adopt first terminal');
    flushSync(() => { assert(useFocusStore.getState().setTarget(terminalIds[2]), 'Cannot adopt a newer explicit target'); });
    flushSync(() => useFocusStore.getState().leave());
    assert(!useFocusStore.getState().setTarget(terminalIds[1]), 'An Agent target changed outside focus mode');
    flushSync(() => useFocusStore.getState().enter());
    flushSync(() => { assert(useFocusStore.getState().setTarget(terminalIds[0]), 'Cannot restore first explicit target'); });
    const controllers = terminalIds.map(id => terminalRegistry.get(id));
    flushSync(() => useTerminalStore.getState().setActiveSession(terminalIds[1]));
    const switchingContainer = host.querySelector<HTMLElement>('.focus-layout')!;
    for (const width of [1280, 400]) {
      switchingContainer.style.width = `${Math.min(width, innerWidth)}px`;
      await new Promise(r => setTimeout(r, 160));
      for (const enabled of [false, true, false, true]) {
        flushSync(() => enabled ? useFocusStore.getState().enter() : useFocusStore.getState().leave());
        const controller = terminalRegistry.get(useTerminalStore.getState().activeSessionId!)!;
        const expected = controller.fitAddon.proposeDimensions();
        assert(expected && controller.terminal.cols === expected.cols && controller.terminal.rows === expected.rows,
          `Workspace switch painted a stale terminal grid: ${width}/${enabled}`);
        const dimensions = { cols: controller.terminal.cols, rows: controller.terminal.rows };
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const carousel = host.querySelector<HTMLElement>('[data-terminal-carousel]')!;
        const activePage = carousel.querySelector<HTMLElement>(`[data-terminal-carousel-page="${controller.sessionId}"]`)!;
        assert(Math.abs(activePage.getBoundingClientRect().left - carousel.getBoundingClientRect().left) <= 1,
          'Workspace switch displaced the active carousel page');
        await new Promise(r => setTimeout(r, 160));
        assert(controller.terminal.cols === dimensions.cols && controller.terminal.rows === dimensions.rows,
          'Workspace switch resized the terminal again after painting');
        for (let index = 0; index < terminalIds.length; index++) assert(terminalRegistry.get(terminalIds[index]) === controllers[index], 'Workspace switch replaced a terminal controller');
      }
    }
    switchingContainer.style.width = '';
    flushSync(() => useTerminalStore.getState().setActiveSession(terminalIds[1]));
    assert(useFocusStore.getState().targetSessionId === terminalIds[0], 'Viewing another tab changed Agent target');
    const assertMatchingHeaders = () => {
      const left = host.querySelector<HTMLElement>('[data-slot="ai-workspace-header"]')!;
      const right = host.querySelector<HTMLElement>('[data-slot="focus-terminal-header"]')!;
      assert(left.getBoundingClientRect().height === 40 && right.getBoundingClientRect().height === 40, 'Focus panel headers must both remain 40px high');
      assert(getComputedStyle(left).borderBottomColor === getComputedStyle(right).borderBottomColor, 'Focus panel header borders use different colors');
      assert(getComputedStyle(left).borderBottomWidth === getComputedStyle(right).borderBottomWidth, 'Focus panel header borders use different widths');
    };
    assertMatchingHeaders();
    const serverHeader = host.querySelector<HTMLElement>('[data-slot="focus-terminal-header"]')!;
    assert(serverHeader.textContent?.includes(useTerminalStore.getState().sessions.find(s => s.sessionId === terminalIds[1])!.title), 'Server header does not show the viewed terminal');
    const headerAdopt = Array.from(serverHeader.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === t('focus.setTarget'));
    assert(headerAdopt, 'Server header has no explicit Agent target action');
    flushSync(() => headerAdopt.click());
    assert(useFocusStore.getState().targetSessionId === terminalIds[1], 'Server header did not set the viewed terminal as Agent target');
    const serverName = serverHeader.querySelector('h2')!;
    const targetBadge = serverHeader.querySelector('[data-slot="badge"]')!;
    assert(serverName.parentElement === targetBadge.parentElement, 'Agent target badge must share the server name row');
    assert(Math.abs(targetBadge.getBoundingClientRect().left - serverName.getBoundingClientRect().right - 4) <= 1, 'Agent target badge must sit beside the server name');
    flushSync(() => { useFocusStore.getState().setTarget(terminalIds[0]); useTerminalStore.getState().setActiveSession(terminalIds[1]); });
    const openTargetMenu = (id: string) => {
      const tab = host.querySelector<HTMLElement>(`[data-session-tab="${id}"]`)!;
      flushSync(() => tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })));
    };
    openTargetMenu(terminalIds[1]);
    const adopt = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b => b.textContent?.trim() === t('focus.setTarget'));
    assert(adopt, 'Explicit adoption action missing');
    flushSync(() => adopt.click());
    assert(useFocusStore.getState().targetSessionId === terminalIds[1], 'Adoption did not switch target');
    const tabTarget = host.querySelector<HTMLElement>(`[data-session-tab="${terminalIds[1]}"] [data-slot="focus-tab-target"]`)!;
    assert(tabTarget?.getAttribute('aria-label') === t('focus.agentTarget'), 'Target tab icon lacks a readable label');
    assert(tabTarget.getBoundingClientRect().width === 16, 'Target tab indicator must remain compact');
    assert(!tabTarget.closest('[data-session-tab]')!.querySelector('[data-slot="badge"]'), 'Target tab still contains a wide text badge');
    assert(!host.querySelector('[data-slot="agent-execution-surface-trigger-content"]'), 'Focus must not offer execution modes');
    const toggleTerminal = () => {
      const label = t(useFocusStore.getState().terminalOpen ? 'focus.collapseTerminal' : 'focus.expandTerminal');
      const header = useFocusStore.getState().terminalOpen ? 'focus-terminal-header' : 'ai-workspace-header';
      const button = host.querySelector<HTMLButtonElement>(`[data-slot="${header}"] [data-slot="focus-controls"] button`);
      assert(button?.getAttribute('aria-label') === label && button.getBoundingClientRect().width > 0, 'The panel terminal toggle is inaccessible');
      flushSync(() => button.click());
    };
    toggleTerminal();
    assert(getComputedStyle(host.querySelector('[data-slot="focus-terminal"]')!).display === 'none', 'Terminal collapse failed');
    const collapsedActions = host.querySelector('.ai-session-actions')!;
    const historyAction = collapsedActions.querySelector<HTMLButtonElement>(`button[aria-label="${t('ai.history')}"]`)!;
    const expandAction = collapsedActions.querySelector('[data-slot="focus-controls"] button')!;
    assert(historyAction.getBoundingClientRect().right <= expandAction.getBoundingClientRect().left, 'Terminal expand action must follow history');
    toggleTerminal();
    for (let index = 0; index < terminalIds.length; index++) assert(terminalRegistry.get(terminalIds[index]) === controllers[index], 'Collapse replaced a terminal controller');
    const targetBeforeShortcut = useFocusStore.getState().targetSessionId;
    const viewBeforeShortcut = useTerminalStore.getState().activeSessionId;
    let newTabRequested = false;
    const observeNewTab = () => { newTabRequested = true; };
    document.addEventListener('shellspan:new-terminal-tab', observeNewTab);
    try {
      flushSync(() => useFocusStore.getState().setTerminalOpen(false));
      flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })));
      assert(newTabRequested && useFocusStore.getState().terminalOpen, 'New-terminal shortcut left the focus terminal panel hidden');
      flushSync(() => useFocusStore.getState().setTerminalOpen(false));
      flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })));
      assert(useFocusStore.getState().terminalOpen && useTerminalStore.getState().activeSessionId !== viewBeforeShortcut, 'Terminal navigation shortcut did not reveal the next terminal');
      assert(useFocusStore.getState().targetSessionId === targetBeforeShortcut, 'Terminal navigation shortcut changed the Agent target');
      flushSync(() => useTerminalStore.getState().setActiveSession(viewBeforeShortcut));
    } finally { document.removeEventListener('shellspan:new-terminal-tab', observeNewTab); }
    assert(!useAppStore.getState().initialized, 'Validation must not change persisted user preferences');
    for (const locale of ['zh-CN', 'en-US'] as const) {
    flushSync(() => useAppStore.setState({ locale }));
    await initI18n(locale);
    for (const theme of ['light', 'dark'] as const) {
    applyTheme(theme);
    for (const width of [1280, 800, 400]) {
      const focusContainer = host.querySelector<HTMLElement>('.focus-layout')!;
      focusContainer.style.width = `${Math.min(width, innerWidth)}px`;
      await new Promise(r => setTimeout(r, 150));
      const agent = host.querySelector('[data-slot="focus-agent"]')!.getBoundingClientRect();
      const terminal = host.querySelector('[data-slot="focus-terminal"]')!.getBoundingClientRect();
      assert(focusContainer.scrollWidth <= focusContainer.clientWidth + 1, `Focus overflows its container: ${locale}/${theme}/${width}`);
      assert(agent.height > 100 && terminal.height > 100, 'Focus height chain collapsed');
      if (focusContainer.clientWidth > 700) assert(terminal.left >= agent.right - 1, 'Wide focus is not two columns');
      else assert(terminal.top >= agent.bottom - 1, 'Narrow focus does not stack');
      if (focusContainer.clientWidth > 700) {
        const before = useFocusStore.getState().split;
        flushSync(() => host.querySelector('[data-slot="focus-divider"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
        assert(useFocusStore.getState().split < before, 'Keyboard resize did not update the split');
        assert(host.querySelector('[data-slot="focus-agent"]')!.getBoundingClientRect().width < agent.width, 'Resizing did not change the rendered column');
      }
      const terminalToggle = host.querySelector<HTMLButtonElement>('[data-slot="focus-controls"] button[aria-expanded]');
      assert(terminalToggle, 'Focus terminal toggle is missing');
      assert(!host.querySelector('[data-slot="focus-target-selector"]'), 'The redundant target selector must be removed');
      const sessionHeader = host.querySelector<HTMLElement>('[data-slot="ai-workspace-header"]')!;
      const sessionHeaderBox = sessionHeader.getBoundingClientRect();
      const terminalHeader = host.querySelector<HTMLElement>('[data-slot="focus-terminal-header"]')!;
      const terminalHeaderBox = terminalHeader.getBoundingClientRect();
      assertMatchingHeaders();
      if (focusContainer.clientWidth > 700) assert(Math.abs(sessionHeaderBox.bottom - terminalHeaderBox.bottom) <= 1, 'Focus panel header bottom edges do not align');
      assert(sessionHeaderBox.height === 40, 'Conversation header height changed');
      const resizedTerminal = host.querySelector('[data-slot="focus-terminal"]')!.getBoundingClientRect();
      assert(terminalHeaderBox.left >= resizedTerminal.left && terminalHeaderBox.right <= resizedTerminal.right, 'Terminal tabs overflow the panel');
      const tabStripBox = host.querySelector('[data-terminal-tab-bar]')!.getBoundingClientRect();
      assert(tabStripBox.height === 32 && Math.abs(tabStripBox.top - terminalHeaderBox.bottom) <= 1, 'Compact terminal tabs must form a separate row below the server header');
      const targetBeforeMenu = useFocusStore.getState().targetSessionId;
      openTargetMenu(terminalIds[0]);
      await eventually(() => Boolean(document.querySelector('[role="menu"]')), 'Tab context menu did not open');
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
      const menuBox = menu.getBoundingClientRect();
      assert(menuBox.left >= 0 && menuBox.right <= innerWidth, 'Target menu extends beyond the viewport');
      assert(menu.scrollWidth <= menu.clientWidth + 1, 'Target menu has horizontal overflow');
      assert(Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).some(b => b.textContent?.trim() === t('focus.setTarget') && !b.disabled), 'Explicit Agent target action is missing');
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      await eventually(() => !document.querySelector('[role="menu"]'), 'Escape did not close the tab context menu');
      assert(useFocusStore.getState().targetSessionId === targetBeforeMenu, 'Opening the target menu changed the Agent target');
      assert(!host.querySelector('[data-slot="focus-header"]'), 'Focus must not reserve a separate page header');
      assert(Math.abs(agent.top - focusContainer.getBoundingClientRect().top) <= 1, 'A redundant header still consumes conversation height');
      assert(getComputedStyle(terminalToggle).columnGap === '4px', 'Terminal action differs from the system icon spacing');
      const headerActions = host.querySelector('[data-slot="titlebar-actions"]')!;
      assert(headerActions.scrollWidth <= headerActions.clientWidth + 1, `Focus controls overflow their action row: ${locale}/${theme}/${width}`);
      const controlsBox = host.querySelector('[data-slot="focus-controls"]')!.getBoundingClientRect();
      assert(controlsBox.top >= terminalHeaderBox.top && controlsBox.bottom <= terminalHeaderBox.bottom, 'Focus controls overflow the terminal header');
      assert(Math.abs(terminalToggle.getBoundingClientRect().height - 28) <= 1, 'Terminal toggle differs from the shared panel action size');
      const navButtons = host.querySelectorAll('nav button');
      assert(navButtons.length === 4, 'The shared navigation should expose four workspaces');
      assert(Array.from(navButtons).every(button => Math.abs(button.getBoundingClientRect().height - navButtons[0].getBoundingClientRect().height) <= 1), 'Focus navigation differs from the system navigation height');
      if (focusContainer.clientWidth > 700) {
        const divider = host.querySelector('[data-slot="focus-divider"]')!;
        assert(divider.getBoundingClientRect().width === 1, 'Focus divider differs from the system one-pixel boundary');
        assert(getComputedStyle(divider, '::after').width === '4px', 'Focus divider differs from the system hover indicator');
        const firstTab = host.querySelector<HTMLElement>(`[data-session-tab="${terminalIds[0]}"]`)!;
        const secondTab = host.querySelector<HTMLElement>(`[data-session-tab="${terminalIds[1]}"]`)!;
        const originalTabWidth = firstTab.getBoundingClientRect().width;
        flushSync(() => useTerminalStore.getState().setActiveSession(terminalIds[0]));
        assert(firstTab.getAttribute('aria-selected') === 'true', 'The first terminal tab did not activate');
        const firstTabStyle = getComputedStyle(firstTab);
        assert(firstTab.getBoundingClientRect().height === 32, 'Focus terminal tabs are not compact');
        assert(firstTabStyle.borderLeftColor === 'rgba(0, 0, 0, 0)', 'The first selected tab doubles the pane divider');
        assert(firstTabStyle.borderLeftWidth === '1px' && firstTab.getBoundingClientRect().width === originalTabWidth, 'The leading-border fix shifted tab geometry');
        assert(Math.abs(firstTab.getBoundingClientRect().left - divider.getBoundingClientRect().right) <= 1, 'The first tab does not meet the pane divider');
        flushSync(() => useTerminalStore.getState().setActiveSession(terminalIds[1]));
        await eventually(() => getComputedStyle(secondTab).borderLeftColor !== firstTabStyle.borderLeftColor, 'A non-leading active tab lost its left border');
        assert(getComputedStyle(secondTab).borderLeftWidth === '1px', 'The non-leading tab boundary changed width');
      }
    }
    }
    }
    const source = `focus-agent-native-${unique}`;
    agentIds.push(source);
    const sourceRequest = { sessionId: source, taskId: `focus-task-${unique}`, goal: 'Validate focus target binding without model calls', executionSurface: 'boundTerminal' as const,
      target: { kind: 'local' as const, targetId: `terminal-${terminalIds[0]}`, sessionId: terminalIds[0] } };
    const original = await invokeCreateAgentRuntimeSession(sourceRequest);
    const continued = `focus-agent-continued-${unique}`;
    agentIds.unshift(continued);
    const next = await invokeContinueAgentRuntimeOnTarget({ ...sourceRequest, sessionId: continued, taskId: `focus-next-${unique}`, continuedFromSessionId: source,
      target: { kind: 'local', targetId: `terminal-${terminalIds[1]}`, sessionId: terminalIds[1] } });
    assert(next.header.target?.sessionId === terminalIds[1] && next.header.continuedFromSessionId === source, 'Target continuation IPC lost identity');
    assert(JSON.stringify(await invokeGetAgentRuntimeSession({ sessionId: source })) === JSON.stringify(original), 'Continuation mutated source session');
    root.unmount();
    useFocusStore.getState().setConversation(continued);
    const draft = 'Review the current target without executing commands';
    useAiDraftStore.getState().saveDraft(sessionRouteKey('agent', continued), draft);
    root = createRoot(host);
    flushSync(() => root.render(<NativeFocusWorkspace />));
    await eventually(() => host.querySelector('[data-slot="ai-workspace-root"]')?.getAttribute('data-session-id') === continued, 'Remount lost the exact focus conversation');
    await eventually(() => host.querySelector('[data-composer-editor]')?.textContent === draft, 'Remount lost the session draft');
    assert(useFocusStore.getState().conversationSessionId === continued, 'Remount cleared the remembered conversation');
    flushSync(() => useFocusStore.getState().leave());
    flushSync(() => useFocusStore.getState().enter());
    assert(useFocusStore.getState().targetSessionId === terminalIds[1], 'Focus return lost explicit target');
    await invokeCloseSession(terminalIds[1]);
    closedTerminals.add(terminalIds[1]);
    flushSync(() => useTerminalStore.getState().removeSession(terminalIds[1]));
    assert(useFocusStore.getState().targetSessionId === terminalIds[1], 'Removing the target implicitly adopted another host');
    await eventually(() => Boolean(host.querySelector('[data-slot="focus-start-notice"]')?.textContent?.includes(t('focus.targetClosed'))), 'Closing the target must explain that the Agent target was closed');
    assert(!host.textContent?.includes(t('agent.availability.needsTerminal')), 'Closing the target must not ask to open an already connected terminal');
    const recoveryNotice = host.querySelector<HTMLElement>('[data-slot="focus-start-notice"]')!;
    assert(recoveryNotice.textContent?.includes(t('focus.useTerminalHint', { terminal: useTerminalStore.getState().sessions.find(s => s.sessionId === useTerminalStore.getState().activeSessionId)!.title })), 'Recovery must identify the connected replacement terminal');
    assert(recoveryNotice.querySelector('button')?.textContent?.includes(t('focus.useTerminal')), 'Closing the target must offer explicit target selection');
    checkStartNoticeStyle();
    await invokeCloseSession(terminalIds[2]);
    closedTerminals.add(terminalIds[2]);
    flushSync(() => useTerminalStore.getState().removeSession(terminalIds[2]));
    const previousHideSingle = useAppStore.getState().terminalHideSingleTabBar;
    try {
      flushSync(() => useAppStore.setState({ terminalHideSingleTabBar: true }));
      assert(host.querySelector('[data-terminal-tab-bar]')!.getBoundingClientRect().height === 32, 'Focus hid the only tab and made target selection unreachable');
    } finally { flushSync(() => useAppStore.setState({ terminalHideSingleTabBar: previousHideSingle })); }
  } finally {
    root.unmount();
    for (const id of terminalIds) { try { if (!closedTerminals.has(id)) await invokeCloseSession(id); } finally { terminalRegistry.dispose(id); } }
    for (const id of agentIds) {
      try { await invokeCancelAgentRuntime({ sessionId: id }); await invokeArchiveAgentRuntimeSession({ sessionId: id }); await invokeDeleteAgentRuntimeSession({ sessionId: id }); }
      catch (error) { console.error('Focus regression cleanup failed', error); }
    }
  }
}
const token = new URL(location.href).searchParams.get('token');
void verify().then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }))
  .then(result => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(result) }));
