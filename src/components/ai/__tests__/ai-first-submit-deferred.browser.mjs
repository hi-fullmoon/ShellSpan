import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  for (const width of [900, 360]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      for (const outcome of ['complete', 'fail', 'cancel', 'navigate']) {
        const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion });
        await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
        await page.evaluate(async () => {
          const { mountDeferred } = await import('/src/components/ai/__tests__/ai-first-submit-transition.browser.tsx');
          const host = document.createElement('main');
          host.id = 'deferred-check';
          host.className = 'ai-panel-shell @container/ai-workspace';
          host.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--background);z-index:100';
          document.body.append(host);
          host.controls = await mountDeferred(host);
          new MutationObserver(() => {
            host.getAnimations({ subtree: true }).filter(a => a.id.startsWith('ai-first-submit-')).forEach(a => {
              a.pause(); a.currentTime = 0;
            });
          }).observe(host, { subtree: true, attributes: true, childList: true });
        });
        const host = page.locator('#deferred-check');
        const editor = host.locator('[contenteditable]');
        await editor.fill('请查看这张图片');
        await page.keyboard.press('Enter');
        const advance = async event => {
          await host.evaluate((el, value) => el.controls.advance(value), event);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        };
        const animationCount = () => host.evaluate(el => el.getAnimations({ subtree: true })
          .filter(a => a.id === 'ai-first-submit-composer').length);
        for (let i = 0; i < 3; i++) await advance('progress');
        assert.equal(await host.locator('[data-slot="ai-composer-seat"]').getAttribute('data-phase'), 'hero');
        assert.equal(await animationCount(), 0);
        await advance(outcome);
        if (outcome === 'fail' || outcome === 'cancel') {
          assert.equal(await host.locator('[data-slot="ai-composer-seat"]').getAttribute('data-phase'), 'hero');
          // A later unrelated layout change must not reuse the failed attempt.
          await advance('complete');
        }
        const expected = outcome === 'complete' && reducedMotion === 'no-preference' ? 1 : 0;
        assert.equal(await animationCount(), expected, `${width}/${reducedMotion}/${outcome}`);
        if (expected) {
          const bounds = await host.evaluate(el => ({
            origin: Number(el.dataset.origin),
            current: el.querySelector('[data-slot="ai-composer-seat"]').getBoundingClientRect().top,
          }));
          assert.ok(Math.abs(bounds.origin - bounds.current) < 1, JSON.stringify(bounds));
        }
        console.log(JSON.stringify({ width, reducedMotion, outcome, animations: expected }));
        await host.evaluate(el => el.controls.unmount());
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
