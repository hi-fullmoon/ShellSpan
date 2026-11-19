import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const project = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = 'src/components/ai/__tests__/pending-action-layout.browser.tsx';
const server = await createServer({
  configFile: false, root: project, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${project}src` } },
  optimizeDeps: { entries: [entry] }, server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/', async (_request, response, next) => {
  if (_request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><main id="root"></main></body></html>'));
});

const geometry = container => container.evaluate(element => ({
  box: element.getBoundingClientRect().toJSON(),
  actions: [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect().toJSON()),
  overflow: element.scrollWidth > element.clientWidth + 1,
}));

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [320, 640, 900]) {
          const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(server.resolvedUrls.local[0]);
          const labels = await page.evaluate(async ({ entry, locale }) => {
            window.preview = await (await import(`/${entry}`)).mount(locale);
            window.preview.catalog(false);
            await document.fonts.ready;
            return window.preview.labels;
          }, { entry, locale });
          const discover = page.getByRole('button', { name: labels.discover, exact: true });
          const discovering = page.getByRole('button', { name: labels.discovering, exact: true });
          const catalogHeader = page.getByRole('button', { name: labels.reset, exact: true }).locator('../..');
          await discover.waitFor();
          const catalogBefore = await geometry(catalogHeader);
          assert.equal(catalogBefore.overflow, false);
          await page.evaluate(() => window.preview.catalog(true));
          await discovering.waitFor();
          assert.equal((await discovering.innerText()).trim(), labels.discovering);
          assert.equal(await discovering.isDisabled(), true);
          await discovering.locator('[data-slot="spinner"]').waitFor();
          assert.deepEqual(await geometry(catalogHeader), catalogBefore, `${locale}/${width}: fetching models shifted the header`);
          await page.evaluate(() => window.preview.catalog(false));
          await discover.waitFor();
          assert.equal((await discover.innerText()).trim(), labels.discover);
          assert.deepEqual(await geometry(catalogHeader), catalogBefore);

          for (const kind of ['deletion', 'authorization']) {
            await page.evaluate(kind => window.preview.confirm(kind, null), kind);
            const dialog = page.getByRole('alertdialog');
            const footer = dialog.locator('[data-slot="alert-dialog-footer"]');
            const action = dialog.locator('[data-slot="alert-dialog-action"]');
            const label = kind === 'authorization' ? labels.authorize : labels.deleteAll;
            const before = dialog.getByRole('button', { name: label, exact: true });
            await before.waitFor();
            assert.equal((await before.innerText()).trim(), label);
            await before.locator('[data-slot="spinner"]').waitFor({ state: 'hidden' });
            const footerBefore = await geometry(footer);
            assert.equal(footerBefore.overflow, false);
            await before.press('Enter');
            if (kind === 'authorization') {
              await action.locator('[data-slot="spinner"]').waitFor();
              assert.equal((await action.innerText()).trim(), labels.preparing);
              assert.deepEqual(await geometry(footer), footerBefore, `${locale}/${width}: authorization shifted the footer`);
            } else {
              for (const [index, progress] of [0, 9, 10, 120].entries()) {
                await page.evaluate(progress => window.preview.confirm('deletion', progress), progress);
                assert.equal((await action.innerText()).trim(), labels.deletionProgress[index]);
                assert.deepEqual(await geometry(footer), footerBefore, `${locale}/${width}: deletion progress shifted the footer`);
              }
            }
            assert.equal(await action.getAttribute('aria-busy'), 'true');
            assert.equal(await dialog.getByRole('button', { name: labels.cancel, exact: true }).isDisabled(), true);
            await page.evaluate(kind => window.preview.confirm(kind, null), kind);
            await before.waitFor();
            assert.deepEqual(await geometry(footer), footerBefore);
          }
          assert.deepEqual(errors, []);
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
