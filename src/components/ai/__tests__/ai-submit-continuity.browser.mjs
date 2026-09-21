import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-ai-submit-vite-${process.pid}`,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__submit-continuity', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__submit-continuity', '<!doctype html><html><body></body></html>'));
});
await server.listen();
const address = server.httpServer.address();

// Exercise the real editor, composer reducer and workspace in a browser.
// No runtime or model response is substituted: submission stays pending.
try {
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const width of [360, 900]) {
      for (const gesture of ['keyboard', 'primary']) {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}/__submit-continuity`);
        await page.evaluate(async () => {
          await import('/src/styles/base.css');
          const { mount } = await import('/src/components/ai/__tests__/ai-first-submit-transition.browser.tsx');
          const host = document.createElement('main');
          host.id = 'submit-continuity';
          host.className = 'ai-panel-shell @container/ai-workspace';
          host.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--background);z-index:100';
          document.body.append(host);
          await mount(host, 'agent', false);
        });
        const host = page.locator('#submit-continuity');
        const editor = host.locator('[contenteditable]');
        await editor.fill('请解释当前目录\n并说明各个脚本的用途');
        await editor.evaluate(element => { window.submittedEditor = element; });
        if (gesture === 'keyboard') await editor.press('Enter');
        else await host.getByRole('button', { name: '发送', exact: true }).click();
        await page.waitForFunction(() => window.submittedEditor.textContent === '');
        assert.equal(await editor.evaluate(element => document.activeElement === element), true);
        await host.locator('[data-ai-running-indicator]').waitFor({ state: 'visible' });
        await page.keyboard.insertText('继续说明如何运行测试');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        assert.equal(await editor.textContent(), '继续说明如何运行测试');
        const feedback = await page.evaluate(async () => {
          const { useToastStore } = await import('/src/stores/toastStore.ts');
          return useToastStore.getState().toasts.filter(toast => toast.message === '上一条输入仍在提交中。').length;
        });
        assert.equal(feedback, 1, 'repeated Enter must explain the restriction without duplicate notices');
        assert.equal(await editor.evaluate(element => element === window.submittedEditor && element === document.activeElement), true);
        const bounds = await host.locator('[data-composer-card]').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 701);
        assert.deepEqual(errors, []);
        if (process.env.SHELLSPAN_SCREENSHOT_DIR && gesture === 'primary') {
          await page.screenshot({ path: `${process.env.SHELLSPAN_SCREENSHOT_DIR}/submit-continuity-${engine.name()}-${width}.png` });
        }
        console.log(`${engine.name()} ${width}px ${gesture}: focus, next draft, immediate feedback and notice deduplication passed`);
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
