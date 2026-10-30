import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [before, after, code] = await Promise.all([
  'README.md', 'AGENTS.md', 'src/components/ai/chat-primitives.tsx',
].map(path => readFile(new URL(path, `file://${root}`), 'utf8')));
const started = performance.now();
const timestamp = new Date().toISOString();
const output = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
const sample = { before, after, code,
  command: { command: 'git ls-files', output, timestamp, durationMs: performance.now() - started } };
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-nested-output-scroll-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__nested-output', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__nested-output',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/nested-output-scroll.browser.tsx"></script></body></html>'));
});

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function positionOutput(page, inner, edge = 'middle') {
  await inner.evaluate((element, edge) => {
    const outer = element.closest('[data-message-scroller-viewport]');
    outer.scrollTop += element.getBoundingClientRect().top - outer.getBoundingClientRect().top - 160;
    const end = element.scrollHeight - element.clientHeight;
    element.scrollTop = edge === 'start' ? 0 : edge === 'end' ? end
      : edge === 'near-start' ? 60 : edge === 'near-end' ? end - 60 : end / 2;
  }, edge);
  await settle(page);
  await inner.hover();
}

async function metrics(page, inner) {
  return inner.evaluate(element => {
    const outer = element.closest('[data-message-scroller-viewport]');
    return { inner: element.scrollTop, innerEnd: element.scrollHeight - element.clientHeight,
      outer: outer.scrollTop, outerEnd: outer.scrollHeight - outer.clientHeight,
      mode: outer.parentElement.dataset.scrollMode, anchors: window.savedScrollAnchors() };
  });
}

async function assertHoverScrollbar(page, inner, variant, context, artifactName) {
  const inspect = () => inner.evaluate((element, variant) => {
    const area = element.closest('.ai-tool-scroll-area');
    const scrollbar = area?.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]');
    return {
      paint: variant === 'code' ? getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor
        : getComputedStyle(scrollbar).opacity,
      geometry: { width: element.clientWidth, height: element.clientHeight,
        contentWidth: element.scrollWidth, contentHeight: element.scrollHeight },
    };
  }, variant);
  await page.mouse.move(1, 1);
  await settle(page);
  const hidden = await inspect();
  assert.equal(hidden.paint, variant === 'code' ? 'rgba(0, 0, 0, 0)' : '0', `${context}: scrollbar starts hidden`);
  await page.screenshot({ path: `/tmp/shellspan-scrollbar-hidden-${artifactName}.png` });
  await inner.hover();
  await settle(page);
  const visible = await inspect();
  if (variant === 'code') assert.notEqual(visible.paint, hidden.paint, `${context}: hovering code reveals the native thumb`);
  else assert.equal(visible.paint, '1', `${context}: hovering output reveals the custom scrollbar`);
  assert.deepEqual(visible.geometry, hidden.geometry, `${context}: revealing the scrollbar must not resize or reflow output`);
  await page.screenshot({ path: `/tmp/shellspan-scrollbar-hover-${artifactName}.png` });
  await page.mouse.move(1, 1);
  await settle(page);
  assert.deepEqual(await inspect(), hidden, `${context}: leaving the output hides the scrollbar again without reflow`);
  await inner.hover();
}

