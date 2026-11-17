import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// UI state boundaries using the real composer reducer and native session recording.
const projectRoot = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({ root: projectRoot, configFile: false, logLevel: 'error',
  optimizeDeps: { entries: ['src/components/ai/__tests__/ai-composer-error-dedup.browser.tsx'] },
  resolve: { alias: { '@': path.join(projectRoot, 'src') } },
  plugins: [react(), tailwindcss(), {
    name: 'composer-error-review',
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/error-dedup')) return next();
        res.setHeader('Content-Type', 'text/html');
        void vite.transformIndexHtml(req.url, '<html data-theme="light"><body><main id="error-dedup-check" class="ai-panel-shell" style="height:100dvh"></main><script type="module" src="/src/components/ai/__tests__/ai-composer-error-dedup.browser.tsx"></script></body></html>')
          .then(html => res.end(html)).catch(next);
      });
    },
  }], server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const locale of ['zh-CN', 'en-US']) {
    await page.goto(`${server.resolvedUrls.local[0]}error-dedup?locale=${locale}`);
    const host = page.locator('#error-dedup-check');
    await host.locator('[data-ai-failed-draft]').first().waitFor({ state: 'attached', timeout: 10000 })
      .catch(async error => assert.fail(`${error.message}\n${errors.join('\n')}\n${await host.innerHTML()}`));
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1280, 640, 320]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await host.locator('[data-slot="alert"]').count(), 0);
      assert.equal(await host.locator('[data-ai-failed-draft]').count(), 3);
      assert.equal(await host.locator('[data-slot="ai-workspace-error-notices"]').innerText(), '');
      const retry = host.locator('[data-ai-failed-retry]').last();
      assert.equal(await retry.innerText(), locale === 'zh-CN' ? '重试' : 'Retry');
      assert.equal(await retry.locator('svg').count(), 0);
      const geometry = await host.evaluate(element => ({
        overflow: element.scrollWidth > element.clientWidth,
        rows: [...element.querySelectorAll('[data-ai-failed-draft]')].map(row => {
          const text = row.querySelector(':scope > div').getBoundingClientRect();
          const icon = row.querySelector(':scope > svg').getBoundingClientRect();
          const retryButton = row.querySelector('[data-ai-failed-retry]');
          const button = retryButton.getBoundingClientRect();
          const box = row.getBoundingClientRect();
          return { overflow: row.scrollWidth > row.clientWidth, gap: text.left - icon.right,
            padding: [icon.left - box.left, box.right - button.right],
            radius: getComputedStyle(row).borderTopLeftRadius,
            iconOffset: icon.y + icon.height / 2 - text.y - text.height / 2,
            retryOffset: button.y + button.height / 2 - text.y - text.height / 2,
            height: row.getBoundingClientRect().height,
            buttonHeight: button.height, overlaps: button.left < text.right && button.top < text.bottom };
        }),
      }));
      assert.equal(geometry.overflow, false, `${locale} ${width}: workspace overflows`);
      for (const row of geometry.rows) {
        assert.equal(row.overflow, false, `${locale} ${width}: recovery row overflows`);
        assert.equal(row.gap, 4, 'Keep 4px between the error icon and text');
        assert.deepEqual(row.padding, [8, 8], 'Keep 8px of padding outside the icon and retry button');
        assert.equal(row.radius, '6px', 'A failed draft with a retry button uses the same corner radius');
        assert.equal(row.buttonHeight, 24);
        assert.ok(Math.abs(row.iconOffset) < 0.1, `${locale} ${width}: failure icon must align with the status text`);
        assert.ok(Math.abs(row.retryOffset) < 0.1, `${locale} ${width}: retry label must align with the status text`);
        assert.ok(row.height <= 28, `${locale} ${width}: collapsed failures must stay on one compact line`);
        assert.equal(row.overlaps, false, `${locale} ${width}: retry overlaps error text`);
      }
      const lastRow = host.locator('[data-ai-failed-draft]').last();
      const details = lastRow.locator('[data-ai-failed-details]');
      await details.hover();
      const content = page.getByRole('tooltip').filter({ hasText: locale === 'zh-CN'
        ? '消息准备超时，尚未发送。请检查终端连接后重试。'
        : 'Message preparation timed out before sending. Check the terminal connection and retry.' });
      await content.waitFor({ timeout: 5000 }).catch(async error => {
        await page.screenshot({ path: '/tmp/shellspan-hover-failure.png' });
        assert.fail(`${error.message}\n${await details.evaluate(element => element.outerHTML)}\n${await page.locator('[data-slot="tooltip-content"]').evaluateAll(elements => elements.map(element => element.outerHTML))}`);
      });
      assert.ok((await content.innerText()).length > 0);
      const bounds = await content.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `${locale} ${width}: tooltip must fit the viewport`);
      assert.ok((await lastRow.boundingBox()).height <= 28, 'Hover details must not expand the message row');
      assert.equal(await lastRow.evaluate(row => row.scrollWidth > row.clientWidth), false);
      await page.screenshot({ path: `/tmp/shellspan-hover-details-${locale}-${width}.png`, animations: 'disabled' });
      await page.mouse.move(0, 0);
      await content.waitFor({ state: 'hidden' });
      await page.keyboard.press('Tab');
      await details.focus();
      await content.waitFor();
      await page.keyboard.press('Escape');
      await content.waitFor({ state: 'hidden' });
      await page.keyboard.press('Tab');
      assert.ok(await retry.evaluate(button => button === document.activeElement), 'Tab reaches the retry button');
      await page.keyboard.press('Enter');
      assert.equal(await host.getAttribute('data-retried'), 'token-budget-review:2');
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('[data-ai-failed-retry]')].at(-1);
        return button?.matches(':focus-visible') && getComputedStyle(button).textDecorationLine === 'underline';
      });
      const focusedStyle = await retry.evaluate(button => {
        const css = getComputedStyle(button);
        return { border: css.borderTopWidth, outline: css.outlineStyle, shadow: css.boxShadow,
          padding: css.padding, margin: css.margin, background: css.backgroundColor };
      });
      assert.equal(focusedStyle.border, '0px', 'Retry remains borderless');
      assert.equal(focusedStyle.outline, 'none');
      assert.doesNotMatch(focusedStyle.shadow, /[1-9][\d.]*px/, 'Focused retry must not draw an outer ring');
      assert.equal(focusedStyle.padding, '0px');
      assert.equal(focusedStyle.margin, '0px');
      assert.equal(focusedStyle.background, 'rgba(0, 0, 0, 0)');
      await page.keyboard.press('Escape');
      await retry.evaluate(button => button.blur());
      await details.evaluate(element => element.blur());
      await host.screenshot({ path: `/tmp/shellspan-hover-retry-${locale}-${width}.png`, animations: 'disabled' });
    }
    await host.locator('#reopen-failed-messages').evaluate(button => button.click());
    const restored = host.locator('[data-slot="ai-workspace-content"] [data-ai-failed-draft]');
    await restored.last().waitFor();
    assert.equal(await restored.count(), 3);
    assert.equal(await host.locator('[data-slot="ai-retained-failed-drafts"]').count(), 0);
    assert.equal(await host.locator('[data-slot="ai-workspace-error-notices"]').innerText(), '');
    assert.equal(await host.locator('[data-slot="alert"]').count(), 0);
    const retry = restored.last().locator('[data-ai-failed-retry]');
    await retry.focus();
    await page.keyboard.press('Enter');
    assert.equal(await host.getAttribute('data-retried'), 'token-budget-review:2');
    await host.screenshot({ path: `/tmp/shellspan-errors-reopened-${locale}.png` });
  }
  assert.deepEqual(errors, [], 'The review must not produce browser errors');
  console.log('Composer error deduplication passed in both locales at 1280, 640 and 320px.');
} finally {
  await browser.close();
  await server.close();
}
