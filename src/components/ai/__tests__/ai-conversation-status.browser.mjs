import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-conversation-status-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__status', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__status', '<html><body></body></html>'));
});
const waiting = [
  ['waitingForNetwork', 'Waiting for network recovery', '等待网络恢复'],
  ['toolApprovalPending', 'Waiting for your approval', '等待你批准操作'],
  ['waitingForUserQuestion', 'Waiting for your answer', '等待你回答问题'],
  ['toolSchedulerRecoveryRequired', 'Waiting for tool execution recovery', '等待工具执行恢复'],
  ['terminalExecutionRecoveryRequired', 'Execution paused: terminal recovery required', '执行已暂停，需要恢复终端'],
  ['ephemeralInputRecoveryRequired', 'Waiting for execution input recovery', '等待执行输入恢复'],
  ['authorizedCallRecoveryAvailable', 'Waiting for you to resume the authorized operation', '等待你恢复已授权的操作'],
  [undefined, 'Waiting (reason unavailable)', '等待中（未提供原因）'],
];
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        for (const locale of ['zh-CN', 'en-US']) {
          const page = await browser.newPage({ viewport: { width, height: 720 }, reducedMotion: 'no-preference' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__status`);
          await page.evaluate(async locale => {
            const { mount } = await import('/src/components/ai/__tests__/ai-conversation-status.browser.tsx');
            const host = document.createElement('main');
            host.className = 'ai-panel-shell ai-workspace-root @container/ai-workspace';
            host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column';
            document.body.append(host);
            window.conversationStatus = await mount(host, locale);
            window.conversationStatus.render('running');
          }, locale);
          const indicator = page.locator('[data-ai-running-indicator]');
          await indicator.waitFor({ state: 'visible' });
          assert.equal(await indicator.textContent(), locale === 'zh-CN' ? '处理中' : 'Processing');
          assert.equal(await page.locator('[data-ai-thinking-indicator]').count(), 0);
          const spinner = indicator.locator('[data-slot="spinner"]');
          const gap = await indicator.evaluate(element => {
            const icon = element.querySelector('svg').getBoundingClientRect();
            const text = element.querySelector('[data-slot="marker-content"]').getBoundingClientRect();
            return { gap: text.left - icon.right, offset: icon.top + icon.height / 2 - text.top - text.height / 2 };
          });
          assert.ok(Math.abs(gap.gap - 4) <= 1, `Processing icon/text gap must be 4px: ${JSON.stringify(gap)}`);
          assert.equal(gap.offset, 0);
          assert.notEqual(await spinner.evaluate(element => getComputedStyle(element).animationName), 'none');
          await indicator.screenshot({ path: `/tmp/shellspan-processing-${engine.name()}-${locale}-${width}.png` });
          for (const [reason, english, chinese] of waiting) {
            await page.evaluate(reason => window.conversationStatus.render('waiting', reason), reason);
            assert.equal(await indicator.textContent(), locale === 'zh-CN' ? chinese : english);
            assert.equal(await indicator.locator('[data-slot="spinner"]').count(), 0);
            assert.equal(await page.locator('[data-message-scroller-viewport]').evaluate(element =>
              element.scrollWidth <= element.clientWidth + 1), true, 'Waiting reasons must fit the conversation width');
          }
          await page.evaluate(() => window.conversationStatus.render('waiting', 'authorizedCallRecoveryAvailable'));
          await indicator.screenshot({ path: `/tmp/shellspan-waiting-${engine.name()}-${locale}-${width}.png` });
          for (const status of ['idle', 'completed', 'cancelled', 'failed']) {
            await page.evaluate(status => window.conversationStatus.render(status), status);
            assert.equal(await indicator.count(), 0);
          }
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
