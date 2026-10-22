import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const browserType = process.env.SHELLSPAN_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await browserType.launch();
try {
  const page = await browser.newPage();
  await page.goto(new URL('/src/components/titlebar/__tests__/section-nav.browser.html', process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420').href);
  assert.ok(await page.evaluate(() => CSS.supports('text-box', 'trim-both cap alphabetic')),
    'Navigation alignment requires Chromium/Edge WebView2 133+ or Safari/WKWebView 18.2+');
  const nav = page.locator('#section-nav-review nav');
  await nav.waitFor();
  assert.equal(await nav.getByRole('button').count(), 3);
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    useAppStore.getState().setShowFocusMode(true);
  });
  await nav.getByRole('button').nth(3).waitFor();
  assert.equal(await nav.getByRole('button').count(), 4);
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    useAppStore.getState().setShowFocusMode(false);
  });
  await nav.getByRole('button').nth(3).waitFor({ state: 'detached' });
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
      let initialBounds;
      for (const label of labels) {
        const button = nav.getByRole('button', { name: label, exact: true });
        await button.click();
        await button.evaluate(async (element) => {
          await document.fonts.load(getComputedStyle(element).font, element.textContent);
          await document.fonts.ready;
        });
        const bounds = await nav.getByRole('button').evaluateAll((buttons) => buttons.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }));
        initialBounds ??= bounds;
        assert.deepEqual(bounds, initialBounds, `${locale}/${width}: switching tabs must preserve every tab's position and size`);
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
            textEdge: getComputedStyle(labelElement).textBoxEdge,
            iconSize: icon.height,
            height: bounds.height,
            weight: getComputedStyle(element).fontWeight,
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
        const expectedTextOffset = locale === 'zh-CN' && label !== 'SFTP' ? -1 : 0;
        assert.ok(Math.abs(metrics.textVerticalOffset - expectedTextOffset) < 0.1, `${label}: preserve the language-specific optical alignment`);
        assert.equal(metrics.textBox, 'trim-both');
        assert.equal(metrics.textEdge, locale === 'zh-CN' && label !== 'SFTP' ? 'text alphabetic' : 'cap alphabetic');
        assert.equal(metrics.radius, 6);
        assert.ok(metrics.right <= width);
        assert.equal(metrics.active, 'page');
        assert.equal(metrics.iconSize, 14);
        assert.equal(metrics.height, 28);
        assert.equal(metrics.weight, '500');
        for (const inactive of await nav.locator('button:not([aria-current])').all()) {
          assert.equal(await inactive.evaluate((element) => getComputedStyle(element).fontWeight), '400');
        }
        assert.equal(metrics.overflow, false);
        assert.equal(metrics.transform, 'none');
        assert.equal(metrics.translate, 'none');
      }
      await nav.getByRole('button', { name: labels[0], exact: true }).click();
      await page.evaluate(async () => { await document.fonts.ready; });
      await nav.screenshot({ animations: 'disabled', path: `/tmp/shellspan-section-nav-${locale}-${width}-${browserType.name()}.png` });
    }
    const terminal = nav.getByRole('button', { name: labels[1], exact: true });
    await terminal.focus();
    await page.keyboard.press('Enter');
    assert.equal(await terminal.getAttribute('aria-current'), 'page');
  }
} finally {
  await browser.close();
}
