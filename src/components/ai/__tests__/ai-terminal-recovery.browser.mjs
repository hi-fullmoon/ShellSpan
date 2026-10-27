import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-terminal-recovery-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__recovery', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__recovery', '<html><body></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        for (const locale of ['zh-CN', 'en-US']) {
          const page = await browser.newPage({ viewport: { width, height: 720 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__recovery`);
          await page.evaluate(async locale => {
            const { mount } = await import('/src/components/ai/__tests__/ai-conversation-status.browser.tsx');
            const host = document.createElement('main');
            host.className = 'ai-panel-shell ai-workspace-root @container/ai-workspace';
            host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column';
            document.body.append(host);
            window.recovery = await mount(host, locale);
            window.recovery.recovery('waiting');
          }, locale);
          const notice = page.locator('[data-terminal-recovery-notice]');
          await notice.waitFor({ state: 'visible' });
          const stop = notice.getByRole('button', { name: locale === 'zh-CN' ? '停止任务' : 'Stop task', exact: true });
          const reconnect = notice.getByRole('button', { name: locale === 'zh-CN' ? '重新连接终端' : 'Reconnect terminal', exact: true });
          assert.ok((await notice.textContent()).includes(locale === 'zh-CN' ? '原命令可能已经执行' : 'The original command may still have run'));
          assert.equal(await reconnect.isDisabled(), true);
          assert.equal(await page.locator('[data-slot="ai-workspace-status-notices"] [data-slot="alert"]').count(), 1);
          assert.equal(await page.locator('[data-ai-running-indicator] .shimmer').count(), 0);
          await stop.focus();
          await stop.press('Enter');
          assert.deepEqual(await page.evaluate(() => window.recovery.recoveryActions()), ['stop']);
          await page.evaluate(() => window.recovery.recovery('stopping'));
          assert.equal(await notice.locator('button:not(:disabled)').count(), 0);
          assert.equal(await notice.locator('button[aria-busy="true"]').count(), 1);
          await page.evaluate(() => window.recovery.recovery('stopped'));
          assert.equal(await stop.count(), 0);
          assert.equal(await reconnect.isEnabled(), true);
          await reconnect.focus();
          await reconnect.press('Enter');
          assert.deepEqual(await page.evaluate(() => window.recovery.recoveryActions()), ['stop', 'reconnect']);
          await page.evaluate(() => window.recovery.recovery('reconnecting'));
          assert.equal(await notice.locator('button:not(:disabled)').count(), 0);
          assert.equal(await notice.locator('button[aria-busy="true"]').count(), 1);
          const geometry = await notice.evaluate(element => {
            const box = element.getBoundingClientRect();
            const icon = element.querySelector(':scope > svg').getBoundingClientRect();
            const title = element.querySelector('[data-slot="alert-title"]').getBoundingClientRect();
            return { left: box.left, right: box.right, bottom: box.bottom,
              gap: title.left - icon.right, fits: element.scrollWidth <= element.clientWidth + 1 };
          });
          assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.bottom <= 720);
          assert.equal(geometry.fits, true);
          assert.ok(Math.abs(geometry.gap - 4) <= 1, `Recovery icon/text gap must be 4px: ${JSON.stringify(geometry)}`);
          await page.screenshot({ path: `/tmp/shellspan-terminal-recovery-${engine.name()}-${locale}-${width}.png` });
          for (const stage of ['cleared', 'history']) {
            await page.evaluate(stage => window.recovery.recovery(stage), stage);
            assert.equal(await notice.count(), 0);
          }
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
