import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const output = `${root}.phase4-acceptance/runtime-node-loading`;
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
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1418, 778, 428]) {
      await page.goto(`${server.resolvedUrls.local[0]}tests/deployment-ui/index.html?locale=${locale}&width=${width}&mode=runtime-rollback`);
      await page.getByTestId('deployment-runtime-step-list').waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (width < 1152) await page.getByTestId('deployment-open-runtime-inspector').click();
      // Exercise pending presentation using recorded nodes, without replacing IPC.
      const nodeIds = await page.evaluate(async () => {
        const { useDeploymentWorkflowRunStore: store } = await import('/src/stores/deploymentWorkflowRunStore.ts');
        return store.getState().nodes.filter(node => node.lastAttempt > 0).map(node => node.nodeId);
      });
      const positions = [];
      for (const nodeId of [...nodeIds, ...nodeIds].reverse()) {
        await page.evaluate(async id => {
          const { useDeploymentWorkflowRunStore: store } = await import('/src/stores/deploymentWorkflowRunStore.ts');
          store.setState({ selectedNodeId: id, attempts: [], loadingAttempts: true });
        }, nodeId);
        const fields = page.getByTestId('deployment-selected-attempt');
        await fields.waitFor();
        assert.equal(await fields.getAttribute('aria-busy'), 'true');
        const dimensions = await fields.evaluate(el => ({
          height: el.getBoundingClientRect().height,
          selectorHeight: el.previousElementSibling.getBoundingClientRect().height,
          progressTop: el.nextElementSibling.getBoundingClientRect().top,
        }));
        assert.equal(dimensions.height, 32, 'Loading fields must retain the two text lines');
        assert.equal(dimensions.selectorHeight, 32, 'Loading selector must match SelectTrigger size sm');
        positions.push(dimensions.progressTop);
      }
      assert(Math.max(...positions) - Math.min(...positions) <= 1, `${locale}/${width}: progress shifted during node switching`);
      await page.screenshot({ path: `${output}/${locale}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Node loading layout passed in six bilingual viewport cases.');
} finally {
  await browser?.close();
  await server.close();
}
