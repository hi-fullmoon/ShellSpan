import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const browserType = process.env.SHELLSPAN_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await browserType.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  assert.ok(await page.evaluate(() => CSS.supports('text-box', 'trim-both cap alphabetic')),
    'Navigation alignment requires Chromium/Edge WebView2 133+ or Safari/WKWebView 18.2+');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { SectionNav } = await import('/src/components/titlebar/section-nav.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    document.getElementById('root').style.display = 'none';
    const root = document.createElement('div');
    root.id = 'section-nav-review';
    root.style.cssText = 'height:40px; padding-inline:16px';
    document.body.append(root);
    ReactDOM.createRoot(root).render(React.createElement(SectionNav));
  });
  const nav = page.locator('#section-nav-review nav');
  await nav.waitFor();
  for (const [locale, labels] of [
    ['zh-CN', ['工作台', '终端', 'SFTP']],
    ['en-US', ['Workbench', 'Terminal', 'SFTP']],
  ]) {
    await page.evaluate(async (locale) => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      useAppStore.getState().setLocale(locale);
    }, locale);
    await nav.getByRole('button', { name: labels[0], exact: true }).waitFor();
    for (const width of [1200, 360]) {
      await page.setViewportSize({ width, height: 200 });
      for (const label of labels) {
        const button = nav.getByRole('button', { name: label, exact: true });
        await button.click();
        await button.evaluate(async (element) => {
          await document.fonts.load(getComputedStyle(element).font, element.textContent);
          await document.fonts.ready;
        });
        const metrics = await button.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const iconElement = element.querySelector('svg');
          const labelElement = element.querySelector('span');
          const icon = iconElement.getBoundingClientRect();
          const text = labelElement.getBoundingClientRect();
          return {
            width: bounds.width,
            radius: parseFloat(getComputedStyle(element).borderRadius),
            gap: text.left - icon.right,
            offset: (icon.left + text.right) / 2 - (bounds.left + bounds.right) / 2,
            verticalOffset: (icon.top + icon.bottom) / 2 - (bounds.top + bounds.bottom) / 2,
            textVerticalOffset: (text.top + text.bottom) / 2 - (bounds.top + bounds.bottom) / 2,
            right: bounds.right,
            active: element.getAttribute('aria-current'),
            textBox: getComputedStyle(labelElement).textBoxTrim,
            iconSize: icon.height,
            height: bounds.height,
            overflow: element.scrollWidth > element.clientWidth,
            transform: getComputedStyle(iconElement).transform,
            translate: getComputedStyle(iconElement).translate,
          };
        });
        assert.ok(metrics.width >= 80);
        if (locale === 'zh-CN') assert.equal(metrics.width, 80);
        if (label === 'Workbench') assert.ok(metrics.width > 80);
        assert.equal(metrics.gap, 4);
        assert.ok(Math.abs(metrics.offset) < 1, `${label}: content must be centered`);
        assert.equal(metrics.verticalOffset, 0, `${label}: icon must be vertically centered`);
        assert.ok(Math.abs(metrics.textVerticalOffset) < 0.1, `${label}: label must be vertically centered`);
        assert.equal(metrics.textBox, 'trim-both');
        assert.equal(metrics.radius, 6);
        assert.ok(metrics.right <= width);
        assert.equal(metrics.active, 'page');
        assert.equal(metrics.iconSize, 16);
        assert.equal(metrics.height, 28);
        assert.equal(metrics.overflow, false);
        assert.equal(metrics.transform, 'none');
        assert.equal(metrics.translate, 'none');
      }
      await nav.getByRole('button', { name: labels[0], exact: true }).click();
      await page.evaluate(async () => { await document.fonts.ready; });
      await nav.screenshot({ path: `/tmp/shellspan-section-nav-${locale}-${width}-${browserType.name()}.png` });
    }
    const terminal = nav.getByRole('button', { name: labels[1], exact: true });
    await terminal.focus();
    await page.keyboard.press('Enter');
    assert.equal(await terminal.getAttribute('aria-current'), 'page');
  }
} finally {
  await browser.close();
}
