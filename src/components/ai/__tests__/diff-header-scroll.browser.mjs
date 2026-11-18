import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(tmpdir(), 'shellspan-diff-header-scroll');
await mkdir(artifacts, { recursive: true });
const paths = ['src/components/ai/workspace/ai-tool-presentation.tsx', 'src/components/ai/styles/tool-results.css'];
const patch = paths.map(path => {
  const revision = execFileSync('git', ['log', '-1', '--format=%H', '--', path], { cwd: root, encoding: 'utf8' }).trim();
  return execFileSync('git', ['show', '--format=', '--unified=1000', revision, '--', path], { cwd: root, encoding: 'utf8' });
}).join('');
assert.ok(patch.length, 'Use a real repository patch');
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'), resolve: { alias: { '@': `${root}src` } },
  optimizeDeps: { entries: ['src/components/ai/workspace/ai-tool-details.tsx'], include: ['react', 'react-dom/client'] },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__diff', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell"></main></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 720]) {
        for (const detail of [false, true]) {
          const page = await browser.newPage({ viewport: { width, height: 900 },
            ...(engine === chromium ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__diff`);
          await page.evaluate(async ({ patch, detail }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
            const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
            const { initI18n } = await import('/src/locales/index.ts');
            await initI18n('zh-CN');
            const host = document.getElementById('root');
            if (detail) host.style.height = '100vh';
            const node = { kind: 'tool', name: 'apply_patch', nativeName: null, state: 'succeeded',
              input: { patch }, output: { diff: patch }, error: null, target: null,
              durationMs: null, evidenceRefs: [], approval: null, idempotency: null, effect: 'write' };
            createRoot(host).render(detail
              ? React.createElement(AiToolDetails, { node, onBack() {} })
              : React.createElement(AiToolExpandedContent, { node }));
          }, { patch, detail });
          await page.locator('.ai-diff-body').first().waitFor();
          const context = `${engine.name()}/${width}/${detail}`;
          let checked = 0;
          for (const section of await page.locator('.ai-diff-block section').all()) {
            const body = section.locator(detail ? '.ai-diff-content' : '.ai-diff-content [data-slot="scroll-area-viewport"]');
            if (!await body.evaluate(element => element.scrollWidth > element.clientWidth)) continue;
            const header = section.locator('.ai-tool-surface-header');
            await header.scrollIntoViewIfNeeded();
            const before = await header.boundingBox();
            const counts = await header.locator('.ai-diff-counts').boundingBox();
            const copy = section.locator('.ai-tool-copy-button');
            const copyBefore = await copy.count() ? await copy.boundingBox() : null;
            if (copyBefore) {
              const layout = await copy.evaluate(element => {
                const region = element.closest('.ai-tool-content-region').getBoundingClientRect();
                const button = element.getBoundingClientRect();
                const header = element.closest('section').querySelector('.ai-tool-surface-header').getBoundingClientRect();
                return { top: button.top - region.top, right: region.right - button.right,
                  belowHeader: button.top >= header.bottom, width: button.width, height: button.height };
              });
              assert.deepEqual(layout, { top: 0, right: 14, belowHeader: true, width: 24, height: 24 },
                `${context}: diff copy belongs to the body without covering the file header or counts`);
              await header.hover({ position: { x: 20, y: 8 } });
              assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '0',
                `${context}: hovering the file header must not reveal the body copy`);
              await copy.focus();
              assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1',
                `${context}: keyboard focus reveals the body copy`);
              if (engine === chromium) {
                await copy.click();
                const expected = detail ? JSON.stringify({ diff: patch }, null, 2) : patch;
                await page.waitForFunction(text => navigator.clipboard.readText().then(value => value === text), expected);
              }
              await copy.blur();
            }
            if (width === 720) assert.equal(before.height, detail ? 32 : 24, `${context}: the conversation uses the shared code header height`);
            await body.evaluate(element => { element.scrollLeft = element.scrollWidth; });
            assert.ok(await body.evaluate(element => element.scrollLeft > 0), `${context}: diff body scrolls horizontally`);
            assert.deepEqual(await header.boundingBox(), before, `${context}: file header stays fixed`);
            assert.deepEqual(await header.locator('.ai-diff-counts').boundingBox(), counts, `${context}: counts stay fixed`);
            if (copyBefore) assert.deepEqual(await copy.boundingBox(), copyBefore, `${context}: copy stays fixed`);
            assert.ok(before.x >= 0 && before.x + before.width <= width, `${context}: header fits the card`);
            checked++;
          }
          assert.ok(checked > 1, `${context}: cover multiple files with long lines`);
          if (detail) {
            const outputSection = page.locator('.ai-detail-section').nth(1);
            assert.equal(await outputSection.locator('[data-slot="scroll-area-viewport"]').count(), 1,
              `${context}: diff output has only one vertical scroll viewport`);
            assert.ok(await outputSection.locator('.ai-diff-content').evaluateAll(elements =>
              elements.every(element => element.scrollHeight <= element.clientHeight + 1)),
              `${context}: inner diff bodies must not scroll vertically`);
            const outputViewport = outputSection.locator('[data-slot="scroll-area-viewport"]');
            await outputViewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
            const end = await outputViewport.evaluate(element => {
              const viewport = element.getBoundingClientRect();
              const last = element.querySelector('.ai-diff-block section:last-child .ai-diff-lines > :last-child').getBoundingClientRect();
              return { moved: element.scrollTop > 0, reachable: last.bottom <= viewport.bottom + 1 && last.top >= viewport.top };
            });
            assert.deepEqual(end, { moved: true, reachable: true }, `${context}: the single output scrollbar reaches the final file and line`);
            await outputViewport.evaluate(element => { element.scrollTop = 0; });
            for (const theme of ['light', 'dark']) {
              await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
              const sections = await page.locator('.ai-detail-section').evaluateAll(elements => elements.map(section => {
                const heading = section.querySelector('.ai-detail-section-header');
                const card = section.querySelector(':scope > .ai-tool-content-region');
                return {
                  headingOutside: !card.contains(heading) && heading.getBoundingClientRect().bottom <= card.getBoundingClientRect().top,
                  sectionBorder: getComputedStyle(section).borderTopWidth,
                  cardBorder: getComputedStyle(card).borderTopWidth,
                  headingBackground: getComputedStyle(heading).backgroundColor,
                  cardBackground: getComputedStyle(card).backgroundColor,
                  copyInside: card.contains(section.querySelector('.ai-tool-copy-button')),
                };
              }));
              assert.equal(sections.length, 3);
              for (const section of sections) {
                assert.ok(section.headingOutside && section.copyInside, `${context}/${theme}: heading stays above the card and copy stays inside`);
                assert.equal(section.sectionBorder, '0px');
                assert.equal(section.cardBorder, '1px');
                assert.equal(section.headingBackground, 'rgba(0, 0, 0, 0)');
                assert.notEqual(section.cardBackground, 'rgba(0, 0, 0, 0)');
              }
              const inputViewport = page.locator('.ai-detail-section').first().locator('[data-slot="scroll-area-viewport"]');
              await inputViewport.focus();
              assert.deepEqual(await inputViewport.evaluate(element => ({
                focused: element.matches(':focus-visible'),
                outline: getComputedStyle(element).outlineStyle,
                shadow: getComputedStyle(element).boxShadow,
                cardOutline: getComputedStyle(element.closest('.ai-tool-content-region')).outlineStyle,
              })), { focused: true, outline: 'none', shadow: 'none', cardOutline: 'none' },
              `${context}/${theme}: content remains focusable without a focus border`);
              await page.locator('[data-slot="scroll-area-viewport"], .ai-detail-sections, .ai-diff-content').evaluateAll(elements => elements.forEach(element => {
                element.scrollTop = 0;
                element.scrollLeft = 0;
              }));
              const output = page.locator('.ai-detail-section').nth(1);
              await output.locator('.ai-tool-surface-header').first().scrollIntoViewIfNeeded();
              await output.locator('.ai-diff-content').first().hover({ position: { x: 24, y: 8 } });
              await page.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}-${theme}-external-titles.png`) });
            }
          }
          if (!detail) {
            const viewport = page.locator('.ai-diff-content [data-slot="scroll-area-viewport"]').first();
            const overflowing = viewport.and(page.locator('[data-overflow-y-end]'));
            const mask = () => viewport.evaluate(element => getComputedStyle(element).maskImage);
            assert.ok((await page.locator('.ai-diff-content').first().boundingBox()).height <= 260);
            await overflowing.waitFor();
            assert.notEqual(await mask(), 'none', `${context}: more lines should fade at the bottom`);
            await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
            assert.ok(await viewport.evaluate(element => element.scrollTop > 0), `${context}: vertical scrolling is retained`);
            await overflowing.waitFor({ state: 'detached' });
            assert.equal(await mask(), 'none', `${context}: the last lines should be clear`);
            await viewport.evaluate(element => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
            for (const theme of ['light', 'dark']) {
              await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
              const body = page.locator('.ai-diff-body').first();
              assert.equal(await body.evaluate(element => getComputedStyle(element).whiteSpace), 'pre');
              for (const kind of ['added', 'removed']) {
                const row = page.locator(`.ai-diff-body [data-diff="${kind}"]`).first();
                const number = row.locator('.ai-diff-line-number');
                const count = row.locator('xpath=ancestor::section').locator(`[data-diff-count="${kind}"]`);
                assert.ok(Number(await number.textContent()) > 0, `${context}/${theme}: line numbers remain visible`);
                assert.equal(await number.evaluate(element => getComputedStyle(element).color),
                  await count.evaluate(element => getComputedStyle(element).color));
                assert.notEqual(await row.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
              }
              await page.locator('.ai-diff-block').screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}-${theme}.png`) });
            }
          }
          await page.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}.png`) });
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Diff headers stay fixed in Chromium/WebKit at 380px/720px, including detail styles. Screenshots: ${artifacts}`);
} finally { await server.close(); }
