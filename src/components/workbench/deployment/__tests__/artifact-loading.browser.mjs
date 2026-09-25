import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const output = `${root}.phase4-acceptance/artifact-loading`;
await mkdir(output, { recursive: true });
const server = await createServer({
  root, configFile: false, plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1418, 428]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${server.resolvedUrls.local[0]}tests/deployment-ui/index.html?locale=${locale}&width=${width}&mode=artifact-loading`);
      const trigger = page.getByTestId('acceptance-container').getByRole('button');
      await trigger.click();
      const drawer = page.getByTestId('deployment-artifact-drawer');
      await drawer.waitFor();
      await page.waitForFunction(() => {
        const drawer = document.querySelector('[data-testid="deployment-artifact-drawer"]');
        return drawer && getComputedStyle(drawer).opacity === '1';
      });
      assert(await drawer.getByRole('status').first().isVisible());
      const bounds = await drawer.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      const footer = drawer.locator('[data-slot="drawer-footer"]');
      const footerBounds = await footer.boundingBox();
      assert(footerBounds && footerBounds.y + footerBounds.height <= 800);
      assert.equal(await footer.evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
      await page.screenshot({ path: `${output}/${locale}-${width}.png` });
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.closest('[data-testid="acceptance-container"]'));
      assert(await trigger.evaluate(el => el === document.activeElement));
    }
  }
  console.log('Artifact loading drawer: both locales and viewport sizes passed.');
} finally {
  await browser?.close();
  await server.close();
}
