import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const content = await readFile(join(root, 'AGENTS.md'), 'utf8');
const screenshots = join(tmpdir(), 'shellspan-user-message-collapse');
const browserType = process.env.SHELLSPAN_COLLAPSE_BROWSER === 'webkit' ? webkit : chromium;
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'user-message-collapse-regression',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell"></main></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await browserType.launch();
  const page = await browser.newPage(browserType === chromium
    ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(async (content) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
    const { AiConversation } = await import('/src/components/ai/workspace/ai-conversation.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const base = {
      kind: 'userMessage', sourceKind: 'agent', sessionId: 'collapse-regression',
      turnId: null, stepId: null, firstSeq: 1, lastSeq: 1,
      timestamp: new Date().toISOString(), delivery: 'committed',
    };
    const lines = content.split('\n');
    const paragraph = lines.reduce((longest, line) => line.length > longest.length ? line : longest, '');
    if (!paragraph) throw new Error('Repository guide must contain a long paragraph');
    const shortLines = lines.filter((line) => line.length > 0 && line.length < 30);
    const nodes = [
      { ...base, key: 'six', messageId: 'six', content: shortLines.slice(0, 6).join('\n') },
      { ...base, key: 'seven', messageId: 'seven', content: shortLines.slice(0, 7).join('\n') },
      { ...base, key: 'wrapped', messageId: 'wrapped', content: paragraph },
      { ...base, key: 'full', messageId: 'full', content },
    ];
    const reactRoot = ReactDOM.createRoot(document.getElementById('root'));
    Object.assign(window, {
      renderCollapseConversation(delivery = 'committed') {
        reactRoot.render(React.createElement('div', { className: 'flex h-dvh flex-col' },
          React.createElement(AiConversation, {
            nodes: [{ ...nodes[3], delivery, lastSeq: delivery === 'pending' ? 1 : 2 }],
            status: 'completed', throughSeq: 2,
          }),
        ));
      },
    });
    reactRoot.render(
      React.createElement(AiConversationNodeList, { nodes }),
    );
  }, content);
  const node = (key) => page.locator(`[data-ai-node-key="${key}"]`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await node('full').getByRole('button', { name: '展开全文' }).waitFor();
  assert.equal(await node('six').getByRole('button', { name: '展开全文' }).count(), 0);
  await node('seven').getByRole('button', { name: '展开全文' }).waitFor();
  assert.equal(await node('wrapped').getByRole('button', { name: '展开全文' }).count(), 0);
  for (const width of [380, 720]) {
    await page.setViewportSize({ width, height: 900 });
    const text = node('full').locator('.ai-user-message-text');
    const collapsed = await text.boundingBox();
    const lineHeight = await text.evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
    assert.ok(Math.abs(collapsed.height - lineHeight * 6) <= 1, 'Preview must occupy exactly six rendered lines');
    const toggle = node('full').getByRole('button', { name: '展开全文' });
    const toggleBox = await toggle.boundingBox();
    assert.ok(Math.abs(toggleBox.x - collapsed.x) <= 1, 'Toggle text must align with the message text');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const style = await toggle.evaluate((element) => {
        const computed = getComputedStyle(element);
        const content = getComputedStyle(element.previousElementSibling);
        return {
          left: computed.paddingLeft, right: computed.paddingRight,
          color: computed.color, contentColor: content.color,
        };
      });
      assert.equal(style.left, '0px');
      assert.equal(style.right, '0px');
      assert.notEqual(style.color, style.contentColor, 'Toggle must use a secondary color in both themes');
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.getAttribute('aria-controls'), await text.getAttribute('id'));
    await toggle.focus();
    await page.keyboard.press('Enter');
    await node('full').getByRole('button', { name: '收起' }).waitFor();
    assert.ok((await text.boundingBox()).height > collapsed.height);
    await page.setViewportSize({ width: width + 20, height: 900 });
    assert.equal(await node('full').getByRole('button', { name: '收起' }).getAttribute('aria-expanded'), 'true');
    await node('full').getByRole('button', { name: '收起' }).click();
    await node('full').getByRole('button', { name: '展开全文' }).waitFor();
    await page.screenshot({ path: join(screenshots, `${browserType.name()}-${width}-collapsed.png`) });
  }
  await page.setViewportSize({ width: 280, height: 900 });
  await node('wrapped').getByRole('button', { name: '展开全文' }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => !document.querySelector('[data-ai-node-key="wrapped"] button[aria-controls]'));
  if (browserType === chromium) {
    await node('full').getByRole('button', { name: '复制', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), content);
  }
  await page.evaluate(async () => {
    const { initI18n } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
  });
  await node('full').getByRole('button', { name: 'Show more', exact: true }).waitFor();
  await node('full').getByRole('button', { name: 'Show more', exact: true }).click();
  await node('full').getByRole('button', { name: 'Show less', exact: true }).waitFor();
  await page.evaluate(() => window.renderCollapseConversation('pending'));
  await node('full').getByRole('button', { name: 'Show more', exact: true }).waitFor();
  await node('full').getByRole('button', { name: 'Show more', exact: true }).click();
  await node('full').getByRole('button', { name: 'Show less', exact: true }).waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const viewport = page.locator('[data-message-scroller-viewport]');
  const expandedTop = await node('full').locator('.ai-user-message-text').boundingBox();
  const viewportBox = await viewport.boundingBox();
  assert.ok(expandedTop.y >= viewportBox.y - 1, 'Expanding a message must keep its opening text visible');
  await page.screenshot({ path: join(screenshots, `${browserType.name()}-conversation-expanded.png`) });
  await page.evaluate(() => window.renderCollapseConversation('committed'));
  assert.equal(await node('full').getByRole('button', { name: 'Show less', exact: true }).getAttribute('aria-expanded'), 'true');
  await node('full').getByRole('button', { name: 'Show less', exact: true }).click();
  await node('full').getByRole('button', { name: 'Show more', exact: true }).waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const collapsedScroll = await viewport.evaluate((element) => ({ height: element.scrollHeight, client: element.clientHeight }));
  assert.ok(collapsedScroll.height <= collapsedScroll.client + 1, 'Collapsing a single message must not leave an empty scroll spacer');
  assert.deepEqual(errors, []);
  console.log('User message collapse browser regression passed');
} finally {
  await browser?.close();
  await server.close();
}
