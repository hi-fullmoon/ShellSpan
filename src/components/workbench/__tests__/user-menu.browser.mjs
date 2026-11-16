import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');

    const trigger = page.getByRole('button', { name: /^(打开个人菜单|Open user menu)$/ });
    const about = page.getByRole('menuitem', { name: /^(关于|About)$/ });
    for (const width of [1440, 420]) {
      await page.setViewportSize({ width, height: 720 });
      await trigger.click();
      await about.hover();
      await about.and(page.locator('[data-highlighted]')).waitFor();
      assert.equal(await about.evaluate((item) => getComputedStyle(item).borderRadius), '6px');

      await page.keyboard.press('Escape');
      await about.waitFor({ state: 'hidden' });
      await trigger.focus();
      await page.keyboard.press('ArrowDown');
      await about.waitFor();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowUp');
      await about.and(page.locator(':focus')).waitFor();
      assert.equal(await about.evaluate((item) => getComputedStyle(item).borderRadius), '6px');

      await page.keyboard.press('Escape');
      await about.waitFor({ state: 'hidden' });
    }
  } finally {
    await browser.close();
  }
}

console.log('User menu hover and keyboard focus radius passed in Chromium and WebKit.');
