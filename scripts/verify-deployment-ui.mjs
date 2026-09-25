import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.phase4-acceptance/phase5-ui');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, root, plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { host: '127.0.0.1', port: 1435, strictPort: true }, logLevel: 'error',
});
let browser;
const results = [];
try {
  await server.listen();
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1418, 858, 778, 428]) {
      for (const mode of ['runtime', 'list', 'empty', 'loading', 'versions', 'versions-empty', 'recovery', 'unknown', 'preparing', 'readiness', 'approval', 'rollback', 'settings']) {
        await page.setViewportSize({ width: ['approval', 'rollback', 'settings'].includes(mode) ? width : 1500, height: width === 428 ? 740 : 900 });
        await page.goto(`http://127.0.0.1:1435/tests/deployment-ui/index.html?locale=${locale}&width=${width}&mode=${mode}`);
        await page.getByTestId('acceptance-container').waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (mode === 'runtime') {
          await page.waitForFunction(() => ['wide', 'medium', 'narrow'].includes(document.querySelector('[data-testid="deployment-runtime-workspace"]')?.getAttribute('data-layout')));
        }
        if (['approval', 'rollback', 'settings'].includes(mode)) {
          await page.getByRole('button').first().click();
          await page.getByRole('dialog').waitFor();
          await page.waitForTimeout(180);
          if (mode === 'settings') {
            await page.getByRole('button', { name: locale === 'zh-CN' ? '源码、数据与部署检查' : 'Source, data and deployment checks', exact: true }).click();
            await page.getByLabel(locale === 'zh-CN' ? '应用名称' : 'Application name', { exact: true }).waitFor();
            await page.waitForTimeout(250);
          }
          const dialog = page.getByRole('dialog');
          const dimensions = await dialog.evaluate(element => {
            const footer = element.querySelector('[data-slot="dialog-footer"]');
            const scroll = element.querySelector('[data-slot="scroll-area-viewport"]');
            const box = element.getBoundingClientRect();
            const footerBox = footer?.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, right: box.right, viewportHeight: innerHeight,
              footerBottom: footerBox?.bottom, footerBorder: footer && getComputedStyle(footer).borderTopWidth,
              scrollHeight: scroll?.scrollHeight, clientHeight: scroll?.clientHeight };
          });
          assert(dimensions.top >= 0 && dimensions.bottom <= dimensions.viewportHeight + 1, `${locale}/${width}/${mode}: dialog exceeds viewport`);
          assert(dimensions.footerBottom <= dimensions.bottom, `${mode}: footer is outside dialog`);
          assert.equal(dimensions.footerBorder, '0px', `${mode}: footer divider`);
          if (mode !== 'settings') assert(dimensions.scrollHeight > dimensions.clientHeight, `${mode}: expected scrolling evidence`);
          await page.keyboard.press('Tab');
          assert(await dialog.evaluate(element => element.contains(document.activeElement)), `${mode}: focus escaped`);
          await page.screenshot({ path: path.join(output, `${locale}-${width}-${mode}.png`) });
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'hidden' });
          assert(await page.getByRole('button').first().evaluate(element => element === document.activeElement), `${mode}: focus did not return`);
        } else {
          if (mode === 'versions') {
            const inspect = page.getByRole('button', { name: locale === 'zh-CN' ? '查看产物' : 'Inspect artifact', exact: true });
            await inspect.focus();
            const box = await inspect.boundingBox();
            assert(box && box.x >= 0 && box.x + box.width <= width + 1, `${locale}/${width}: version action is unreachable`);
          }
          if (['unknown', 'recovery'].includes(mode)) {
            const overlap = await page.locator('[data-slot="alert"]').evaluate(element => {
              const action = element.querySelector('[data-slot="alert-action"]').getBoundingClientRect();
              return [...element.querySelectorAll('[data-slot="alert-title"], [data-slot="alert-description"]')]
                .some(item => { const box = item.getBoundingClientRect(); return box.right > action.left && box.left < action.right && box.top < action.bottom && box.bottom > action.top; });
            });
            assert.equal(overlap, false, `${locale}/${width}/${mode}: action overlaps feedback`);
          }
          await page.screenshot({ path: path.join(output, `${locale}-${width}-${mode}.png`) });
        }
        const overflow = await page.getByTestId('acceptance-container').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
        assert(overflow.scroll <= overflow.width + 1, `${locale}/${width}/${mode}: horizontal overflow ${JSON.stringify(overflow)}`);
        const text = await page.locator('body').innerText();
        assert(!/deployment\.(?:runtime|editor|application)\.[a-z]/.test(text), `${mode}: untranslated key`);
        results.push({ locale, width, mode, passed: true });
      }
    }
  }
  assert.deepEqual(errors, [], 'Browser runtime errors');
  await writeFile(path.join(root, 'docs/design/deployment-center-product-phase-5-ui-evidence.json'), JSON.stringify({
    scope: 'WebKit rendering of existing components and recorded real phase 2–4 evidence; state-only empty/loading/unknown contracts are not backend execution evidence.',
    recordedAt: new Date().toISOString(),
    viewports: 'Main panes: 1500px viewport with independent 1418/858/778/428px containers. Dialogs: matching viewport widths. Height: 900px, or 740px at 428px.', results,
  }, null, 2) + '\n');
  console.log(`Deployment UI: ${results.length} bilingual/container cases passed.`);
} finally {
  await browser?.close();
  await server.close();
}
