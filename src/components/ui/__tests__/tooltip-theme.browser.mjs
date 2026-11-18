import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = `${root}artifacts/tests/tooltip-theme`;
const entry = '/src/components/ui/__tests__/tooltip-theme.browser-entry.tsx';
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `${output}/vite-cache`,
  optimizeDeps: { entries: [entry.slice(1)] },
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/tooltip-theme', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/tooltip-theme',
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
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tooltip-theme`);
      const label = await page.evaluate(async ({ entry, locale }) => (await import(entry)).show(locale), { entry, locale });
      const button = page.getByRole('button', { name: label });
      const tooltip = page.locator('[data-slot="tooltip-content"]');
      await page.keyboard.press('Tab');
      await tooltip.waitFor({ state: 'visible' });
      await tooltip.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      assert.equal(await tooltip.textContent(), label, 'Keyboard focus reveals the localized label');
      const sizes = [];
      // Switch theme while the portalled tooltip stays open.
      for (const theme of ['light', 'dark', 'light']) {
        await page.evaluate(async theme => (await import('/src/lib/theme.ts')).applyTheme(theme), theme);
        const result = await tooltip.evaluate(element => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          const surface = document.createElement('span');
          surface.style.cssText = 'background:var(--popover);color:var(--popover-foreground)';
          document.body.append(surface);
          const expected = getComputedStyle(surface);
          const result = { background: style.backgroundColor, color: style.color,
            expectedBackground: expected.backgroundColor, expectedColor: expected.color,
            shadow: style.boxShadow, width: box.width, height: box.height,
            insideViewport: box.left >= 0 && box.right <= innerWidth,
            overflow: element.scrollWidth > element.clientWidth };
          surface.remove();
          return result;
        });
        assert.equal(result.background, result.expectedBackground, `${theme}: follows the popover surface`);
        assert.equal(result.color, result.expectedColor, `${theme}: follows the popover text`);
        assert.equal(result.background, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 33, 34)');
        assert.notEqual(result.shadow, 'none', 'The tooltip remains distinct from the surrounding surface');
        assert.equal(result.insideViewport, true);
        assert.equal(result.overflow, false);
        sizes.push([result.width, result.height]);
        await page.screenshot({ path: `${output}/${engine}-${theme}-${locale}-${width}.png` });
      }
      assert.deepEqual(sizes[0], sizes[1], 'Theme switching preserves tooltip dimensions');
      await page.keyboard.press('Escape');
      await tooltip.waitFor({ state: 'hidden' });
      assert.equal(await button.evaluate(element => element === document.activeElement), true, 'Escape preserves trigger focus');
      await button.blur();
      await button.hover();
      await tooltip.waitFor({ state: 'visible' });
      assert.equal(await tooltip.textContent(), label, 'Mouse hover reveals the same label');
      assert.equal(await page.locator('[title]').count(), 0, 'No native tooltip is introduced');
    }
  }
  assert.deepEqual(errors, [], 'Tooltips render without browser errors');
} finally {
  await browser.close();
  await server.close();
}
