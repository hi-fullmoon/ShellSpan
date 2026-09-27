import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const events = JSON.parse(await readFile(new URL('../../../../src/test/fixtures/agent-skills-runtime.json', import.meta.url), 'utf8'));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } }, plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/', async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/reasoning-reveal.browser-entry.tsx"></script></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [420, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 720 }, reducedMotion: 'no-preference' });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
        const render = completed => page.evaluate(async ({ events, completed }) => {
          const { showProcess } = await import('/src/components/ai/__tests__/reasoning-reveal.browser-entry.tsx');
          const end = events.findIndex(event => event.type === 'turn/end');
          if (end < 0) throw new Error('Recorded session must contain a completed turn');
          showProcess(events.slice(0, completed ? end + 1 : end));
        }, { events, completed });
        await render(false);
        const trigger = page.locator('.ai-turn-process-trigger').first();
        const spinner = trigger.locator('[data-slot="spinner"]');
        await spinner.waitFor();
        for (const open of [true, false]) {
          if (await trigger.getAttribute('aria-expanded') !== String(open)) await trigger.click();
          await trigger.hover();
          await trigger.focus();
          const state = await spinner.evaluate(element => {
            const style = getComputedStyle(element);
            const icon = element.getBoundingClientRect();
            const label = element.closest('button').querySelector('.ai-disclosure-title').getBoundingClientRect();
            return { opacity: style.opacity, animation: style.animationName,
              gap: label.left - icon.right, offset: icon.top + icon.height / 2 - label.top - label.height / 2 };
          });
          assert.equal(state.opacity, '1', 'Expanded, hovered and focused loading icons must stay visible');
          assert.notEqual(state.animation, 'none');
          assert.ok(Math.abs(state.gap - 4) <= 1, `Icon/text gap must remain 4px: ${JSON.stringify(state)}`);
          assert.ok(Math.abs(state.offset) <= 1, 'Spinner must align with the process title');
        }
        await trigger.screenshot({ path: `/tmp/process-loading-${engine.name()}-${width}.png` });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await spinner.evaluate(element => getComputedStyle(element).animationName), 'none');
        await render(true);
        assert.equal(await trigger.locator('[data-slot="spinner"]').count(), 0);
        assert.equal(await trigger.locator('.ai-disclosure-chevron').count(), 1);
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        await trigger.press('Enter');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
