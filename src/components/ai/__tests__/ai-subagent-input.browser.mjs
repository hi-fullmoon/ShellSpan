import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// Render the actual composer states without a model, IPC stubs or session data.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/subagent-input', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/subagent-input', '<html><body></body></html>'));
});
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/subagent-input`);
  await page.evaluate(async () => {
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiComposerSeat } = await import('/src/components/ai/workspace/ai-composer-seat.tsx');
    const { initI18n, t } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const host = document.createElement('main');
    host.className = 'ai-panel-shell @container/ai-workspace';
    host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;justify-content:end;background:var(--background)';
    document.body.append(host);
    const root = ReactDOM.createRoot(host);
    let inputMode = 'supplement';
    let blocked = false;
    let draft = '';
    const sent = [];
    const render = () => root.render(React.createElement(AiComposerSeat, {
      phase: 'active', status: 'idle', inputMode, draft,
      unavailableReason: blocked ? t('ai.error.invalidModelSelection') : null,
      availabilityHintId: 'subagent-input-blocker',
      onDraftChange: value => { draft = value; render(); },
      onSubmit: value => sent.push(value),
    }));
    globalThis.subagentInputCheck = {
      async locale(locale) { useAppStore.setState({ locale }); await initI18n(locale); render(); },
      show(mode, unavailable = false) { inputMode = mode; blocked = unavailable; render(); },
      sent,
    };
  });
  const editor = page.getByTestId('ai-workspace-composer');
  for (const locale of ['zh-CN', 'en-US']) {
    await page.evaluate(locale => globalThis.subagentInputCheck.locale(locale), locale);
    for (const width of [1000, 480, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => globalThis.subagentInputCheck.show('supplement'));
      await editor.waitFor();
      assert.equal(await page.getByRole('button', { name: locale === 'zh-CN' ? '补充指令' : 'Add instructions', exact: true }).count(), 0);
      assert.equal(await editor.getAttribute('aria-label'), locale === 'zh-CN' ? '补充给子代理的指令…' : 'Add instructions for this subagent…');
      assert.equal(await editor.getAttribute('contenteditable'), 'true');
      const bounds = await editor.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 800);
      // Use the visible localized prompt to exercise ordinary keyboard input.
      const draft = await editor.getAttribute('aria-label');
      await editor.fill(draft);
      await editor.press('Enter');
      assert.equal(await page.evaluate(() => globalThis.subagentInputCheck.sent.at(-1)), draft);
      await page.screenshot({ path: `/tmp/shellspan-subagent-input-${locale}-${width}.png` });
      await page.evaluate(() => globalThis.subagentInputCheck.show('supplement', true));
      await page.locator('#subagent-input-blocker').waitFor();
      assert.equal(await editor.getAttribute('aria-disabled'), 'true');
      assert.equal(await editor.getAttribute('contenteditable'), 'false');
      assert.equal(await page.locator('.ai-composer-primary').isDisabled(), true);
      assert.equal(await editor.textContent(), draft);
      await page.screenshot({ path: `/tmp/shellspan-subagent-input-disabled-${locale}-${width}.png` });
      await page.evaluate(() => globalThis.subagentInputCheck.show('hidden'));
      await editor.waitFor({ state: 'detached' });
      assert.equal(await page.locator('[data-composer-card]').count(), 0);
      assert.equal(await page.locator('[data-slot="ai-composer-disclaimer"]').count(), 0);
      await page.evaluate(() => globalThis.subagentInputCheck.show('supplement'));
      await editor.waitFor();
      assert.equal(await editor.getAttribute('contenteditable'), 'true');
      assert.equal(await editor.textContent(), draft, 'Restoring input preserves the draft');
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
