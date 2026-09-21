import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

// Use a real screenshot to exercise data URL rendering; no IPC is replaced.
const imagePath = process.env.SHELLSPAN_TEST_IMAGE;
assert.ok(imagePath, 'Set SHELLSPAN_TEST_IMAGE to a PNG screenshot');
const data = readFileSync(imagePath).toString('base64');
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const width of [360, 900]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
      await page.evaluate(async data => {
        const { mount } = await import('/src/components/ai/__tests__/ai-image-submit.browser.tsx');
        const host = document.createElement('main');
        host.id = 'image-submit-check';
        host.className = 'ai-panel-shell @container/ai-workspace';
        host.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--background);z-index:100';
        document.body.append(host);
        await mount(host, data);
      }, data);
      const host = page.locator('#image-submit-check');
      const card = host.locator('.ai-image-thumbnail');
      const picture = card.locator('img');
      await picture.waitFor();
      await picture.evaluate(async image => { await image.decode(); window.submitPicture = image; });
      const before = await card.boundingBox();
      await host.locator('.ai-composer-primary').click();
      const sending = host.locator('.ai-composer-primary');
      assert.equal(await sending.getAttribute('aria-busy'), 'true');
      assert.equal(await sending.getAttribute('aria-label'), 'Sending');
      assert.equal(await sending.locator('[data-slot="spinner"]').count(), 1);
      const cancel = card.getByRole('button', { name: 'Cancel', exact: true });
      assert.equal(await cancel.evaluate(el => getComputedStyle(el).opacity), '0');
      assert.equal(await picture.evaluate(el => el === window.submitPicture), true);
      const after = await card.boundingBox();
      assert.equal(after.width, before.width);
      assert.equal(after.height, before.height);
      await card.hover();
      assert.equal(await cancel.evaluate(el => getComputedStyle(el).opacity), '1');
      await page.mouse.move(width - 1, 1);
      await cancel.focus();
      assert.equal(await cancel.evaluate(el => getComputedStyle(el).opacity), '1');
      await page.keyboard.press('Enter');
      await card.getByRole('button', { name: 'Remove image screenshot.png' }).waitFor();
      assert.equal(await sending.getAttribute('aria-busy'), null);
      assert.equal(await sending.locator('[data-slot="spinner"]').count(), 0);
      console.log(`${engine.name()} ${width}px: submit feedback, stable image, hover/focus and cancel passed`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
