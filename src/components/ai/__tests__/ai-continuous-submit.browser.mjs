import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  for (const width of [960, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420'}/src/components/ai/__tests__/ai-continuous-submit.html`, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      const host = document.createElement('main');
      host.id = 'continuous-submit-check';
      host.className = 'ai-panel-shell @container/ai-workspace';
      host.style.cssText = 'position:fixed;inset:0;display:flex;align-items:end;background:var(--background);z-index:100';
      document.body.append(host);
      host.controls = await window.mountContinuousSubmit(host);
    });
    const host = page.locator('#continuous-submit-check');
    const editor = host.locator('[contenteditable]');
    for (const text of ['第一条消息', '第二条消息', '第三条消息']) {
      await editor.fill(text);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#continuous-submit-check [contenteditable]')?.textContent === '');
    }
    assert.deepEqual(JSON.parse(await host.getAttribute('data-messages')), ['第一条消息', '第二条消息', '第三条消息']);
    assert.equal(await host.locator('.ai-queue-row').count(), 3);
    await editor.fill('继续编辑第四条消息');
    await host.evaluate(element => element.controls.confirm());
    await host.getByText('正在确认').waitFor({ state: 'visible' });
    assert.equal(await editor.evaluate(element => document.activeElement === element), true);
    const overflow = await host.evaluate(element => element.scrollWidth > element.clientWidth);
    assert.equal(overflow, false, `queue must fit ${width}px container`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/shellspan-continuous-submit-${width}.png` });
    await page.close();
  }
} finally { await browser.close(); }
