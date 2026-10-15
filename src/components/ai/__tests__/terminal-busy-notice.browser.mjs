import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const browser = await (process.env.SHELLSPAN_TEST_ENGINE === 'webkit' ? webkit : chromium).launch();
try {
  for (const { locale, action } of ['zh-CN', 'en-US'].flatMap(locale =>
    ['reconnect', 'continue', 'settings'].map(action => ({ locale, action })))) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  const labels = await page.evaluate(async ({ locale, action }) => {
    const source = await (await fetch('/src/hooks/useI18n.ts')).text();
    const reactUrl = source.match(/from "([^"]*\/react\.js\?v=[^"]+)"/)[1];
    const mainSource = await (await fetch('/src/main.tsx')).text();
    const domUrl = mainSource.match(/from "([^"]*\/react-dom_client\.js\?v=[^"]+)"/)[1];
    const { default: React } = await import(reactUrl);
    const { default: ReactDOM } = await import(domUrl);
    const { AiWorkspaceRoot } = await import('/src/components/ai/workspace/ai-workspace-root.tsx');
    const { AgentTerminalBusyNotice } = await import('/src/components/ai/agent-terminal-busy-notice.tsx');
    const { initI18n, t } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    useAppStore.setState({ locale });
    await initI18n(locale);
    const h = React.createElement;
    function Preview() {
      const [direct, setDirect] = React.useState(false);
      const [sent, setSent] = React.useState('');
      const [unavailable, setUnavailable] = React.useState(true);
      return h('main', { className: 'ai-panel-shell p-4', 'data-ai-scope': 'terminal' },
        h(AiWorkspaceRoot, {
          scope: 'terminal', view: null, canStartAgent: true,
          agentUnavailableReason: unavailable ? t('agent.availability.needsTerminal') : null,
          onReconnectTerminal: unavailable && action === 'reconnect' ? () => setUnavailable(false) : undefined,
          onContinueOnReconnectedTerminal: unavailable && action === 'continue' ? () => setUnavailable(false) : undefined,
          onOpenModel: unavailable && action === 'settings' ? () => setUnavailable(false) : undefined,
          historicalContinuationAvailable: true,
          defaultDraft: 'hello', onSubmit: ({ content }) => setSent(content),
          executionSurfaceNotice: direct ? null : h(AgentTerminalBusyNotice, {
            disabled: false, state: 'unavailable', onSwitchDirect: () => setDirect(true),
          }),
        }), h('output', null, sent));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(Preview));
    return { action: t(action === 'reconnect' ? 'ai.workspace.status.reconnect'
      : action === 'continue' ? 'ai.workspace.continueOnReconnectedTerminal' : 'ai.workspace.status.openSettings'),
      direct: t('agent.executionSurface.v1.switchDirect'), notice: t('agent.executionSurface.v1.unavailableDescription') };
  }, { locale, action });
  const notice = page.locator('[data-slot="terminal-busy-notice"]');
  await notice.waitFor({ timeout: 10000 }).catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
  const statusNotices = page.locator('[data-slot="ai-workspace-status-notices"]');
  assert.equal(await statusNotices.evaluate(el => {
    const composer = el.closest('[data-composer-seat]');
    const input = composer?.querySelector('[data-composer-card]');
    return Boolean(input && el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, 'Workspace status notices must be above the input in the composer');
  assert.ok((await notice.textContent()).includes(labels.notice));
  for (const width of [1000, 420, 320]) {
    await page.setViewportSize({ width, height: 640 });
    const fits = await notice.evaluate(el => {
      const box = el.getBoundingClientRect();
      const button = el.querySelector('button').getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && button.right <= box.right && button.bottom <= box.bottom;
    });
    assert.ok(fits, `Notice and action must fit at ${width}px`);
    const noticeWidths = await page.locator('[data-slot="ai-composer-notices"]').evaluate(el => {
      const input = el.parentElement.querySelector('[data-composer-card]').getBoundingClientRect();
      const boxes = [...el.querySelectorAll('[data-slot="ai-workspace-status-notices"] > [data-slot="alert"], [data-slot="terminal-busy-notice"]')]
        .map(notice => notice.getBoundingClientRect());
      return { inputWidth: input.width, inputCenter: input.x + input.width / 2,
        boxes: boxes.map(box => ({ width: box.width, center: box.x + box.width / 2 })) };
    });
    for (const box of noticeWidths.boxes) {
      assert.ok(Math.abs(box.width - (noticeWidths.inputWidth - 16)) < 1,
        `All composer notices share a narrower width at ${width}px`);
      assert.ok(Math.abs(box.center - noticeWidths.inputCenter) < 1, 'Notices stay centered above the input');
    }
    const availability = page.getByRole('status').filter({ has: page.getByRole('button', { name: labels.action, exact: true }) });
    for (const target of [notice, availability]) {
      const geometry = await target.evaluate(el => {
        const box = el.getBoundingClientRect();
        const button = el.querySelector('button').getBoundingClientRect();
        const text = el.querySelector('[data-slot="alert-description"] > span');
        const textBox = text.getBoundingClientRect();
        const icon = el.querySelector(':scope > svg')?.getBoundingClientRect();
        const firstLineCenter = textBox.y + parseFloat(getComputedStyle(text).paddingTop) + parseFloat(getComputedStyle(text).lineHeight) / 2;
        return { height: box.height, buttonHeight: button.height,
          buttonFontSize: getComputedStyle(el.querySelector('button')).fontSize,
          buttonOffset: button.y + button.height / 2 - firstLineCenter,
          iconOffset: icon ? icon.y + icon.height / 2 - firstLineCenter : null,
          gap: icon ? textBox.x - icon.right : null,
          fits: el.scrollWidth <= el.clientWidth && button.right <= box.right && button.bottom <= box.bottom };
      });
      assert.equal(geometry.buttonHeight, 24, `Compact action height at ${width}px`);
      assert.equal(geometry.buttonFontSize, '11px', 'Notice actions use smaller text');
      assert.ok(geometry.fits, `Action must remain inside the notice at ${width}px`);
      if (geometry.iconOffset !== null) {
        assert.equal(geometry.iconOffset, -1, 'Info icon keeps the existing optical correction relative to the first line');
        assert.equal(geometry.gap, 4);
      }
      if (width === 1000) {
        if (locale === 'zh-CN') assert.equal(geometry.height, 38, 'Single-line action notice remains compact');
        assert.equal(geometry.buttonOffset, 0, 'Action and first text line centers match');
      }
      if (width === 320) assert.ok(geometry.height > 38, 'Narrow notices wrap without clipping');
    }
    await page.screenshot({ path: `/tmp/shellspan-terminal-action-notices-${locale}-${action}-${width}.png` });
  }
  await page.getByRole('button', { name: labels.action, exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: labels.action, exact: true }).waitFor({ state: 'detached' });
  const editor = page.locator('[contenteditable="true"]');
  await editor.press('Enter');
  await page.waitForFunction(() => document.querySelector('output')?.textContent === 'hello');
  assert.equal(await notice.count(), 1, 'Chat must remain available when visible commands are unavailable');
  await page.screenshot({ path: '/tmp/shellspan-terminal-busy-notice.png' });
  await page.getByRole('button', { name: labels.direct, exact: true }).click();
  await notice.waitFor({ state: 'detached' });
  await page.close();
  }
} finally {
  await browser.close();
}
