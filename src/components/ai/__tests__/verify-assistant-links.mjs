import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

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
  optimizeDeps: { entries: ['src/components/ai/assistant-message-content.tsx'], include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
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
let clipboardBrowser;
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
    await import('/src/styles/base.css');
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
  await link.hover();
  assert.equal(await link.evaluate(element => getComputedStyle(element).cursor), 'default', 'Markdown links use the default cursor');
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
  clipboardBrowser = await chromium.launch();
  const clipboardContext = await clipboardBrowser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    reducedMotion: 'reduce',
  });
  clipboardContext.setDefaultTimeout(15_000);
  const filePage = await clipboardContext.newPage();
  await filePage.goto(origin);
  const path = fileURLToPath(new URL('../../../../AGENTS.md', import.meta.url));
  await filePage.evaluate(async ({ path, uri }) => {
    await import('/src/styles/base.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AssistantMessageContent } = await import('/src/components/ai/assistant-message-content.tsx');
    const container = document.getElementById('root');
    container.style.textAlign = 'right';
    container.style.padding = '16px';
    const blocks = [
      { type: 'text', text: `[项目说明](${uri}#L12-L14)\n\n\`${path}\`\n\n\`\`\`\n${path}\n\`\`\`` },
    ];
    ReactDOM.createRoot(container).render(React.createElement(AssistantMessageContent, { blocks, streaming: false }));
  }, { path, uri: new URL('../../../../AGENTS.md', import.meta.url).href });

  const fileLink = filePage.getByRole('link', { name: '项目说明' });
  const fileMenu = filePage.getByRole('menu', { name: '文件操作' });
  const openWith = fileMenu.getByRole('menuitem', { name: '打开方式' });
  const submenu = filePage.getByRole('menu', { name: '打开方式' });
  await fileLink.waitFor();
  assert.equal(await filePage.getByRole('link', { name: path, exact: true }).count(), 1, 'the fenced block remains code');
  for (const width of [1000, 320]) {
    await filePage.setViewportSize({ width, height: 440 });
    await fileLink.click({ button: 'right' });
    await fileMenu.getByRole('menuitem', { name: '另存为…' }).waitFor();
    await fileMenu.getByRole('menuitem', { name: '复制文件内容' }).waitFor();
    await openWith.hover();
    await submenu.getByRole('menuitem', { name: '默认应用' }).waitFor();
    for (const popup of [fileMenu, submenu]) {
      const box = await popup.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'menu fits in the viewport');
    }
    await filePage.keyboard.press('Escape');
    await submenu.waitFor({ state: 'hidden' });
    await fileMenu.getByRole('menuitem', { name: '复制路径' }).click();
    assert.equal(await filePage.evaluate(() => navigator.clipboard.readText()), path);
    await fileMenu.waitFor({ state: 'hidden' });
  }
  await fileLink.focus();
  await filePage.keyboard.press('Shift+F10');
  await fileMenu.waitFor();
  await openWith.focus();
  await filePage.keyboard.press('ArrowRight');
  await submenu.waitFor();
  await filePage.keyboard.press('Escape');
  await submenu.waitFor({ state: 'hidden' });
  await filePage.keyboard.press('Escape');
  await fileMenu.waitFor({ state: 'hidden' });
  assert(await fileLink.evaluate(element => element === document.activeElement), 'focus returns to the file link');

  const remotePage = await clipboardContext.newPage();
  await remotePage.goto(origin);
  await remotePage.evaluate(async () => {
    await import('/src/styles/base.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiMarkdownTargetContext, AssistantMessageContent } = await import('/src/components/ai/assistant-message-content.tsx');
    const content = React.createElement(AssistantMessageContent, {
      blocks: [{ type: 'text', text: '当前目录为 `/root`。\n\n`/var/log/worker:2026`\n\n[服务器根目录](/)' }],
      streaming: false,
    });
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiMarkdownTargetContext.Provider, {
      value: { kind: 'remote' },
    }, content));
  });
  const remoteMenu = remotePage.getByRole('menu', { name: '文件操作' });
  const remotePath = remotePage.getByRole('link', { name: '/root', exact: true });
  for (const width of [1000, 320]) {
    await remotePage.setViewportSize({ width, height: 440 });
    await remotePath.click({ button: 'right' });
    await remoteMenu.waitFor();
    assert.deepEqual(await remoteMenu.getByRole('menuitem').allTextContents(), ['复制路径', '在 SFTP 中定位']);
    const box = await remoteMenu.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'remote menu fits in the viewport');
    await remoteMenu.getByRole('menuitem', { name: '复制路径' }).click();
    assert.equal(await remotePage.evaluate(() => navigator.clipboard.readText()), '/root');
    await remoteMenu.waitFor({ state: 'hidden' });
  }
  const remoteLink = remotePage.getByRole('link', { name: '服务器根目录' });
  await remoteLink.focus();
  await remotePage.keyboard.press('Shift+F10');
  await remoteMenu.getByRole('menuitem', { name: '在 SFTP 中定位' }).waitFor();
  await remotePage.keyboard.press('Escape');
  await remoteMenu.waitFor({ state: 'hidden' });
  assert(await remoteLink.evaluate(element => element === document.activeElement), 'focus returns to the remote path');
  await remotePage.getByRole('link', { name: '/var/log/worker:2026', exact: true }).click({ button: 'right' });
  await remoteMenu.getByRole('menuitem', { name: '复制路径' }).click();
  assert.equal(await remotePage.evaluate(() => navigator.clipboard.readText()), '/var/log/worker:2026');
  process.stdout.write('PASS: WebKit link navigation and Chromium local and remote path menus, keyboard and clipboard.\n');
} finally {
  await clipboardBrowser?.close();
  await browser?.close();
  await server.close();
}
