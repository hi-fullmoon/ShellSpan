import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Use a real, freshly generated SSH key. Only public metadata enters the browser.
const directory = await mkdtemp(join(tmpdir(), 'shellspan-credential-review-'));
const keyPath = join(directory, 'identity');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
const publicKey = await readFile(`${keyPath}.pub`, 'utf8');
const fingerprint = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`], { encoding: 'utf8' }).trim().split(/\s+/)[1];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async ({ publicKey, fingerprint, host, username }) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { KeychainPanel } = await import('/src/components/workbench/keychain-panel.tsx');
    const { useKeychainStore } = await import('/src/stores/keychainStore.ts');
    const { useProfileStore } = await import('/src/stores/profileStore.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    const profile = { id: 'local-ssh', name: host, host, port: 22, username, authMethod: 'key', keychainKeyId: 'generated-key', createdAt: Date.now(), updatedAt: Date.now() };
    useProfileStore.setState({ initialized: true, profiles: [profile] });
    useKeychainStore.setState({ initialized: true, loadError: undefined, keys: [
      { id: 'generated-key', label: 'OpenSSH · Ed25519', kind: 'keyFile', keyType: 'ssh-ed25519', service: 'com.shellspan.key', publicKey, fingerprint },
    ] });
    const appRoot = document.getElementById('root');
    if (appRoot) appRoot.style.display = 'none';
    const root = document.createElement('div');
    root.id = 'credential-review';
    root.style.cssText = 'position:fixed;inset:0;background:var(--background);';
    document.body.append(root);
    ReactDOM.createRoot(root).render(React.createElement(KeychainPanel));
  }, { publicKey, fingerprint, host: hostname(), username: userInfo().username });

  await mkdir('.drawer-review', { recursive: true });
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 720 });
    await page.getByRole('heading', { name: '凭据管理', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '新建', exact: true }).count(), 1);
    assert.equal(await page.getByText('SSH 密钥 · Ed25519', { exact: true }).count(), 1,
      await page.locator('#credential-review').innerText());
    const search = page.getByRole('textbox', { name: '搜索名称、类型或关联连接' });
    await search.fill(hostname());
    assert.equal(await page.getByText('OpenSSH · Ed25519', { exact: true }).count(), 1);
    await search.fill('登录密码');
    await page.getByText('没有匹配的凭据', { exact: true }).waitFor();
    await search.fill('');
    const layout = await page.locator('#credential-review').evaluate((root) => {
      const actions = root.querySelector('[data-slot="workbench-page-header-actions"]');
      const bounds = [...actions.children].map((element) => element.getBoundingClientRect());
      const grid = root.querySelector('.grid');
      return { tops: bounds.map((rect) => rect.top), right: Math.max(...bounds.map((rect) => rect.right)), width: root.clientWidth, gap: getComputedStyle(grid).gap };
    });
    assert.equal(new Set(layout.tops).size, 1, 'Header actions must remain on one row');
    assert.ok(layout.right <= layout.width, 'Header actions must fit the container');
    assert.equal(layout.gap, '12px');
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
    await page.screenshot({ path: `.drawer-review/credential-hover-${width}.png` });
    await page.mouse.move(0, 0);
    await search.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.ok(await actions.first().evaluate((button) => button === document.activeElement), 'Edit must remain keyboard reachable');
    assert.equal((await opacity())[0], '1', 'Keyboard focus must reveal the focused action');
    await search.focus();
    await page.screenshot({ path: `.drawer-review/credentials-${width}.png` });
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
    await page.screenshot({ path: `.drawer-review/credential-drawer-${width}.png` });
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '删除', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.waitFor();
    assert.ok((await confirmation.textContent()).includes(hostname()), 'Deletion must identify linked connections');
    assert.ok((await confirmation.textContent()).includes('服务器上的公钥授权不会被撤销'));
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await confirmation.waitFor({ state: 'hidden' });
  }
  console.log('Credential panel: metadata privacy, search, delete context and wide/narrow rendering passed.');
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
