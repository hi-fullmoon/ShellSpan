import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

assert.ok(process.argv[2], 'Pass a real session JSONL ledger; only internal artifact metadata is used.');
const events = (await readFile(process.argv[2], 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const kinds = new Set(['tool-result', 'model-tool-result', 'context-budget', 'context-budget-checkpoint',
  'compaction-attempt', 'structured-compaction', 'task-budget-progress', 'task-budget-checkpoint']);
const turns = new Map();
for (const event of events) {
  if (event.type !== 'context/artifact' || !kinds.has(event.data.kind)) continue;
  const items = turns.get(event.turnId) ?? new Map();
  items.set(event.data.artifactId, {
    kind: 'artifact', key: `artifact:${event.data.artifactId}`, sourceKind: 'agent',
    sessionId: event.sessionId, turnId: event.turnId ?? null, stepId: event.stepId ?? null,
    firstSeq: event.seq, lastSeq: event.seq, timestamp: new Date(event.timeUnixMs).toISOString(),
    artifactId: event.data.artifactId, artifactKind: event.data.kind, title: event.data.title,
    sizeBytes: event.data.sizeBytes ?? null, mediaType: event.data.mediaType ?? null,
    sha256: event.data.sha256 ?? null, sensitivity: event.data.sensitivity ?? null,
  });
  turns.set(event.turnId, items);
}
const artifacts = [...turns.values()].sort((left, right) => right.size - left.size)[0];
assert.ok(artifacts?.size > 0, 'The ledger must contain recorded internal artifacts.');
const evidence = [...artifacts.values()];
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/ai-runtime-artifacts.browser.tsx';
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use(async (request, response, next) => {
  if (request.url === '/evidence') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(evidence));
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
  } else next();
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1000, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const result = await page.evaluate(async ({ entry, locale, width }) =>
        (await import(entry)).show(locale, width), { entry, locale, width });
      const trigger = page.getByRole('button', { name: locale === 'zh-CN' ? '运行记录' : 'Run records', exact: true });
      await trigger.waitFor();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.ai-produced-files-label').count(), 0);
      assert.equal(await page.locator('[data-runtime-artifact-list]').count(), 0);
      await page.screenshot({ path: `/tmp/shellspan-runtime-artifacts-${locale}-${width}-collapsed.png` });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const list = page.locator('[data-runtime-artifact-list]');
      const expandedHeight = await (await page.waitForFunction(() => {
        const animation = document.querySelector('[data-runtime-artifacts] > [data-slot="collapsible-content"]')
          ?.getAnimations().find(item => item.transitionProperty === 'height');
        if (!animation) return false;
        const frames = animation.effect.getKeyframes();
        return { from: parseFloat(frames[0].height), to: parseFloat(frames.at(-1).height) };
      })).jsonValue();
      assert.equal(expandedHeight.from, 0);
      assert.ok(expandedHeight.to > 0);
      await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
      await list.waitFor();
      assert.equal(await list.getByRole('button').count(), result.count);
      const bounds = await list.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { fits: box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth,
          height: box.height, scrolls: element.scrollHeight > element.clientHeight };
      });
      assert.equal(bounds.fits, true, `${locale} list fits at ${width}px`);
      assert.ok(bounds.height <= 260, 'Run records keep a bounded scrolling area');
      if (result.count >= 20) assert.equal(bounds.scrolls, true);
      await page.screenshot({ path: `/tmp/shellspan-runtime-artifacts-${locale}-${width}-expanded.png` });
      const entryButton = list.getByRole('button').last();
      await entryButton.click();
      assert.equal(await page.locator('body').getAttribute('data-opened-artifact'), result.lastArtifactId);
      await page.keyboard.press('Tab');
      await entryButton.focus();
      assert.equal(await entryButton.evaluate(element => element.matches(':focus-visible')), true);
      const focusStyle = await entryButton.evaluate(element => {
        const style = getComputedStyle(element);
        return { outline: style.outlineStyle, shadow: style.boxShadow };
      });
      assert.deepEqual(focusStyle, { outline: 'none', shadow: 'none' }, 'Run record focus must not draw an outer ring');
      await page.locator('body').evaluate(element => element.removeAttribute('data-opened-artifact'));
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('body').getAttribute('data-opened-artifact'), result.lastArtifactId);
      await page.screenshot({ path: `/tmp/shellspan-runtime-artifacts-${locale}-${width}-focused.png` });
      await trigger.click();
      const closingHeight = await (await page.waitForFunction(() => {
        const animation = document.querySelector('[data-runtime-artifacts] > [data-slot="collapsible-content"][data-ending-style]')
          ?.getAnimations().find(item => item.transitionProperty === 'height');
        if (!animation) return false;
        const frames = animation.effect.getKeyframes();
        return { from: parseFloat(frames[0].height), to: parseFloat(frames.at(-1).height) };
      })).jsonValue();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.ok(closingHeight.from > 0);
      assert.equal(closingHeight.to, 0);
      await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
      await list.waitFor({ state: 'detached' });
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Run records: ${evidence.length} recorded artifacts grouped, animated, accessible and bounded in both languages and widths.`);
} finally {
  await browser?.close();
  await server.close();
}
