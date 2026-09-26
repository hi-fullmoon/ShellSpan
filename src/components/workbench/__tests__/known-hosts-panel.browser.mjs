import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Real OpenSSH keys provide public metadata; no IPC or store action is replaced.
const directory = await mkdtemp(join(tmpdir(), 'shellspan-known-hosts-'));
const hosts = ['ed25519', 'ecdsa'].map((algorithm) => {
  const path = join(directory, algorithm);
  execFileSync('ssh-keygen', ['-q', '-t', algorithm, '-N', '', '-f', path]);
  const fingerprint = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${path}.pub`], { encoding: 'utf8' }).trim().split(/\s+/)[1];
  const keyType = algorithm.toUpperCase();
  return { host: hostname(), port: 22, keyType, fingerprint: `${keyType} ${fingerprint}` };
});
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { KnownHostsPanel } = await import('/src/components/workbench/known-hosts-panel.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    document.getElementById('root').style.display = 'none';
    const root = document.createElement('div');
    root.id = 'known-hosts-review';
    root.style.cssText = 'position:fixed;inset:0;background:var(--background)';
    document.body.append(root);
    ReactDOM.createRoot(root).render(React.createElement(KnownHostsPanel));
  });
  // A browser has no native IPC. Verify that the real load failure is presented,
  // then exercise the view with actual generated public-key metadata.
  await page.getByText('加载失败', { exact: true }).waitFor();
  await page.evaluate(async (hosts) => {
    const { useKnownHostsStore } = await import('/src/stores/knownHostsStore.ts');
    useKnownHostsStore.setState({ hosts, error: undefined, loading: false });
  }, hosts);
  await mkdir('.drawer-review', { recursive: true });
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 720 });
    await page.getByRole('button', { name: '复制 ED25519 指纹', exact: true }).waitFor();
    assert.ok((await page.locator('#known-hosts-review').innerText()).includes('1 个主机 · 2 条密钥'), await page.locator('#known-hosts-review').innerText());
    assert.equal(await page.locator('#known-hosts-review .grid > *').count(), 1);
    const search = page.getByRole('textbox', { name: '搜索主机、端口、指纹或密钥类型' });
    await search.fill('ECDSA');
    await page.getByText('匹配 1 个主机 · 1/2 条密钥', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '复制 ED25519 指纹', exact: true }).count(), 0);
    await search.fill('');
    const copyButton = page.getByRole('button', { name: '复制 ED25519 指纹', exact: true });
    await page.mouse.move(0, 0);
    assert.equal(await copyButton.evaluate((button) => getComputedStyle(button).opacity), '0');
    await copyButton.locator('xpath=../..').hover();
    assert.equal(await copyButton.evaluate((button) => getComputedStyle(button).opacity), '1');
    const otherCopy = page.getByRole('button', { name: '复制 ECDSA 指纹', exact: true });
    assert.equal(await otherCopy.evaluate((button) => getComputedStyle(button).opacity), '0', 'Hover should reveal only the matching fingerprint action');
    await page.mouse.move(0, 0);
    await copyButton.focus();
    assert.equal(await copyButton.evaluate((button) => getComputedStyle(button).opacity), '1');
    const copyStyle = await copyButton.evaluate((button) => {
      const icon = button.querySelector('svg').getBoundingClientRect();
      const label = button.closest('.flex.items-start').querySelector('.text-muted-foreground');
      return { width: icon.width, height: icon.height, color: getComputedStyle(button).color,
        buttonWidth: button.getBoundingClientRect().width,
        buttonHeight: button.getBoundingClientRect().height,
        position: getComputedStyle(button).position,
        labelColor: getComputedStyle(label).color, focused: document.activeElement === button };
    });
    assert.equal(copyStyle.width, 12, 'Copy icon should match the secondary fingerprint icon size');
    assert.equal(copyStyle.height, 12);
    assert.equal(copyStyle.buttonWidth, 24, 'Copy hover background must remain compact');
    assert.equal(copyStyle.buttonHeight, 24);
    await copyButton.hover();
    await page.screenshot({ path: `.drawer-review/known-hosts-copy-hover-${width}.png` });
    assert.equal(copyStyle.position, 'absolute', 'Copy must not reserve fingerprint text width');
    assert.equal(copyStyle.color, copyStyle.labelColor, 'Copy should use the secondary text color');
    assert.equal(copyStyle.focused, true, 'Copy must remain keyboard focusable');
    await page.getByRole('button', { name: '复制 ED25519 指纹', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), hosts[0].fingerprint.slice('ED25519 '.length));
    const help = page.getByRole('button', { name: '已知主机说明', exact: true });
    const headerHeights = await help.evaluate((button) => {
      const header = button.closest('header');
      const actual = header.getBoundingClientRect().height;
      button.style.display = 'none';
      const withoutHelp = header.getBoundingClientRect().height;
      button.style.removeProperty('display');
      return { actual, withoutHelp };
    });
    assert.equal(headerHeights.actual, headerHeights.withoutHelp, 'Help must not increase the default header height');
    const cardTop = await page.locator('#known-hosts-review .grid').evaluate((grid) => grid.getBoundingClientRect().top);
    assert.equal(await page.getByText('如何核对指纹', { exact: true }).count(), 0);
    await help.click();
    const popover = page.getByRole('dialog', { name: '已知主机说明' });
    await popover.waitFor();
    await popover.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    assert.ok((await popover.innerText()).includes('已记录不代表服务器当前安全或在线'));
    assert.equal(await page.locator('#known-hosts-review .grid').evaluate((grid) => grid.getBoundingClientRect().top), cardTop);
    await page.screenshot({ path: `.drawer-review/known-hosts-help-${width}.png` });
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'hidden' });
    await help.focus();
    await page.keyboard.press('Enter');
    await popover.waitFor();
    await page.mouse.click(width - 10, 700);
    await popover.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '删除', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.ok((await dialog.innerText()).includes('所有已记录密钥'));
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const layout = await page.locator('#known-hosts-review').evaluate((root) => {
      const actions = root.querySelector('[data-slot="workbench-page-header-actions"]');
      const bounds = [...actions.children].map((element) => element.getBoundingClientRect());
      return {
        tops: bounds.map((rect) => rect.top), heights: bounds.map((rect) => rect.height),
        overflow: root.scrollWidth > root.clientWidth,
        gap: getComputedStyle(root.querySelector('.grid')).gap,
      };
    });
    assert.equal(new Set(layout.tops).size, 1);
    assert.equal(new Set(layout.heights).size, 1);
    assert.equal(layout.overflow, false);
    assert.equal(layout.gap, '8px');
    await search.focus();
    await page.screenshot({ path: `.drawer-review/known-hosts-${width}.png` });
    await search.fill('no matching host');
    await page.getByText('没有匹配的已知主机记录', { exact: true }).waitFor();
    await search.fill('');
  }
  console.log('Known hosts: grouping, search, clipboard, confirmation and wide/narrow rendering passed.');
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
