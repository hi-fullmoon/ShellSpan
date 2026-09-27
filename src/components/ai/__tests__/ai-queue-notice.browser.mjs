import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-queue-notice');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'queue-notice-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/?locale=')) return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell" style="padding:24px 8px"></main><script type="module" src="/src/components/ai/__tests__/ai-queue-notice.browser.tsx"></script></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [320, 900]) {
      const page = await browser.newPage({ viewport: { width, height: 320 } });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?locale=${locale}`);
      const details = page.getByRole('button', { name: locale === 'zh-CN' ? '技术详情' : 'Technical details' });
      await details.waitFor();
      assert.equal(await details.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByText('Agent Runtime revision conflict:', { exact: false }).count(), 0);
      const geometry = await page.getByRole('alert').evaluate(element => {
        const icon = element.querySelector(':scope > svg').getBoundingClientRect();
        const title = element.querySelector('[data-slot="alert-title"]').getBoundingClientRect();
        return { gap: title.left - icon.right, overflow: element.scrollWidth > element.clientWidth };
      });
      assert.equal(geometry.gap, 4);
      assert.equal(geometry.overflow, false);
      const checkPlacement = async () => {
        const placement = await page.getByRole('alert').evaluate(element => {
          const queue = document.querySelector('[data-slot="ai-queue-dock"]');
          const noticeRect = element.getBoundingClientRect();
          const queueRect = queue.getBoundingClientRect();
          return {
            nested: queue.contains(element),
            gap: queueRect.top - noticeRect.bottom,
            aligned: noticeRect.left === queueRect.left && noticeRect.width === queueRect.width,
          };
        });
        assert.equal(placement.nested, false, 'Notice must be outside the queue card');
        assert.equal(placement.gap, 12, 'Notice must sit 12px above the queue');
        assert.equal(placement.aligned, true, 'Notice and queue must align');
      };
      await checkPlacement();
      await page.screenshot({ path: join(screenshots, `${locale}-${width}.png`) });
      await page.keyboard.press('Tab');
      assert.equal(await details.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Enter');
      await page.getByText('Agent Runtime revision conflict:', { exact: false }).waitFor();
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
      await checkPlacement();
      assert.equal(await page.getByRole('alert').evaluate(element => element.scrollWidth > element.clientWidth), false);
      await page.screenshot({ path: join(screenshots, `${locale}-${width}-expanded.png`) });
      await page.keyboard.press('Space');
      assert.equal(await details.getAttribute('aria-expanded'), 'false');
      await page.close();
    }
  }
  console.log(`Queue notice layout and keyboard checks passed in both locales at 320px and 900px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
