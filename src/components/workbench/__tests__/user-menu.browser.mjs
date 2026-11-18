import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({ colorScheme: 'light' });
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

      await trigger.click();
      await page.getByRole('menuitem', { name: /编辑资料|Edit profile/ }).click();
      const dialog = page.getByRole('dialog', { name: /^(编辑资料|Edit profile)$/ });
      const nickname = dialog.getByRole('textbox', { name: /^(昵称|Display name)$/ });
      const focused = await nickname.evaluate(input => {
        const style = getComputedStyle(input);
        return { background: style.backgroundColor, height: style.height, outline: style.outlineStyle, width: style.outlineWidth };
      });
      assert.equal(focused.background, 'rgba(0, 0, 0, 0)');
      assert.equal(focused.height, '32px');
      assert.equal(focused.outline, 'solid');
      assert.equal(focused.width, '1px');
      await nickname.press('Tab');
      assert.equal(await nickname.evaluate(input => getComputedStyle(input).outlineStyle), 'none');
      await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
      await dialog.waitFor({ state: 'hidden' });
      await trigger.focus();
      await page.keyboard.press('ArrowDown');
      await about.waitFor();
      await page.keyboard.press('End');
      await page.getByRole('menuitem', { name: /^(退出|Quit)$/ }).and(page.locator(':focus')).waitFor();
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

console.log('User menu and profile input styling passed in Chromium and WebKit.');
