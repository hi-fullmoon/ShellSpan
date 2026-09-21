import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss(), {
    name: 'skill-hint-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!request.url.startsWith('/skill-hint-test')) return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/ai-skill-hint.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [400, 1000]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/skill-hint-test?${locale}`);
      const editor = page.getByRole('textbox');
      await editor.fill('/');
      await page.getByRole('option', { name: /system-status/ }).waitFor();
      const hint = page.locator('[data-skill-completion] [data-slot="popover-description"]');
      const typography = await hint.evaluate(element => {
        const style = getComputedStyle(element);
        const detail = getComputedStyle(document.querySelector('[data-skill-completion] [role="option"] .text-xs'));
        return { size: style.fontSize, weight: style.fontWeight, family: style.fontFamily,
          detailSize: detail.fontSize, detailFamily: detail.fontFamily, color: style.color, detailColor: detail.color,
          fits: element.scrollWidth <= element.clientWidth };
      });
      assert.equal(typography.size, typography.detailSize, 'Hint uses the existing auxiliary text size');
      assert.equal(typography.weight, '400', 'Hint has regular font weight');
      assert.equal(typography.family, typography.detailFamily, 'Hint uses the system font');
      assert.equal(typography.color, typography.detailColor, 'Hint retains the muted text color');
      assert.ok(typography.fits, 'Hint fits narrow and wide containers');
      await page.screenshot({ path: `/tmp/shellspan-skill-hint-${locale}-${width}.png` });
      assert.equal(await editor.evaluate(element => element === document.activeElement), true);
      await editor.press('Escape');
      await hint.waitFor({ state: 'hidden' });
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
