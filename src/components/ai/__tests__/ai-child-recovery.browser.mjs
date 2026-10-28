import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = path.resolve(import.meta.dirname, '../../../..');
const directory = path.resolve(process.argv[2] ?? 'src/test/fixtures/child-failure-recovery');
const events = JSON.parse(await readFile(path.join(directory, 'failed-events.json'), 'utf8'));
const snapshot = JSON.parse(await readFile(path.join(directory, 'failed-snapshot.json'), 'utf8'));
assert.ok(snapshot.header.subagent?.continuable && snapshot.childFailureRecovery?.retryable);
assert.ok(Date.now() < snapshot.header.createdAtUnixMs + snapshot.header.subagent.budget.timeoutMs,
  'Regenerate a fresh recording with SHELLSPAN_CHILD_RECOVERY_REVIEW and the Rust recovery regression before browser QA');
const output = '/tmp/shellspan-child-recovery-ui';
await mkdir(output, { recursive: true });
const server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom',
  cacheDir: `/tmp/shellspan-child-recovery-vite-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': path.join(root, 'src') } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use(async (request, response, next) => {
  if (request.url === '/child-recovery-recording') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ events, snapshot }));
  } else if (request.url?.startsWith('/child-recovery-review')) {
    response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml('/child-recovery-review',
      '<html><body style="margin:0"><div id="root"></div><script type="module" src="/src/components/ai/__tests__/ai-child-recovery.browser-entry.tsx"></script></body></html>'));
  } else next();
});
let browser;
try {
  await server.listen();
  browser = await (process.env.SHELLSPAN_TEST_ENGINE === 'webkit' ? webkit : chromium).launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1180, 360]) {
      await page.setViewportSize({ width, height: 760 });
      await page.goto(`${server.resolvedUrls.local[0]}child-recovery-review?locale=${locale}`);
      const turn = page.locator('.ai-turn-process-trigger').last();
      await turn.waitFor();
      if (await turn.getAttribute('aria-expanded') !== 'true') await turn.click();
      const retry = page.getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry', exact: true });
      await retry.waitFor();
      await page.locator('.ai-turn-process').last().evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
      assert.equal(await turn.getAttribute('aria-expanded'), 'true');
      assert.equal(await retry.count(), 1);
      assert.equal(await retry.evaluate(element => element.getBoundingClientRect().height), 24);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${output}/${locale}-${width}.png`, fullPage: true });
      await retry.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.dataset.recoveryTurn === 'failure-turn');
      assert.equal(await page.getByRole('button', { name: locale === 'zh-CN' ? '正在重试' : 'Retrying', exact: true }).isDisabled(), true);
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
