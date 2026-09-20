import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  configFile: false, root, appType: 'custom', plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('../src/', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__task-budget-check', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__task-budget-check',
    '<html><body><div id="root"></div><script type="module" src="/scripts/perf/task-token-budget-page.tsx"></script></body></html>'));
});
await server.listen();
try {
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      for (const width of [420, 900]) {
        for (const locale of ['en-US', 'zh-CN']) {
          const page = await browser.newPage({ viewport: { width, height: 720 } });
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${address.port}/__task-budget-check`);
          await page.waitForFunction(() => Boolean(window.taskBudgetCheck));
          await page.evaluate((locale) => window.taskBudgetCheck.show(locale), locale);
          const notice = page.locator('[data-token-budget-notice]');
          await notice.waitFor({ state: 'visible' });
          assert.equal(await notice.getByRole('button').count(), 0);
          assert.equal(await page.getByRole('button', { name: /继续任务|Continue task|retry|重试/i }).count(), 0);
          assert.equal(await page.getByRole('textbox').isEnabled(), true);
          assert.equal(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.evaluate((locale) => window.taskBudgetCheck.show(locale, true), locale);
          await notice.waitFor({ state: 'detached' });
          assert.equal(await page.locator('.ai-turn-error').count(), 1);
          assert.deepEqual(errors, []);
          console.log(`${browserType.name()} ${width}px ${locale}: no continuation buttons, composer available and resumed history passed`);
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
