import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = `${root}artifacts/tests/port-forward-dialog`;
await mkdir(output, { recursive: true });
const workflow = parse(await readFile(`${root}.github/workflows/quality-gate.yml`, 'utf8'));
const { env } = workflow.jobs['ssh-e2e'].steps.find(step => step.env?.SHELLSPAN_E2E_SSH_HOST);
const profile = {
  id: 'ssh-e2e', name: env.SHELLSPAN_E2E_SSH_HOST, host: env.SHELLSPAN_E2E_SSH_HOST,
  port: Number(env.SHELLSPAN_E2E_SSH_PORT), username: env.SHELLSPAN_E2E_SSH_USERNAME,
  authMethod: 'password', createdAt: Date.now(), updatedAt: Date.now(),
};
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error', cacheDir: `${output}/vite-cache`,
  plugins: [tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  optimizeDeps: { entries: ['src/components/workbench/port-forward-dialog.tsx'], include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use((_request, response, next) => {
  if (_request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><div id="root"></div></body></html>');
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
        await page.goto(server.resolvedUrls.local[0]);
        const labels = await page.evaluate(async ({ locale, profile }) => {
          const { default: React } = await import('/@id/react');
          const { default: ReactDOM } = await import('/@id/react-dom/client');
          const { PortForwardDialog } = await import('/src/components/workbench/port-forward-dialog.tsx');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          const { initI18n, t } = await import('/src/locales/index.ts');
          await import('/src/styles/base.css');
          useAppStore.setState({ locale });
          await initI18n(locale);
          ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(PortForwardDialog, { profile, onClose() {} }));
          return {
            create: t('portForward.create'), name: t('portForward.form.name'), save: t('common.save'),
            cancel: t('common.cancel'), localPort: t('portForward.form.listenPort'),
            remoteHost: t('portForward.form.remoteTargetHost'),
            remotePort: t('portForward.form.remoteTargetPort'), error: t('portForward.validation.port'),
          };
        }, { locale, profile });
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: labels.create, exact: true }).click();
        await dialog.getByRole('textbox', { name: labels.name, exact: true }).fill(profile.name);
        const localPort = dialog.getByRole('textbox', { name: labels.localPort, exact: true });
        const remoteHost = dialog.getByRole('textbox', { name: labels.remoteHost, exact: true });
        const remotePort = dialog.getByRole('textbox', { name: labels.remotePort, exact: true });
        await localPort.fill(String(profile.port));
        const footer = dialog.locator('[data-slot="card-footer"]');
        const save = footer.getByRole('button', { name: labels.save, exact: true });
        const cancel = footer.getByRole('button', { name: labels.cancel, exact: true });
        const error = footer.getByRole('alert');
        assert.equal(await save.locator('svg').count(), 0, 'The Save button uses a text label only');

        for (const width of [900, 360]) {
          await page.setViewportSize({ width, height: 720 });
          await remotePort.fill('65536');
          assert.equal(Math.round((await dialog.boundingBox()).width), Math.min(672, width - 32),
            'The dialog caps its width and preserves the viewport margins');
          const [localBox, hostBox, remoteBox] = await Promise.all([localPort.boundingBox(), remoteHost.boundingBox(), remotePort.boundingBox()]);
          if (width === 900) {
            assert.deepEqual([localBox.y, hostBox.y], [remoteBox.y, remoteBox.y], 'The three inputs share a row');
            assert.equal(Math.round(hostBox.x - localBox.x - localBox.width), 8);
            assert.equal(Math.round(remoteBox.x - hostBox.x - hostBox.width), 8);
          } else {
            assert.ok(hostBox.y > localBox.y + localBox.height && remoteBox.y > hostBox.y + hostBox.height,
              'The fields stack with vertical spacing in a narrow dialog');
          }
          assert.equal(await dialog.getByRole('alert').textContent(), labels.error);
          assert.equal(await error.count(), 1, 'The validation message belongs to the card footer');
          assert.equal(await save.isDisabled(), true);
          await footer.scrollIntoViewIfNeeded();
          const [message, cancelButton, saveButton] = await Promise.all([error.boundingBox(), cancel.boundingBox(), save.boundingBox()]);
          assert.ok(message.x + message.width <= cancelButton.x, 'The message fits to the left of the buttons');
          assert.equal(cancelButton.y, saveButton.y, 'The buttons stay on the same row');
          assert.equal(await footer.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
          await dialog.screenshot({ path: `${output}/${engine.name()}-${locale}-${width}.png` });

          await remotePort.fill(String(profile.port));
          assert.equal(await error.count(), 0, 'A valid port clears the message');
          assert.equal(await save.isEnabled(), true);
        }
        await cancel.click();
        await dialog.getByRole('button', { name: labels.create, exact: true }).waitFor();
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  console.log('Port-forward validation footer passed in Chromium and WebKit for both locales and widths.');
} finally {
  await server.close();
}
