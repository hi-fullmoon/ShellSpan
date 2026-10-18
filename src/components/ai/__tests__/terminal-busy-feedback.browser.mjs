import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/terminal-busy-feedback', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/terminal-busy-feedback', '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/terminal-busy-feedback.browser-entry.tsx"></script></body></html>'));
});
await server.listen();
const browser = await (process.env.SHELLSPAN_TEST_ENGINE === 'webkit' ? webkit : chromium).launch();
try {
  for (const locale of ['en-US', 'zh-CN']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/terminal-busy-feedback`);
    const labels = await page.evaluate(async locale => {
      const entry = await import('/src/components/ai/__tests__/terminal-busy-feedback.browser-entry.tsx');
      return entry.initialize(locale);
    }, locale);
    const show = state => page.evaluate(async state => {
      const entry = await import('/src/components/ai/__tests__/terminal-busy-feedback.browser-entry.tsx');
      entry.show({ terminal: 'a', generation: 1, ...state });
    }, state);
    const notice = page.locator('[data-slot="terminal-busy-notice"]');
    await show({ state: 'ready' });
    const input = page.locator('[data-composer-card]');
    const before = await input.boundingBox();
    await show({ state: 'busy' });
    await page.waitForTimeout(100);
    assert.equal(await notice.count(), 0, 'Short commands must not display a notice');
    assert.deepEqual(await input.boundingBox(), before, 'Short commands must not move the composer');
    await show({ state: 'ready' });
    await page.waitForTimeout(1050);
    assert.equal(await notice.count(), 0, 'Returning to the prompt keeps feedback hidden');

    await show({ state: 'busy' });
    await page.waitForTimeout(1100);
    assert.equal(await notice.count(), 0, 'Sustained terminal activity must remain silent');
    for (const width of [960, 420, 320]) {
      await page.setViewportSize({ width, height: 520 });
      const busyBox = await input.boundingBox();
      await show({ state: 'ready' });
      assert.deepEqual(await input.boundingBox(), busyBox, `Terminal activity must not move the composer at ${width}px`);
      await show({ state: 'busy' });
      await page.screenshot({ path: `/tmp/shellspan-busy-passive-${locale}-${width}.png` });
    }
    await page.locator('[contenteditable="true"]').press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.sent), 'true', 'Chat remains available during terminal activity');

    await show({ state: 'busy', blockedAttempt: 'new-attempt' });
    assert.ok((await notice.textContent()).includes(labels.blocked));
    const button = notice.getByRole('button', { name: labels.direct, exact: true });
    for (const width of [960, 420, 320]) {
      await page.setViewportSize({ width, height: 520 });
      const fits = await notice.evaluate(el => {
        const bounds = el.getBoundingClientRect();
        const button = el.querySelector('button').getBoundingClientRect();
        return el.scrollWidth <= el.clientWidth && button.right <= bounds.right && button.bottom <= bounds.bottom && button.height === 24;
      });
      assert.ok(fits, `Blocked feedback and compact action fit at ${width}px`);
      await page.screenshot({ path: `/tmp/shellspan-busy-blocked-${locale}-${width}.png` });
    }
    await button.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.switched), 'true');
    await show({ state: 'busy', blockedAttempt: 'new-attempt', locked: true });
    assert.equal(await button.isDisabled(), true, 'Runtime locks still apply');

    await show({ state: 'ready' });
    assert.equal(await notice.count(), 0, 'Ready state hides the notice immediately');
    await show({ state: 'busy' });
    await page.waitForTimeout(700);
    await show({ state: 'busy', terminal: 'b' });
    await page.waitForTimeout(400);
    assert.equal(await notice.count(), 0, 'Switching terminals keeps ordinary activity silent');
    await show({ state: 'busy', terminal: 'b', generation: 2 });
    await page.waitForTimeout(700);
    assert.equal(await notice.count(), 0, 'Reconnecting keeps ordinary activity silent');
    await page.waitForTimeout(400);
    assert.equal(await notice.count(), 0, 'Reconnected terminal activity stays silent');
    await show({ state: 'unavailable' });
    assert.ok((await notice.textContent()).includes(labels.unavailable), 'Unavailable state is distinct and immediate');
    const showContention = blocked => page.evaluate(async blocked => {
      const entry = await import('/src/components/ai/__tests__/terminal-busy-feedback.browser-entry.tsx');
      entry.showContention(blocked);
    }, blocked);
    await showContention(true);
    const warning = page.locator('[data-slot="ai-workspace-status-notices"] [role="status"]');
    await warning.waitFor();
    assert.equal(await warning.evaluate(el => el.classList.contains('text-app-warning')), true);
    const send = page.locator('.ai-composer-primary');
    assert.equal(await send.isDisabled(), true, 'Contention disables sending before a submission');
    await page.locator('[data-composer-editor]').press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.contentionSent), undefined);
    for (const width of [960, 420, 320]) {
      await page.setViewportSize({ width, height: 640 });
      assert.equal(await warning.evaluate(el => el.scrollWidth <= el.clientWidth), true, `Contention warning fits at ${width}px`);
      await page.screenshot({ path: `/tmp/shellspan-contention-warning-${locale}-${width}.png` });
    }
    await showContention(false);
    assert.equal(await warning.count(), 0, 'Release clears the warning');
    assert.equal(await send.isEnabled(), true, 'Release restores manual sending');
    assert.equal(await page.evaluate(() => document.body.dataset.contentionSent), undefined, 'Release must not automatically send the draft');
    assert.equal(await page.locator('[data-composer-editor]').innerText(), 'hello');
    await send.click();
    assert.equal(await page.evaluate(() => document.body.dataset.contentionSent), 'hello');
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
