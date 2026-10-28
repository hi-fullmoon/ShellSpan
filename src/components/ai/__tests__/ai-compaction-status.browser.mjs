import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-compaction-progress-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__progress', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__progress', '<html><body></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        for (const locale of ['zh-CN', 'en-US']) {
          const page = await browser.newPage({ viewport: { width, height: 500 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__progress`);
          await page.evaluate(async locale => {
            const { mount } = await import('/src/components/ai/__tests__/ai-compaction-status.browser.tsx');
            const host = document.createElement('main');
            host.className = 'ai-panel-shell';
            host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column';
            document.body.append(host);
            window.compactionProgress = await mount(host, locale);
            window.compactionProgress('running');
          }, locale);
          const row = page.locator('[data-ai-compaction-status]');
          await row.waitFor({ state: 'visible' });
          assert.ok((await row.textContent()).includes(locale === 'zh-CN' ? '正在压缩上下文' : 'Compacting context'));
          assert.equal(await row.getAttribute('aria-busy'), 'true');
          assert.equal(await row.locator('[data-slot="spinner"]').count(), 1);
          assert.equal(await page.locator('[data-ai-running-indicator]').count(), 0);
          const geometry = await row.evaluate(element => {
            const icon = element.querySelector('svg').getBoundingClientRect();
            const text = element.querySelector('[data-slot="marker-content"]').getBoundingClientRect();
            const bounds = element.getBoundingClientRect();
            return { gap: text.left - icon.right, fits: bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1 };
          });
          assert.ok(Math.abs(geometry.gap - 4) <= 1, `Icon/text gap must remain 4px: ${JSON.stringify(geometry)}`);
          assert.equal(geometry.fits, true);
          await row.screenshot({ path: `/tmp/shellspan-compaction-${engine.name()}-${locale}-${width}-running.png` });
          for (const state of ['completed', 'failed', 'cancelled']) {
            await page.evaluate(state => window.compactionProgress(state), state);
            assert.equal(await row.getAttribute('data-ai-compaction-status'), state);
            assert.equal(await row.getAttribute('aria-busy'), 'false');
            assert.equal(await row.locator('[data-slot="spinner"]').count(), 0);
            assert.ok((await row.locator('[data-ai-compaction-duration]').textContent()).includes(locale === 'zh-CN' ? '用时' : 'Took'));
            assert.equal(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
            await row.screenshot({ path: `/tmp/shellspan-compaction-${engine.name()}-${locale}-${width}-${state}.png` });
          }
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log('Compaction progress: real recorded outcomes, localized live state, duration and narrow/wide layouts passed in Chromium and WebKit.');
} finally { await server.close(); }
