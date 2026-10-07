import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = await readFile(`${root}package.json`, 'utf8');
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'tool-output-artifact-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell" style="height:100vh"></main></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(async ({ output, root }) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
    const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const artifact = {
      kind: 'artifact', key: 'artifact:package-json', artifactId: 'package-json',
      artifactKind: 'tool-result', title: 'Output for read_file',
      sizeBytes: new TextEncoder().encode(output).length,
      sessionId: 'browser-check', turnId: null, stepId: null,
      sourceKind: 'agent', firstSeq: 1, lastSeq: 1, timestamp: new Date().toISOString(),
      mediaType: 'application/json', sha256: null, sensitivity: 'internal',
    };
    const tool = {
      ...artifact, kind: 'tool', key: 'tool:read-package', callId: 'read-package',
      name: 'read_file', nativeName: null, state: 'succeeded', summary: root + 'package.json',
      input: { path: root + 'package.json' }, output: { artifactRef: artifact.artifactId, truncated: true },
      error: null, durationMs: null, effect: 'readOnly', idempotency: null, target: null, approval: null, evidenceRefs: [],
    };
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement('section', { id: 'conversation' }, React.createElement(AiConversationNodeList, { nodes: [artifact] })),
      React.createElement(AiToolDetails, { node: tool, artifacts: [artifact], onBack() {}, onOpenArtifact(node) {
        document.getElementById('root').dataset.openedArtifact = node.artifactId;
      } }),
    ));
  }, { output, root });
  const outputAction = page.locator('.ai-detail-section').nth(1).getByRole('button').filter({ hasText: '输出' });
  await outputAction.waitFor();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('#conversation').evaluate(element => element.childElementCount), 0);
    const bounds = await outputAction.boundingBox();
    assert.ok(bounds && bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= width);
    await outputAction.click();
    assert.equal(await page.locator('#root').getAttribute('data-opened-artifact'), 'package-json');
    await page.screenshot({ path: `/tmp/shellspan-tool-output-${width}.png` });
  }
} finally {
  await browser?.close();
  await server.close();
}
