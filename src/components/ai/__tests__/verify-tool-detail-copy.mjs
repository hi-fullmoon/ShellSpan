import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'tool-detail-copy-check',
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
  browser = await webkit.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    // Reproduce the tool payload and failure shown in the reported screenshot.
    const error = 'native result evidence did not match the frozen call';
    const node = {
      kind: 'tool', name: 'wait_process', nativeName: null,
      state: 'failed', summary: error, durationMs: null,
      input: { maxOutputBytes: 2048, processHandle: 'proc-1f7278e9267f4637a717a4888f5681e6', timeoutMs: 2000 },
      output: error, error, effect: 'readOnly', idempotency: 'yes',
      target: { kind: 'local', label: 'zsh' }, approval: null, evidenceRefs: [],
    };
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiToolDetails, { node, onBack() {} }));
  });
  await page.locator('.ai-detail-section').first().waitFor();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    const positions = await page.locator('.ai-tool-copy-button').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      const header = button.closest('.ai-detail-section-header').getBoundingClientRect();
      return { right: rect.right, width: rect.width, centerOffset: (rect.top + rect.bottom - header.top - header.bottom) / 2 };
    }));
    assert.equal(positions.length, 3);
    assert.ok(positions.every((position) => Math.abs(position.right - positions[0].right) < 1));
    assert.ok(positions.every((position) => position.right <= width && position.width > 0 && Math.abs(position.centerOffset) < 1));
    await page.screenshot({ path: `/tmp/shellspan-tool-detail-copy-${width}.png`, fullPage: true });
    process.stdout.write(`Verified copy alignment at ${width}px\n`);
  }
} finally {
  await browser?.close();
  await server.close();
}
