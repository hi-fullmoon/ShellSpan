import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/ai-queue-notice.browser.tsx';
const screenshots = join(tmpdir(), 'shellspan-queue-notice');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['src/components/ai/__tests__/ai-queue-notice.browser.tsx'], include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'queue-notice-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/?locale=')) return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><html><body><main id="root" class="ai-panel-shell ai-workspace-root @container/ai-workspace" style="padding:24px 8px"></main><script type="module" src="${entry}"></script></body></html>`);
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await (process.env.SHELLSPAN_TEST_ENGINE === 'webkit' ? webkit : chromium).launch();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [240, 320, 900]) {
      const page = await browser.newPage({ viewport: { width, height: 600 }, reducedMotion: 'reduce' });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?locale=${locale}`);
      const details = page.getByRole('button', { name: locale === 'zh-CN' ? '技术详情' : 'Technical details' });
      await details.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const retry = page.getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry', exact: true });
      const action = await retry.evaluate(button => {
        const row = button.parentElement;
        const text = row.querySelector(':scope > span');
        const copy = text.getBoundingClientRect();
        const target = button.getBoundingClientRect();
        const css = getComputedStyle(text);
        const firstLine = copy.top + parseFloat(css.paddingTop) + parseFloat(css.lineHeight) / 2;
        return { rightGap: row.getBoundingClientRect().right - target.right, height: target.height,
          firstLineOffset: target.top + target.height / 2 - firstLine, wrapped: target.top >= copy.bottom,
          fontSize: getComputedStyle(button).fontSize };
      });
      assert.equal(action.rightGap, 0, 'Retry button stays at the right edge');
      assert.equal(action.height, 24);
      assert.equal(action.fontSize, '11px');
      assert.equal(action.fontSize, await details.evaluate(button => getComputedStyle(button).fontSize));
      if (width === 240) assert.equal(action.wrapped, true, 'Retry moves below the copy in a narrow panel');
      if (width === 900) assert.equal(action.firstLineOffset, 0, 'Retry aligns with the first line of copy');
      assert.equal(await details.locator('svg').count(), 0, 'Notice details action stays text-only');
      assert.equal(await details.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByText('Agent Runtime revision conflict:', { exact: false }).count(), 0);
      const geometry = await page.getByRole('alert').evaluate(element => {
        const icon = element.querySelector(':scope > svg').getBoundingClientRect();
        const title = element.querySelector('[data-slot="alert-title"]').getBoundingClientRect();
        return { gap: title.left - icon.right, overflow: element.scrollWidth > element.clientWidth };
      });
      assert.equal(geometry.gap, 4);
      assert.equal(geometry.overflow, false);
      const checkPlacement = async () => {
        const placement = await page.getByRole('alert').evaluate(element => {
          const queue = document.querySelector('[data-slot="ai-queue-dock"]');
          const noticeRect = element.getBoundingClientRect();
          const queueRect = queue.getBoundingClientRect();
          return {
            nested: queue.contains(element),
            gap: queueRect.top - noticeRect.bottom,
            aligned: noticeRect.left === queueRect.left && noticeRect.width === queueRect.width,
          };
        });
        assert.equal(placement.nested, false, 'Notice must be outside the queue card');
        assert.equal(placement.gap, 12, 'Notice must sit 12px above the queue');
        assert.equal(placement.aligned, true, 'Notice and queue must align');
      };
      await checkPlacement();
      await page.screenshot({ path: join(screenshots, `${locale}-${width}.png`) });
      const boxes = () => page.locator('#root').evaluate(host => [
        host.querySelector('[role="alert"]'), host.querySelector('[data-slot="ai-queue-dock"]'),
        host.querySelector('[data-composer-card]'),
      ].map(element => element.getBoundingClientRect().toJSON()));
      const finishRetry = status => page.evaluate(async ({ entry, status }) => (await import(entry)).showQueueNotice(status), { entry, status });
      const checkRetry = async () => {
        const before = await boxes();
        await retry.press('Enter');
        assert.equal(await retry.getAttribute('aria-busy'), 'true');
        assert.equal(await retry.isDisabled(), true);
        assert.deepEqual(await boxes(), before, 'A pending retry must preserve the notice, queue and input geometry');
        await finishRetry('failed');
        assert.equal(await retry.isEnabled(), true);
        assert.deepEqual(await boxes(), before, 'A failed retry must keep the same geometry');
      };
      await checkRetry();
      await details.press('Enter');
      await page.getByText('Agent Runtime revision conflict:', { exact: false }).waitFor();
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
      await checkPlacement();
      assert.equal(await page.getByRole('alert').evaluate(element => element.scrollWidth > element.clientWidth), false);
      await page.screenshot({ path: join(screenshots, `${locale}-${width}-expanded.png`) });
      await checkRetry();
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
      await details.press('Space');
      assert.equal(await details.getAttribute('aria-expanded'), 'false');
      await finishRetry(null);
      await retry.waitFor({ state: 'detached' });
      await page.close();
    }
  }
  console.log(`Queue notice layout and keyboard checks passed in both locales at 240px, 320px and 900px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
