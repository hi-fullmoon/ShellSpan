import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = `${root}artifacts/tests/session-context-tooltip`;
const entry = '/src/components/ai/__tests__/session-context-tooltip.browser-entry.tsx';
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `${output}/vite-cache`, optimizeDeps: { entries: [entry.slice(1)] },
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/session-context-tooltip', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/session-context-tooltip',
    `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
});
await mkdir(output, { recursive: true });
await server.listen();
const engine = process.env.SHELLSPAN_TEST_ENGINE ?? 'chromium';
const browser = await (engine === 'webkit' ? webkit : chromium).launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const theme of ['light', 'dark']) {
    for (const locale of ['en-US', 'zh-CN']) {
      for (const width of [1280, 480, 240]) {
        await page.setViewportSize({ width, height: 400 });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/session-context-tooltip`);
        const context = await page.evaluate(async ({ entry, locale, theme }) =>
          (await import(entry)).show(locale, theme), { entry, locale, theme });
        const trigger = page.locator('.ai-session-context');
        const tooltip = page.getByRole('tooltip');
        const triggerBox = await trigger.boundingBox();
        const textWidth = await trigger.evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().width;
        });
        if (width === 1280) {
          assert.ok(Math.abs(triggerBox.width - textWidth) < 1, 'The hover target follows the text width');
          // Hovering the empty part of the heading must not open the tooltip.
          await page.mouse.move(triggerBox.x + textWidth + 40, triggerBox.y + triggerBox.height / 2);
          await assert.rejects(tooltip.waitFor({ state: 'visible', timeout: 800 }), /Timeout/);
        }
        await trigger.hover();
        await tooltip.waitFor({ state: 'visible' });
        await tooltip.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
        assert.equal(await tooltip.textContent(), context);
        const popupBox = await tooltip.boundingBox();
        if (width >= 480) {
          assert.ok(Math.abs(popupBox.x - triggerBox.x) < 1, 'The bubble aligns with the left edge of the context');
        } else {
          assert.ok(popupBox.x <= triggerBox.x && popupBox.x + popupBox.width >= triggerBox.x + triggerBox.width,
            'The bubble shifts only enough to fit the viewport while staying above the truncated context');
        }
        assert.ok(Math.abs(triggerBox.y - popupBox.y - popupBox.height - 4) < 1, 'The bubble stays 4px above the context');
        assert.ok(popupBox.x >= 0 && popupBox.x + popupBox.width <= width, 'The full context fits inside the viewport');
        assert.equal(await trigger.evaluate(element => getComputedStyle(element).textOverflow), 'ellipsis');
        await page.screenshot({ path: `${output}/${engine}-${theme}-${locale}-${width}.png` });
        await page.mouse.move(width - 1, 399);
        await tooltip.waitFor({ state: 'hidden' });
        await page.keyboard.press('Tab');
        await tooltip.waitFor({ state: 'visible' });
        assert.equal(await tooltip.textContent(), context, 'Keyboard focus still reveals the full context');
        await page.keyboard.press('Escape');
        await tooltip.waitFor({ state: 'hidden' });
      }
    }
  }
  assert.deepEqual(errors, [], 'The header renders without browser errors');
} finally {
  await browser.close();
  await server.close();
}
