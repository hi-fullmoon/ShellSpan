import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// Use a real, freshly generated SSH key. Only public metadata enters the browser.
const directory = await mkdtemp(join(tmpdir(), 'shellspan-credential-review-'));
const keyPath = join(directory, 'identity');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
const publicKey = await readFile(`${keyPath}.pub`, 'utf8');
const fingerprint = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`], { encoding: 'utf8' }).trim().split(/\s+/)[1];
const host = hostname();
const username = userInfo().username;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
// Mount the real panel without starting the desktop app in the same document.
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  cacheDir: join(directory, 'vite'),
  logLevel: 'error',
  resolve: { alias: { '@': join(root, 'src') } },
  plugins: [tailwindcss(), {
    name: 'credential-panel-review',
    resolveId(id) { if (id === '/credential-runtime.js') return id; },
    load(id) {
      if (id === '/credential-runtime.js') return `
        import '/src/styles/base.css';
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { KeychainPanel } from '@/components/workbench/keychain-panel.tsx';
        export { useKeychainStore } from '@/stores/keychainStore';
        export { useProfileStore } from '@/stores/profileStore';
        export { useAppStore } from '@/stores/appStore';
        export { initI18n } from '@/locales';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="credential-review" style="position:fixed;inset:0"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, forwardConsole: false },
});
const browserType = process.argv.includes('--webkit') ? webkit : chromium;
let browser;
try {
  await server.listen();
  browser = await browserType.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async ({ publicKey, fingerprint, host, username }) => {
    const {
      React, createRoot, KeychainPanel, useKeychainStore, useProfileStore, useAppStore, initI18n,
    } = await import('/credential-runtime.js');
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    const profile = { id: 'local-ssh', name: host, host, port: 22, username, authMethod: 'key', keychainKeyId: 'generated-key', createdAt: Date.now(), updatedAt: Date.now() };
    useProfileStore.setState({ initialized: true, profiles: [profile] });
    useKeychainStore.setState({ initialized: true, loadError: undefined, keys: [
      { id: 'generated-key', label: 'OpenSSH · Ed25519', kind: 'keyFile', keyType: 'ssh-ed25519', service: 'com.shellspan.key', publicKey, fingerprint },
    ] });
    createRoot(document.getElementById('credential-review')).render(React.createElement(KeychainPanel));
  }, { publicKey, fingerprint, host, username });
  // The browser has no native IPC, so the refresh fails while the cached key remains available.
  await page.waitForFunction(async () => {
    const { useKeychainStore } = await import('/credential-runtime.js');
    const { initialized, keys } = useKeychainStore.getState();
    return !initialized && keys.length > 0;
  });

  await mkdir('artifacts/tests/workbench', { recursive: true });
  const widths = process.argv.includes('--search-only') ? [1440, 960, 420, 360] : [1440, 960, 420];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 720 });
    await page.getByRole('heading', { name: '凭据管理', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '新建', exact: true }).count(), 1);
    const search = page.getByRole('textbox', { name: '搜索名称、类型、账号、主机或端口' });
    const searchLayout = await search.evaluate((input) => {
      const group = input.closest('[data-slot="input-group"]');
      const actions = group.parentElement;
      const bounds = [...actions.children].map((element) => element.getBoundingClientRect());
      return {
        width: group.getBoundingClientRect().width,
        tops: bounds.map((rect) => rect.top),
        right: Math.max(...bounds.map((rect) => rect.right)),
        containerRight: actions.getBoundingClientRect().right,
      };
    });
    assert.ok(searchLayout.width <= 256, 'Search must not grow beyond the connection manager search width');
    if (width >= 960) assert.equal(searchLayout.width, 256);
    if (width === 360) assert.ok(searchLayout.width < 256, 'Search must shrink in narrow containers');
    assert.equal(new Set(searchLayout.tops).size, 1, 'Search and actions must remain on one row');
    assert.ok(searchLayout.right <= searchLayout.containerRight, 'Search must shrink to keep actions visible');
    if (process.argv.includes('--search-only')) {
      await page.screenshot({ path: `artifacts/tests/workbench/credential-search-${width}.png` });
      continue;
    }
    assert.equal(await page.getByText('SSH 密钥 · Ed25519', { exact: true }).count(), 1,
      await page.locator('#credential-review').innerText());
    const help = page.getByRole('button', { name: '凭据管理说明', exact: true });
    const description = '安全保存连接密码和 SSH 密钥，凭据由系统钥匙串保护。';
    assert.equal(await page.getByText(description, { exact: true }).count(), 0);
    const cardTop = await page.locator('#credential-review .grid').evaluate((grid) => grid.getBoundingClientRect().top);
    await help.click();
    const helpPanel = page.getByRole('dialog', { name: '凭据管理说明' });
    await helpPanel.waitFor();
    await helpPanel.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    assert.ok((await helpPanel.innerText()).includes(description));
    assert.equal(await page.locator('#credential-review .grid').evaluate((grid) => grid.getBoundingClientRect().top), cardTop);
    await page.screenshot({ path: `artifacts/tests/workbench/credential-help-${width}.png` });
    await page.keyboard.press('Escape');
    const popup = page.locator('[data-slot="popover-content"]');
    await popup.waitFor({ state: 'detached' });
    await help.press('Enter');
    await helpPanel.waitFor();
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'detached' });
    assert.ok(await help.evaluate((button) => button === document.activeElement), 'Escape must return focus to Help');
    await help.press('Enter');
    await helpPanel.waitFor();
    await page.mouse.click(width - 10, 700);
    await helpPanel.waitFor({ state: 'hidden' });
    if (process.argv.includes('--help-only')) continue;
    const association = page.getByText(`用于：${username}@${host}:22`, { exact: true });
    await association.waitFor();
    await search.fill('登录密码');
    await page.getByText('没有匹配的凭据', { exact: true }).waitFor();
    await search.fill(host);
    await association.waitFor();
    await search.fill('');
    const layout = await page.locator('#credential-review').evaluate((root) => {
      const actions = root.querySelector('[data-slot="workbench-page-header-actions"]');
      const bounds = [...actions.children].map((element) => element.getBoundingClientRect());
      const grid = root.querySelector('.grid');
      return { tops: bounds.map((rect) => rect.top), right: Math.max(...bounds.map((rect) => rect.right)), width: root.clientWidth, gap: getComputedStyle(grid).gap };
    });
    assert.equal(new Set(layout.tops).size, 1, 'Header actions must remain on one row');
    assert.ok(layout.right <= layout.width, 'Header actions must fit the container');
    assert.equal(layout.gap, '8px');
    const card = page.locator('#credential-review .grid > *').first();
    const actions = card.getByRole('button');
    await page.mouse.move(0, 0);
    const opacity = () => actions.evaluateAll(async (buttons) => {
      await Promise.all(buttons.flatMap((button) => button.getAnimations().map((animation) => animation.finished)));
      return buttons.map((button) => getComputedStyle(button).opacity);
    });
    assert.deepEqual(await opacity(), ['0', '0'], 'Card actions must be hidden at rest');
    await card.hover();
    assert.deepEqual(await opacity(), ['1', '1'], 'Hovering anywhere on the card must reveal both actions');
    await page.screenshot({ path: `artifacts/tests/workbench/credential-hover-${width}.png` });
    await page.mouse.move(0, 0);
    await search.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.ok(await actions.first().evaluate((button) => button === document.activeElement), 'Edit must remain keyboard reachable');
    assert.equal((await opacity())[0], '1', 'Keyboard focus must reveal the focused action');
    await search.focus();
    await page.screenshot({ path: `artifacts/tests/workbench/credentials-${width}.png` });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const drawer = page.getByRole('dialog');
    await drawer.waitFor();
    await drawer.evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    assert.equal(await drawer.getByLabel('私钥', { exact: true }).count(), 0, 'Editing metadata must not expose a private key');
    assert.equal(await drawer.getByText(fingerprint, { exact: true }).count(), 1);
    assert.ok(await drawer.getByLabel('公钥', { exact: true }).getAttribute('readonly') !== null);
    await drawer.getByRole('button', { name: '替换私钥', exact: true }).click();
    assert.equal(await drawer.getByLabel('私钥', { exact: true }).inputValue(), '');
    assert.equal(await drawer.getByLabel('公钥', { exact: true }).inputValue(), '');
    await page.setViewportSize({ width, height: 480 });
    await drawer.evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    const scrollLayout = await drawer.evaluate((element) => {
      const viewport = element.querySelector('[data-slot="scroll-area-viewport"]');
      const footer = element.querySelector('[data-slot="drawer-footer"]');
      return { scrollable: viewport.scrollHeight > viewport.clientHeight, footerBottom: footer.getBoundingClientRect().bottom, height: window.innerHeight, border: getComputedStyle(footer).borderTopWidth };
    });
    assert.ok(scrollLayout.scrollable, 'Short windows need a scrolling form');
    assert.ok(scrollLayout.footerBottom <= scrollLayout.height, 'Save must remain visible');
    assert.equal(scrollLayout.border, '0px');
    await page.screenshot({ path: `artifacts/tests/workbench/credential-drawer-${width}.png` });
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '删除', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.waitFor();
    assert.ok((await confirmation.textContent()).includes(host), 'Deletion must identify linked connections');
    assert.ok((await confirmation.textContent()).includes('服务器上的公钥授权不会被撤销'));
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await confirmation.waitFor({ state: 'hidden' });
  }
  console.log(process.argv.includes('--search-only')
    ? 'Credential search: fixed width and narrow container shrinking passed.'
    : process.argv.includes('--help-only')
    ? 'Credential help: wide/narrow rendering, keyboard, outside dismissal and stable layout passed.'
    : `Credential panel (${browserType.name()}): help, metadata privacy, search, delete context and wide/narrow rendering passed.`);
} finally {
  await browser?.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
