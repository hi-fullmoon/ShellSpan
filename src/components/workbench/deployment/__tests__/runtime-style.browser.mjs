import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

// Render recorded deployment evidence using the production components.
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const output = `${root}.phase4-acceptance/runtime-style`;
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
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1418, 778, 428]) {
      for (const mode of ['runtime-rollback', 'versions', 'versions-empty', 'empty', 'loading']) {
        await page.goto(`${server.resolvedUrls.local[0]}tests/deployment-ui/index.html?locale=${locale}&width=${width}&mode=${mode}`);
        await page.getByTestId('acceptance-container').waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (mode === 'runtime-rollback') {
          const rows = page.locator('[data-run-node-id]');
          await rows.first().waitFor();
          assert(await rows.count() > 1);
          if (width === 1418) {
            const evidenceStyle = await page.getByTestId('deployment-open-evidence').evaluate(el => ({
              border: getComputedStyle(el).borderTopWidth,
              width: el.getBoundingClientRect().width,
              height: el.getBoundingClientRect().height,
            }));
            assert.deepEqual(evidenceStyle, { border: '0px', width: 32, height: 32 });
          }
          assert.equal(await page.getByTestId('deployment-runtime-feedback').evaluate(el => el.getBoundingClientRect().height), 0, 'Completed runs must not leave an empty feedback band');
          const list = page.getByTestId('deployment-runtime-step-list');
          assert.equal(await list.locator('[data-slot="separator"]').count(), await rows.count() - 1);
          const spacing = await rows.first().evaluate(el => ({
            button: getComputedStyle(el).paddingTop,
            row: getComputedStyle(el.parentElement).paddingTop,
            inset: getComputedStyle(el.parentElement).paddingLeft,
          }));
          assert.deepEqual(spacing, { button: '6px', row: '4px', inset: '8px' });
          await rows.first().focus();
          await page.keyboard.press('Tab');
          assert(await rows.nth(1).evaluate(el => el === document.activeElement));
        }
        if (mode === 'versions') {
          const view = page.getByTestId('deployment-versions-view');
          const badge = view.locator('[data-slot="badge"]').first();
          assert.equal(await badge.evaluate(el => el.getBoundingClientRect().height), 16);
          const table = view.locator('[data-slot="table-container"]');
          assert.equal(await view.locator('[data-slot="deployment-pane-header"]').count(), 0);
          const edges = await table.evaluate(el => {
            const tableBox = el.getBoundingClientRect();
            const viewBox = el.closest('[data-testid="deployment-versions-view"]').getBoundingClientRect();
            return { left: tableBox.left - viewBox.left, top: tableBox.top - viewBox.top, right: viewBox.right - tableBox.right };
          });
          assert.deepEqual(edges, { left: 0, top: 0, right: 0 }, 'Version table must fill its container without padding');
          const action = view.getByRole('button', { name: locale === 'zh-CN' ? '查看产物' : 'Inspect artifact', exact: true }).first();
          assert.equal(await action.evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
          await action.focus();
          await action.hover();
          const tooltip = page.locator('[data-slot="tooltip-content"]');
          await tooltip.waitFor({ timeout: 5000 });
          assert.equal(await tooltip.innerText(), locale === 'zh-CN' ? '查看产物' : 'Inspect artifact');
          const box = await action.boundingBox();
          assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'Version actions must be reachable by keyboard in narrow containers');
        }
        const overflow = await page.getByTestId('acceptance-container').evaluate(el => el.scrollWidth - el.clientWidth);
        assert(overflow <= 1, `${locale}/${width}/${mode}: horizontal overflow`);
        assert(!/deployment\.(runtime|editor)\.[a-z]/.test(await page.locator('body').innerText()));
        await page.screenshot({ path: `${output}/${locale}-${width}-${mode}.png` });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('Deployment runtime styles: 30 bilingual rendering cases passed.');
} finally {
  await browser?.close();
  await server.close();
}
