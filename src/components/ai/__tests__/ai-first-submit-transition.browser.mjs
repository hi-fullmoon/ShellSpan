import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  for (const scenario of [
    { mode: 'ask', running: false },
    { mode: 'agent', running: false },
    { mode: 'agent', running: true },
  ]) {
  for (const width of [900, 360]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion });
      page.on('pageerror', error => console.error(error.message));
      await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
      await page.evaluate(async ({ mode, running }) => {
        const { mount } = await import('/src/components/ai/__tests__/ai-first-submit-transition.browser.tsx');
        const host = document.createElement('main');
        host.id = 'first-submit-check';
        host.className = 'ai-panel-shell @container/ai-workspace';
        host.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--background);z-index:100';
        document.body.append(host);
        // Pause the real browser animations after React commits, for deterministic
        // geometry checks at several points along the actual transition.
        const observer = new MutationObserver(() => {
          const composer = host.querySelector('[data-slot="ai-composer-seat"]');
          if (composer?.dataset.phase !== 'active') return;
          for (const element of [composer, host.querySelector('[data-slot="ai-workspace-content"]')]) {
            element?.getAnimations().filter(animation => animation.id.startsWith('ai-first-submit-')).forEach(animation => animation.pause());
          }
        });
        observer.observe(host, { subtree: true, attributes: true, childList: true });
        host.observer = observer;
        await mount(host, mode, running);
      }, scenario);
      const host = page.locator('#first-submit-check');
      const editor = host.locator('[contenteditable]');
      await editor.fill('首条消息的输入框应平滑移动');
      await host.evaluate(el => { el.editorBeforeSubmit = el.querySelector('[contenteditable]'); });
      await page.keyboard.press('Enter');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await host.evaluate(el => {
        const composer = el.querySelector('[data-slot="ai-composer-seat"]');
        const content = el.querySelector('[data-slot="ai-workspace-content"]');
        const animation = composer.getAnimations().find(item => item.id === 'ai-first-submit-composer');
        const animationCount = animation ? 1 : 0;
        const topAt = time => {
          if (animation) animation.currentTime = time;
          return composer.getBoundingClientRect().top;
        };
        const start = topAt(0);
        const middle = topAt(140);
        const end = topAt(280);
        const bounds = composer.getBoundingClientRect();
        return { submitted: el.dataset.submitted, phase: composer.dataset.phase,
          sameEditor: el.editorBeforeSubmit === el.querySelector('[contenteditable]'),
          focused: document.activeElement === el.editorBeforeSubmit,
          origin: Number(el.dataset.origin), start, middle, end, bottom: bounds.bottom, width: bounds.width,
          animationCount, contentAnimations: content.getAnimations().filter(item => item.id === 'ai-first-submit-content').length,
          scrollHeight: content.getBoundingClientRect().height };
      });
      assert.equal(result.submitted, 'true', 'submission must run before the animation finishes');
      assert.equal(result.phase, 'active');
      assert.equal(result.sameEditor, true, 'the editor must not remount');
      assert.equal(result.focused, true, 'keyboard focus must survive the layout change');
      assert.ok(result.bottom <= 701 && result.width <= width, JSON.stringify(result));
      if (reducedMotion === 'reduce' || scenario.running) {
        assert.equal(result.animationCount, 0, JSON.stringify(result));
        assert.equal(result.contentAnimations, 0);
      } else {
        assert.equal(result.animationCount, 1);
        assert.equal(result.contentAnimations, 1);
        assert.ok(Math.abs(result.start - result.origin) < 1, JSON.stringify(result));
        assert.ok(result.start < result.middle && result.middle < result.end, JSON.stringify(result));
      }
      await host.evaluate(async el => {
        el.observer.disconnect();
        const animations = el.getAnimations({ subtree: true }).filter(animation => animation.playState === 'paused');
        animations.forEach(animation => animation.play());
        await Promise.all(animations.map(animation => animation.finished));
      });
      const final = await host.locator('[data-slot="ai-composer-seat"]').boundingBox();
      assert.ok(Math.abs(final.y - result.end) < 1, 'finishing must not cause a second jump');
      console.log(JSON.stringify({ ...scenario, windowWidth: width, reducedMotion, ...result }));
      if (process.env.SHELLSPAN_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.SHELLSPAN_SCREENSHOT_DIR}/first-submit-${scenario.mode}-${scenario.running}-${width}-${reducedMotion}.png` });
      }
      await page.close();
    }
  }
  }
} finally {
  await browser.close();
}
