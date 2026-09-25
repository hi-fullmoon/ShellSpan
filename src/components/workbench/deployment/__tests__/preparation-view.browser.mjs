import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const output = `${root}.phase4-acceptance/preparation-view`;
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
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${server.resolvedUrls.local[0]}tests/deployment-ui/index.html?locale=${locale}&width=${width}&mode=empty`);
      await page.getByTestId('deployment-run-empty-cta').waitFor();
      // Exercise transient UI state only; no IPC or deployment results are substituted.
      await page.evaluate(async () => {
        const { useDeploymentWorkflowRunStore: store } = await import('/src/stores/deploymentWorkflowRunStore.ts');
        store.setState({ preparing: true });
      });
      const view = page.getByTestId('deployment-preparation-view');
      await page.getByTestId('deployment-preparing-progress').waitFor();
      assert.equal(await page.getByTestId('deployment-run-empty-cta').count(), 0);
      assert.equal(await view.getByRole('button').count(), 0);
      assert(await view.evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: `${output}/${locale}-${width}.png` });
      await page.evaluate(async () => {
        const { useDeploymentWorkflowRunStore: store } = await import('/src/stores/deploymentWorkflowRunStore.ts');
        store.setState({ preparing: false, error: 'DEPLOYMENT_APPLICATION_READINESS_REQUIRED', errorContext: 'prepare' });
      });
      const alert = page.getByTestId('deployment-prepare-error');
      await alert.waitFor();
      assert(!(await alert.textContent()).includes('DEPLOYMENT_APPLICATION_READINESS_REQUIRED'));
      assert.equal(await view.getByRole('button').count(), 1);
      const action = alert.getByRole('button');
      const actionBounds = await action.boundingBox();
      assert(actionBounds && actionBounds.x + actionBounds.width <= width);
      await action.focus();
      assert(await action.evaluate(el => document.activeElement === el));
      assert(await view.evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: `${output}/readiness-${locale}-${width}.png` });
      await page.evaluate(async () => {
        const { useDeploymentWorkflowRunStore: store } = await import('/src/stores/deploymentWorkflowRunStore.ts');
        store.setState({ error: 'DEPLOYMENT_APPLICATION_MANAGED_FIELDS_CHANGED', errorContext: 'prepare' });
      });
      await page.getByRole('button', { name: locale === 'zh-CN' ? '源码、数据与部署检查' : 'Source, data and deployment checks', exact: true }).waitFor();
      assert(!(await alert.textContent()).includes('DEPLOYMENT_APPLICATION_MANAGED_FIELDS_CHANGED'));
      assert(await view.evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: `${output}/managed-fields-${locale}-${width}.png` });
      await page.evaluate(async () => {
        const { useDeploymentWorkflowRunStore: store } = await import('/src/stores/deploymentWorkflowRunStore.ts');
        store.setState({ error: 'DEPLOYMENT_APPLICATION_REVISION_CONFLICT', errorContext: 'prepare' });
      });
      await alert.getByText(locale === 'zh-CN' ? '部署配置版本已更新' : 'Deployment configuration has changed', { exact: true }).waitFor();
      assert(!(await alert.textContent()).includes('DEPLOYMENT_APPLICATION_REVISION_CONFLICT'));
      assert(await view.evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: `${output}/revision-conflict-${locale}-${width}.png` });
      await page.goto(`${server.resolvedUrls.local[0]}tests/deployment-ui/index.html?locale=${locale}&width=${width}&mode=empty&configured`);
      await page.getByTestId('deployment-run-empty-cta').waitFor();
      await page.evaluate(async () => {
        const { default: evidence } = await import('/docs/design/deployment-center-product-phase-2-evidence.json');
        const { useDeploymentWorkflowStore: workflows } = await import('/src/stores/deploymentWorkflowStore.ts');
        const { useDeploymentWorkflowRunStore: runs } = await import('/src/stores/deploymentWorkflowRunStore.ts');
        const edited = structuredClone(evidence.workflow);
        const build = edited.definition.nodes.find(node => node.type === 'build.docker-buildx');
        // Present an editor change to recorded configuration; never replace an IPC response.
        build.config.platform = evidence.entry.environment.config.platform === 'linux/arm64' ? 'linux/amd64' : 'linux/arm64';
        workflows.setState({ workflows: [edited] });
        runs.setState({ error: 'DEPLOYMENT_APPLICATION_MANAGED_FIELDS_CHANGED', errorContext: 'prepare' });
      });
      await page.getByRole('button', { name: locale === 'zh-CN' ? '源码、数据与部署检查' : 'Source, data and deployment checks', exact: true }).click();
      const configuration = page.getByRole('dialog');
      const adopt = configuration.getByRole('button', { name: locale === 'zh-CN' ? '采用工作流配置' : 'Use workflow configuration' });
      await adopt.waitFor();
      const save = configuration.locator('[data-slot="dialog-footer"] button').last();
      assert(await save.isDisabled());
      await adopt.click();
      assert(await save.isEnabled());
      assert(await configuration.evaluate(el => el.scrollWidth <= el.clientWidth));
      const saveBounds = await save.boundingBox();
      assert(saveBounds && saveBounds.y + saveBounds.height <= 700 && saveBounds.x + saveBounds.width <= width);
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))));
      await page.screenshot({ path: `${output}/reconcile-${locale}-${width}.png` });
      await page.goto(`${server.resolvedUrls.local[0]}tests/deployment-ui/index.html?locale=${locale}&width=${width}&mode=validation`);
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const validate = dialog.locator('[data-slot="dialog-footer"] button').last();
      await validate.click();
      await dialog.getByRole('status').waitFor();
      assert(await validate.isDisabled());
      const footerBounds = await validate.boundingBox();
      assert(footerBounds && footerBounds.x + footerBounds.width <= width && footerBounds.y + footerBounds.height <= 700);
      assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: `${output}/validation-${locale}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Preparation view passed bilingual wide and narrow rendering checks.');
} finally {
  await browser?.close();
  await server.close();
}
