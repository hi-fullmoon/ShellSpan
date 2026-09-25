import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const output = `${root}.phase4-acceptance/source-path`;
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
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1418, 428]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${server.resolvedUrls.local[0]}tests/deployment-ui/index.html?locale=${locale}&width=${width}&mode=settings&configured`);
      await page.getByRole('button').click();
      await page.getByRole('dialog').getByRole('button', { name: locale === 'zh-CN' ? '源码、数据与部署检查' : 'Source, data and deployment checks', exact: true }).click();
      const input = page.getByLabel(locale === 'zh-CN' ? '本地 Git 根目录' : 'Local Git repository root');
      await input.waitFor();
      const header = await page.getByRole('dialog').locator('[data-slot="dialog-header"]').boundingBox();
      const firstField = await page.getByRole('dialog').locator('[data-slot="field"]').first().boundingBox();
      assert(header && firstField);
      assert.equal(firstField.y - header.y - header.height, 16);
      await page.screenshot({ path: `${output}/header-${locale}-${width}.png` });
      const field = input.locator('xpath=../..');
      const buttons = field.getByRole('button');
      assert.equal(await buttons.count(), 2);
      await input.fill('');
      assert(await buttons.nth(1).isDisabled());
      await input.fill(root.slice(0, -1));
      assert(await buttons.nth(1).isEnabled());
      const inputBounds = await input.boundingBox();
      const first = await buttons.nth(0).boundingBox();
      const second = await buttons.nth(1).boundingBox();
      assert(inputBounds && first && second);
      assert.equal(inputBounds.height, first.height);
      assert.equal(first.height, second.height);
      assert.equal(first.y, second.y);
      if (width > 600) assert.equal(inputBounds.y, first.y);
      else assert.equal(first.y - inputBounds.y - inputBounds.height, 8);
      assert(second.x + second.width <= width);
      assert(await field.evaluate(el => el.scrollWidth <= el.clientWidth));
      await input.focus();
      await page.keyboard.press('Tab');
      assert(await buttons.nth(0).evaluate(el => document.activeElement === el));
      await page.keyboard.press('Tab');
      assert(await buttons.nth(1).evaluate(el => document.activeElement === el));
      const dialog = page.getByRole('dialog');
      const bounds = await dialog.boundingBox();
      assert(bounds);
      assert.equal(bounds.width, Math.min(896, width - 32));
      assert.equal(bounds.height, 768);
      assert(bounds.x >= 16 && bounds.y >= 16);
      const footer = await dialog.locator('[data-slot="dialog-footer"]').boundingBox();
      assert(footer && footer.y + footer.height <= 784);
      const pairs = await dialog.locator('[data-slot="field-group"].grid').all();
      assert.equal(pairs.length, 3);
      for (const pair of pairs) {
        await pair.scrollIntoViewIfNeeded();
        const fields = pair.locator(':scope > [data-slot="field"]');
        const left = await fields.nth(0).boundingBox();
        const right = await fields.nth(1).boundingBox();
        assert(left && right);
        assert(Math.abs(left.width - right.width) < 1);
        if (width > 600) {
          assert.equal(left.y, right.y);
          assert.equal(right.x - left.x - left.width, 12);
        } else {
          assert.equal(left.x, right.x);
          assert(right.y >= left.y + left.height);
        }
        assert(await pair.evaluate(el => el.scrollWidth <= el.clientWidth));
      }
      await pairs[0].scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/${locale}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Source path layout passed bilingual wide and narrow rendering checks.');
} finally {
  await browser?.close();
  await server.close();
}
