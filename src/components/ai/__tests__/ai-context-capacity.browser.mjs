import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/ai-context-capacity.browser.tsx';
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.SHELLSPAN_TEST_BROWSER_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1000, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(async ({ entry, locale }) => {
        const module = await import(entry);
        await module.show(locale, module.originalWindow);
      }, { entry, locale });
      const meter = page.locator('.ai-context-meter-trigger');
      await meter.click();
      const panel = page.locator('.ai-context-meter-panel');
      await panel.waitFor();
      assert.match(await panel.textContent(), /\/ 1M/u);
      await page.evaluate(async ({ entry, locale }) => (await import(entry)).show(locale, 128_000), { entry, locale });
      await page.waitForFunction(() => document.querySelector('.ai-context-meter-panel')?.textContent.includes('/ 128K'));
      assert.match(await panel.textContent(), /7%/u);
      const fits = await panel.evaluate(element => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth;
      });
      assert.equal(fits, true, `${locale} context panel fits at ${width}px`);
      await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
      await page.screenshot({ path: `/tmp/shellspan-context-capacity-${locale}-${width}.png` });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
    }
  }
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1000, 480, 320]) {
      await page.setViewportSize({ width, height: 700 });
      const checkpoints = [
        { stream: 'requestTransitions', seq: 6507, used: 80998, figure: '81K / 312K', estimate: '~117K' },
        { stream: 'requestTransitions', seq: 6684, used: 85288, figure: '85.3K / 312K', estimate: '~117K' },
        { stream: 'requestTransitions', seq: 6710, used: 85288, figure: '85.3K / 312K', estimate: '~128K' },
        { stream: 'compaction', seq: 5666, used: null, figure: '— / 312K' },
        { stream: 'compaction', seq: 5672, used: 62473, figure: '~62.5K / 312K', estimate: '~62.5K' },
        { stream: 'compaction', seq: 5977, used: 49322, figure: '49.3K / 312K', estimate: '~62.5K' },
      ];
      for (const [index, checkpoint] of checkpoints.entries()) {
        const projected = await page.evaluate(async ({ entry, locale, checkpoint }) =>
          (await import(entry)).showAccounting(locale, checkpoint.stream, checkpoint.seq), { entry, locale, checkpoint });
        assert.equal(projected.usedTokens, checkpoint.used);
        const meter = page.locator('.ai-context-meter-trigger');
        if (index === 0) { await meter.focus(); await page.keyboard.press('Enter'); }
        const panel = page.locator('.ai-context-meter-panel');
        await panel.waitFor();
        const header = panel.locator('.ai-context-meter-header');
        await page.waitForFunction(figure => document.querySelector('.ai-context-meter-header')?.textContent.includes(figure), checkpoint.figure);
        assert.ok((await header.innerText()).includes(checkpoint.figure));
        if (checkpoint.estimate) assert.ok((await panel.locator('[data-slot="ai-context-estimate"]').innerText()).includes(checkpoint.estimate));
        if (checkpoint.used === null) {
          assert.ok((await header.innerText()).includes(locale === 'zh-CN' ? '待确认' : 'Pending'));
          assert.ok(!(await header.innerText()).includes('0%'));
        }
        if (projected.afterCompaction) assert.ok((await panel.innerText()).includes(locale === 'zh-CN' ? '上下文已压缩' : 'Context compacted'));
        await page.evaluate(async () => {
          document.getAnimations().forEach(animation => animation.finish());
          // Floating UI repositions after the panel's content height changes.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const fits = await panel.evaluate(element => {
          const box = element.getBoundingClientRect();
          const figures = element.querySelector('.ai-context-meter-figures');
          return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
            && element.scrollWidth <= element.clientWidth && figures.scrollWidth <= figures.clientWidth;
        });
        if (!fits) await page.screenshot({ path: '/tmp/shellspan-context-accounting-layout-failure.png' });
        assert.ok(fits, `${locale} accounting checkpoint ${checkpoint.seq} fits at ${width}px without truncating counts`);
        await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
        await page.screenshot({ path: `/tmp/shellspan-context-accounting-${locale}-${width}-${checkpoint.seq}.png` });
      }
      await page.keyboard.press('Escape');
      await page.locator('.ai-context-meter-panel').waitFor({ state: 'detached' });
    }
  }
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1000, 320]) {
      await page.setViewportSize({ width, height: 600 });
      await page.evaluate(async ({ entry, locale }) => (await import(entry)).showBudget(locale), { entry, locale });
      await page.locator('.ai-context-meter-trigger').focus();
      await page.keyboard.press('Enter');
      const panel = page.locator('.ai-context-meter-panel');
      await panel.waitFor();
      assert.ok((await panel.innerText()).includes('50.1K (25%)'));
      assert.equal(await panel.locator('dt').count(), 1);
      assert.equal(await panel.locator('.ai-context-meter-note').count(), 0);
      assert.ok((await panel.locator('.ai-context-meter-header').innerText()).includes('23%'));
      await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
      assert.ok(await panel.evaluate(element => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
          && element.scrollWidth <= element.clientWidth;
      }), `${locale} actual budget fits at ${width}px`);
      await page.screenshot({ path: `/tmp/shellspan-request-budget-${locale}-${width}.png` });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });

      await page.evaluate(async ({ entry, locale }) => (await import(entry)).showSettings(locale), { entry, locale });
      await page.getByRole('button', { name: locale === 'zh-CN' ? '模型容量 1' : 'Model limits 1' }).click();
      const output = page.locator('#ai-model-request-output-0');
      await output.fill('16384');
      await page.locator('#ai-model-context-0').focus();
      const definition = await page.evaluate(async entry => (await import(entry)).settingsDefinition(), entry);
      assert.equal(definition.contextWindow, 200_000);
      assert.equal(definition.maxOutputTokens, 131_072);
      assert.equal(definition.requestOutputTokens, 16_384);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale} settings fit at ${width}px`);
      await page.screenshot({ path: `/tmp/shellspan-output-settings-${locale}-${width}.png` });
      await page.locator('#ai-model-context-0').fill('64000');
      await output.fill('8192');
      await page.locator('#ai-model-context-0').focus();
      const smaller = await page.evaluate(async entry => (await import(entry)).settingsDefinition(), entry);
      assert.equal(smaller.contextWindow, 64_000);
      assert.equal(smaller.maxOutputTokens, 131_072);
      assert.equal(smaller.requestOutputTokens, 8_192);
      assert.equal(await output.getAttribute('aria-invalid'), null);
      assert.equal(await page.locator('#ai-model-output-0').inputValue(), '131072');
      await page.screenshot({ path: `/tmp/shellspan-output-settings-small-${locale}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Context capacity, confirmed usage, separate estimates and compaction states passed in both languages and wide/narrow panels.');
} finally {
  await browser?.close();
  await server.close();
}
