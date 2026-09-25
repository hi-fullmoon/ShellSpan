import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const output = `${root}.phase4-acceptance/deployment-tabs`;
await mkdir(output, { recursive: true });
const server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1418, 778, 428]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${server.resolvedUrls.local[0]}tests/deployment-tabs-ui/index.html?locale=${locale}`);
      const tabs = page.getByRole('tab');
      await tabs.first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const actions = page.getByTestId('deployment-workflow-actions');
      const save = actions.getByRole('button', { name: locale === 'zh-CN' ? '保存' : 'Save', exact: true });
      assert(await save.isVisible());
      const context = await page.locator('[data-slot="workbench-page-header"] p').innerText();
      assert(context.startsWith(locale === 'zh-CN' ? '当前工作流：' : 'Current workflow:'));
      for (let index = 0; index < 3; index++) {
        await tabs.nth(index).click();
        await page.waitForFunction(() => document.querySelectorAll('[role="tabpanel"]:not([hidden])').length === 1);
        assert.equal(await tabs.nth(index).getAttribute('aria-selected'), 'true');
        assert.equal(await page.getByRole('tabpanel').count(), 1);
        assert.equal(await page.locator('[role="tabpanel"]').count(), 3);
        assert.equal(await save.isVisible(), index === 0);
        assert.equal(await page.locator('[data-slot="workbench-page-header"] p').innerText(), context);
        const geometry = await actions.evaluate(el => ({
          right: el.getBoundingClientRect().right,
          heights: [...el.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0).map(b => b.getBoundingClientRect().height),
        }));
        assert(geometry.right <= width, `${locale}/${width}: actions clipped`);
        assert(geometry.heights.every(height => height === 32));
        assert(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth));
        await page.screenshot({ path: `${output}/${locale}-${width}-${index}.png`, animations: 'disabled' });
      }
      await tabs.first().focus();
      await page.keyboard.press('ArrowRight');
      assert(await tabs.nth(1).evaluate(el => el === document.activeElement));
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected') === 'true');
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
    }
  }
  assert.deepEqual(errors, []);
  console.log('Deployment tabs: bilingual layout and keyboard checks passed at three widths.');
} finally {
  await browser?.close();
  await server.close();
}
