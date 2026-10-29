import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-unknown-execution-${process.pid}`, plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } }, server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__unknown', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__unknown', '<html><body></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      for (const width of [360, 900]) {
        for (const locale of ['zh-CN', 'en-US']) {
          const page = await browser.newPage({ viewport: { width, height: 560 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__unknown`);
          await page.evaluate(async locale => {
            const { mount } = await import('/src/components/ai/__tests__/unknown-execution.browser.tsx');
            const host = document.createElement('main');
            host.className = 'ai-panel-shell';
            host.style.cssText = 'position:fixed;inset:0;padding:12px;overflow:auto';
            document.body.append(host);
            await mount(host, locale);
          }, locale);
          const row = page.locator('[data-tool-state="uncertain"]');
          await row.waitFor({ state: 'visible' });
          const label = locale === 'zh-CN' ? '执行结果未知' : 'Execution outcome unknown';
          const trigger = row.getByRole('button', { name: new RegExp(label) });
          assert.ok((await trigger.textContent()).includes(label));
          assert.equal(await row.locator('.ai-state-dot[data-state="failed"]').count(), 0);
          assert.equal(await page.getByRole('dialog').count(), 0);
          await trigger.focus();
          await trigger.press('Enter');
          assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
          const content = row.locator('[data-slot="collapsible-content"]');
          await content.waitFor({ state: 'visible' });
          await content.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
          const geometry = await row.evaluate(element => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, fits: element.scrollWidth <= element.clientWidth + 1 };
          });
          assert.ok(geometry.left >= 0 && geometry.right <= width && geometry.fits,
            `Recorded execution must fit ${width}px: ${JSON.stringify(geometry)}`);
          assert.equal(await page.getByRole('dialog').count(), 0);
          await page.screenshot({ path: `/tmp/shellspan-unknown-execution-${engine.name()}-${locale}-${width}.png` });
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
