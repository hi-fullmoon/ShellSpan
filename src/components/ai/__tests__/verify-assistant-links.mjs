import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';
import { createServer } from 'vite';

// Run with: node src/components/ai/__tests__/verify-assistant-links.mjs
// Exercise real links and popup navigation without replacing browser or IPC APIs.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'assistant-links-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/' && request.url !== '/destination') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root"></main></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await webkit.launch();
  const context = await browser.newContext();
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async (origin) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AssistantMessageContent } = await import('/src/components/ai/assistant-message-content.tsx');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AssistantMessageContent, {
      blocks: [{ type: 'text', text: `[Open preview](${origin}/destination)` }],
      streaming: false,
    }));
    document.addEventListener('click', (event) => {
      if (event.target.closest('a')) document.body.dataset.linkDefaultPrevented = String(event.defaultPrevented);
    });
  }, origin);
  const link = page.getByRole('link', { name: 'Open preview' });
  await link.waitFor();
  assert.equal(await link.getAttribute('href'), `${origin}/destination`);
  for (const modifiers of [[], ['Meta']]) {
    const popupPromise = context.waitForEvent('page');
    await link.click({ modifiers });
    const popup = await popupPromise;
    await popup.waitForURL(`${origin}/destination`);
    assert.equal(await page.locator('body').getAttribute('data-link-default-prevented'), 'true');
    await popup.close();
  }
  const popupPromise = context.waitForEvent('page');
  await link.focus();
  await page.keyboard.press('Enter');
  const popup = await popupPromise;
  await popup.waitForURL(`${origin}/destination`);
  await popup.close();
  process.stdout.write('PASS: WebKit click, Command-click and Enter open the destination through the link handler.\n');
} finally {
  await browser?.close();
  await server.close();
}
