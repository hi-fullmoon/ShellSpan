import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { ConnectionList } = await import('/src/components/workbench/connection-list.tsx');
    const { changeLocale } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    useAppStore.setState({ locale: 'zh-CN' });
    await changeLocale('zh-CN');
    const host = document.createElement('div');
    host.id = 'connection-transfer-menu-check';
    host.style.cssText = 'position:fixed;inset:0;z-index:40;background:var(--background)';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(ConnectionList, {
      profiles: [], initialized: true,
      onAdd() {}, onEdit() {}, onDelete() {}, onConnectTerminal() {},
      onConnectSftp() {}, onDuplicate() {}, onToggleFavorite() {},
      onImport() {}, onExport() {},
    }));
  });
  const trigger = page.locator('#connection-transfer-menu-check button[aria-haspopup="menu"]');
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await trigger.click();
    const items = page.getByRole('menuitem');
    await items.first().waitFor();
    await page.getByRole('menu').evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
      await document.fonts.ready;
    });
    assert.deepEqual(await items.allTextContents(), ['导入连接', '导出连接']);
    for (const item of await items.all()) {
      const measurements = await item.evaluate((element) => {
        const icon = element.querySelector('svg');
        const label = element.querySelector('[data-slot="menu-item-label"]');
        const iconRect = icon.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        return {
          width: iconRect.width, height: iconRect.height,
          centerDifference: Math.abs(iconRect.y + iconRect.height / 2 - labelRect.y - labelRect.height / 2),
          gap: labelRect.left - iconRect.right,
          iconColor: getComputedStyle(icon).color,
          labelColor: getComputedStyle(label).color,
          right: element.getBoundingClientRect().right,
        };
      });
      assert.equal(measurements.width, 14, `Icon width at ${width}px`);
      assert.equal(measurements.height, 14, `Icon height at ${width}px`);
      assert.ok(measurements.centerDifference < 0.5, `Vertical alignment at ${width}px`);
      assert.equal(measurements.gap, 4, `Icon and label gap at ${width}px`);
      assert.notEqual(measurements.iconColor, measurements.labelColor, 'Icon uses the muted color');
      assert.ok(measurements.right <= width, `Menu fits at ${width}px`);
    }
    await page.screenshot({ path: `/tmp/shellspan-connection-transfer-menu-${width}.png` });
    await page.keyboard.press('Escape');
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await page.getByRole('menuitem').first().waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.matches('#connection-transfer-menu-check button[aria-haspopup="menu"]'));
  }
  console.log('Connection transfer menu: icon size, alignment, color, spacing and keyboard checks passed.');
} finally {
  await browser.close();
}