// Observe real reads/writes without substituting their results or browser layout.
async function observeOuterPosition(page) {
  await page.evaluate(() => {
    const outer = document.querySelector('[data-message-scroller-viewport]');
    const rect = outer.getBoundingClientRect.bind(outer);
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const scrollTo = outer.scrollTo.bind(outer);
    window.outerPositionOperations = { reads: 0, writes: 0 };
    outer.getBoundingClientRect = (...args) => {
      window.outerPositionOperations.reads += 1;
      return rect(...args);
    };
    Object.defineProperty(outer, 'scrollTop', { configurable: true,
      get() { return scroll.get.call(outer); },
      set(value) { window.outerPositionOperations.writes += 1; scroll.set.call(outer, value); },
    });
    outer.scrollTo = (...args) => {
      window.outerPositionOperations.writes += 1;
      return scrollTo(...args);
    };
  });
}

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      for (const width of [380, 900]) {
        for (const variant of ['code', 'terminal']) {
          const page = await browser.newPage({ viewport: { width, height: 720 }, reducedMotion: 'reduce' });
          page.setDefaultTimeout(6000);
          page.setDefaultNavigationTimeout(30000);
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          const context = `${engine.name()}/${width}/${variant}`;
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__nested-output`);
          await page.waitForFunction(() => Boolean(window.renderNestedOutput));
          await page.evaluate(({ sample, variant }) => window.renderNestedOutput(sample, variant), { sample, variant });
          await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
          const inner = page.locator('[data-ai-node-key="output"]').locator(variant === 'code'
            ? '.ai-markdown-code-block pre' : '.ai-terminal-transcript [data-slot="scroll-area-viewport"]');
          await inner.waitFor();
          await page.evaluate(() => document.fonts.ready);
          await positionOutput(page, inner);
          const positioned = await metrics(page, inner);
          assert.ok(positioned.innerEnd > 1500, `${context}: real content must span many internal pages`);
          assert.ok(positioned.outer > 200 && positioned.outerEnd - positioned.outer > 200,
            `${context}: outer viewport needs room to chain in both directions`);
          await assertHoverScrollbar(page, inner, variant, context, `${engine.name()}-${width}-${variant}`);

          await page.mouse.wheel(0, -80);
          await page.waitForFunction(() => document.querySelector('[data-slot="message-scroller"]').dataset.scrollMode === 'reading');
          await page.waitForTimeout(200);
          await observeOuterPosition(page);
          const reading = await metrics(page, inner);
          assert.ok(reading.inner < positioned.inner - 20, `${context}: upward wheel scrolls internal output`);
          assert.ok(Math.abs(reading.outer - positioned.outer) <= 1, `${context}: starting internal reading must not move the conversation`);
          for (let index = 0; index < 12; index++) {
            await page.mouse.wheel(0, 35);
            await page.waitForTimeout(25);
          }
          await settle(page);
          const scrolled = await metrics(page, inner);
          assert.ok(scrolled.inner > reading.inner + 200, `${context}: downward wheel scrolls internal output`);
          assert.ok(Math.abs(scrolled.outer - reading.outer) <= 1, `${context}: internal scrolling must preserve outer position`);
          assert.equal(scrolled.anchors, reading.anchors, `${context}: inner scrolls must not save outer reading anchors`);
          assert.deepEqual(await page.evaluate(() => window.outerPositionOperations), { reads: 0, writes: 0 },
            `${context}: repeated internal wheels must not measure or reposition the outer viewport`);

          await page.evaluate(() => window.appendNestedOutput());
          await settle(page);
          const appended = await metrics(page, inner);
          assert.ok(appended.innerEnd > scrolled.innerEnd, `${context}: replayed output grows`);
          assert.ok(Math.abs(appended.inner - scrolled.inner) <= 1 && Math.abs(appended.outer - reading.outer) <= 1,
            `${context}: output growth must retain both reading positions`);
          await page.evaluate(() => window.appendTranscriptOutput());
          await settle(page);
          assert.ok(Math.abs((await metrics(page, inner)).outer - reading.outer) <= 1,
            `${context}: transcript growth must not resume outer following`);
          await page.evaluate(() => window.finishNestedOutput());
          await settle(page);
          assert.ok(Math.abs((await metrics(page, inner)).outer - reading.outer) <= 1,
            `${context}: completion must preserve outer reading position`);

          await positionOutput(page, inner, 'near-end');
          await page.mouse.wheel(0, 100);
          await page.waitForFunction(selector => {
            const element = document.querySelector(selector);
            return element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
          }, variant === 'code' ? '[data-ai-node-key="output"] pre' : '.ai-terminal-transcript [data-slot="scroll-area-viewport"]')
            .catch(async error => { throw new Error(`${context}: wheel must reach the internal bottom: ${JSON.stringify(await metrics(page, inner))}`, { cause: error }); });
          await page.waitForTimeout(200);
          const bottom = await metrics(page, inner);
          await page.mouse.wheel(0, 160);
          await page.waitForFunction(top => document.querySelector('[data-message-scroller-viewport]').scrollTop > top + 20, bottom.outer);
          assert.ok((await metrics(page, inner)).inner >= bottom.innerEnd - 1, `${context}: lower boundary stays at internal end`);
          await page.waitForTimeout(200);
          await positionOutput(page, inner, 'near-start');
          await page.mouse.wheel(0, -100);
          await page.waitForFunction(selector => document.querySelector(selector).scrollTop <= 1,
            variant === 'code' ? '[data-ai-node-key="output"] pre' : '.ai-terminal-transcript [data-slot="scroll-area-viewport"]');
          await page.waitForTimeout(200);
          const top = await metrics(page, inner);
          await page.mouse.wheel(0, -160);
          await page.waitForFunction(top => document.querySelector('[data-message-scroller-viewport]').scrollTop < top - 20, top.outer);
          assert.ok((await metrics(page, inner)).inner <= 1, `${context}: upper boundary stays at internal start`);

          await positionOutput(page, inner);
          await inner.focus();
          const keyboard = await metrics(page, inner);
          await page.keyboard.press('ArrowDown', { delay: 100 });
          await page.waitForTimeout(200);
          const afterKey = await metrics(page, inner);
          assert.ok(afterKey.inner > keyboard.inner,
            `${context}: keyboard scroll remains available: ${JSON.stringify({ keyboard, afterKey, focused: await inner.evaluate(element => element === document.activeElement) })}`);
          assert.ok(Math.abs(afterKey.outer - keyboard.outer) <= 1, `${context}: internal keyboard scrolling keeps the outer position`);
          if (variant === 'code') {
            const horizontal = await inner.evaluate(element => element.scrollWidth > element.clientWidth);
            assert.ok(horizontal, `${context}: source code also overflows horizontally`);
            await inner.hover();
            await page.mouse.wheel(120, 0);
            await page.waitForTimeout(200);
            assert.ok(await inner.evaluate(element => element.scrollLeft > 0), `${context}: horizontal code scrolling still works`);
            assert.ok(Math.abs((await metrics(page, inner)).outer - afterKey.outer) <= 1, `${context}: horizontal wheel must not move the conversation`);
          }
          await page.screenshot({ path: `/tmp/shellspan-nested-output-${engine.name()}-${width}-${variant}.png` });

          // Pausing while the outer viewport is following must work even when
          // all wheel movement is consumed by the nested output.
          await page.evaluate(({ sample, variant }) => window.renderNestedOutput(sample, variant, true), { sample, variant });
          await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
          await positionOutput(page, inner);
          assert.equal((await metrics(page, inner)).mode, 'following', `${context}: begin with live following intent`);
          await page.mouse.wheel(0, -80);
          await page.waitForFunction(() => document.querySelector('[data-slot="message-scroller"]').dataset.scrollMode === 'reading');
          const paused = await metrics(page, inner);
          await page.evaluate(() => window.appendTranscriptOutput());
          await settle(page);
          assert.ok(Math.abs((await metrics(page, inner)).outer - paused.outer) <= 1, `${context}: nested reading pauses live transcript following`);
          await page.locator('[data-slot="message-scroller-button"]').click();
          await page.waitForFunction(() => document.querySelector('[data-slot="message-scroller"]').dataset.scrollMode === 'following');
          await page.evaluate(() => window.appendTranscriptOutput());
          await settle(page);
          const latest = await metrics(page, inner);
          assert.ok(Math.abs(latest.outerEnd - latest.outer) <= 1, `${context}: explicit jump resumes following through new output`);
          assert.deepEqual(errors, [], context);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log('Nested code/output scrolling, geometry costs, both boundary chains, streaming and keyboard regressions passed in Chromium/WebKit at 380px/900px.');
} finally { await server.close(); }
