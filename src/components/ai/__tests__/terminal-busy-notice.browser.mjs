import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const source = await (await fetch('/src/hooks/useI18n.ts')).text();
    const reactUrl = source.match(/from "([^"]*\/react\.js\?v=[^"]+)"/)[1];
    const mainSource = await (await fetch('/src/main.tsx')).text();
    const domUrl = mainSource.match(/from "([^"]*\/react-dom_client\.js\?v=[^"]+)"/)[1];
    const { default: React } = await import(reactUrl);
    const { default: ReactDOM } = await import(domUrl);
    const { AiWorkspaceRoot } = await import('/src/components/ai/workspace/ai-workspace-root.tsx');
    const { AgentTerminalBusyNotice } = await import('/src/components/ai/agent-terminal-busy-notice.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    await initI18n('zh-CN');
    const h = React.createElement;
    function Preview() {
      const [direct, setDirect] = React.useState(false);
      const [sent, setSent] = React.useState('');
      return h('main', { className: 'ai-panel-shell p-4', 'data-ai-scope': 'terminal' },
        h(AiWorkspaceRoot, {
          scope: 'terminal', view: null, canStartAgent: true,
          historicalContinuationAvailable: true,
          defaultDraft: 'hello', onSubmit: ({ content }) => setSent(content),
          executionSurfaceNotice: direct ? null : h(AgentTerminalBusyNotice, {
            disabled: false, onSwitchDirect: () => setDirect(true),
          }),
        }), h('output', null, sent));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(Preview));
  });
  const notice = page.locator('[data-slot="terminal-busy-notice"]');
  await notice.waitFor({ timeout: 10000 }).catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
  const statusNotices = page.locator('[data-slot="ai-workspace-status-notices"]');
  assert.equal(await statusNotices.evaluate(el => {
    const composer = el.closest('[data-composer-seat]');
    const input = composer?.querySelector('[data-composer-card]');
    return Boolean(input && el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, 'Workspace status notices must be above the input in the composer');
  assert.match(await notice.textContent(), /可以继续聊天/);
  for (const width of [720, 360]) {
    await page.setViewportSize({ width, height: 640 });
    const fits = await notice.evaluate(el => {
      const box = el.getBoundingClientRect();
      const button = el.querySelector('button').getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && button.right <= box.right && button.bottom <= box.bottom;
    });
    assert.ok(fits, `Notice and action must fit at ${width}px`);
  }
  const editor = page.locator('[contenteditable="true"]');
  await editor.press('Enter');
  await page.waitForFunction(() => document.querySelector('output')?.textContent === 'hello');
  assert.equal(await notice.count(), 1, 'Chat must remain available while busy');
  await page.screenshot({ path: '/tmp/shellspan-terminal-busy-notice.png' });
  await page.getByRole('button', { name: '切换直接执行', exact: true }).click();
  await notice.waitFor({ state: 'detached' });
} finally {
  await browser.close();
}
