import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = `${root}artifacts/tests/ai-ui/process-folding`;
await mkdir(output, { recursive: true });
// Optional complete real runtime log, replayed without changing any event.
const runtimeEvents = process.argv[2]
  ? (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse) : undefined;
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-process-folding-${process.pid}`,
  resolve: { alias: { '@': `${root}src` } }, plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__process-folding', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__process-folding',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/ai-process-folding.browser.tsx"></script></body></html>'));
});
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__process-folding`;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      for (const width of [420, 900]) for (const locale of ['en-US', 'zh-CN']) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const reset = async () => {
          await page.goto(url);
          await page.waitForFunction(() => Boolean(window.replayFoldingRecording));
          await page.evaluate(locale => window.setFoldingLocale(locale), locale);
        };
        const process = page.locator('.ai-turn-process-trigger').first();
        const processRows = async (trigger = process) => {
          const key = await trigger.evaluate(element => element.closest('[data-ai-node-key]').dataset.aiNodeKey);
          return page.locator(`[data-ai-process-owner=${JSON.stringify(key)}]`)
            .filter({ has: page.locator('.ai-transcript-flow-item:not(:empty)') });
        };
        const readStart = async () => {
          const viewport = page.locator('[data-message-scroller-viewport]');
          await viewport.hover({ position: { x: 4, y: 4 } });
          await page.mouse.wheel(0, -100000);
          await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop <= 2);
        };
        const beforeCompletion = () => page.evaluate(() => {
          const events = window.foldingRecordings.completed;
          window.replayFoldingRecording('completed', events.findIndex(event => event.type === 'turn/end'));
        });
        await reset();
        await page.evaluate(() => window.replayFoldingRecording('progress', 15));
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        await page.evaluate(() => document.fonts.ready);
        const stability = await page.evaluate(async () => {
          const find = () => [...document.querySelectorAll('.ai-assistant-markdown p')]
            .find(p => p.textContent === 'Two candidate project directories. Let me examine both.');
          const original = find();
          const seat = original.closest('[data-slot="message-scroller-item"]');
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const top = original.getBoundingClientRect().top + viewport.scrollTop;
          const compactInset = () => Number.parseFloat(getComputedStyle(original.closest('.ai-conversation-row-body')).paddingTop);
          const initialInset = compactInset();
          const range = document.createRange();
          range.selectNodeContents(original);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          const selected = window.getSelection().toString();
          const samples = [];
          for (const length of [16, 17, 19]) {
            window.replayFoldingRecording('progress', length);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const current = find();
            samples.push({ sameNode: current === original,
              sameSeat: current.closest('[data-slot="message-scroller-item"]') === seat,
              selected: window.getSelection().toString() === selected,
              initialInset, inset: compactInset(),
              delta: current.getBoundingClientRect().top + viewport.scrollTop - top });
          }
          window.getSelection().removeAllRanges();
          return samples;
        });
        assert.ok(stability.every(sample => sample.sameNode && sample.sameSeat && sample.selected && Math.abs(sample.delta) < 1),
          `${engine.name()} ${width} ${locale}: tool deltas and settlement must preserve text position and selection: ${JSON.stringify(stability)}`);
        assert.ok(stability.every(sample => sample.initialInset === 4 && sample.inset === 4),
          'Process prose must retain 4px spacing before tool deltas and after settlement');
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${locale}-stable-prose.png`, animations: 'disabled' });
        const prose = page.getByText('Two candidate project directories. Let me examine both.', { exact: true });
        await prose.waitFor();
        assert.equal(await prose.evaluate(element => Boolean(element.closest('[data-ai-process-owner]'))), true);
        assert.equal(await page.locator('[data-ai-node-kind="assistantMessage"]').count(), 2);
        await process.click();
        await prose.waitFor({ state: 'hidden' });
        await process.press('Enter');
        await prose.waitFor();
        await reset();
        await page.evaluate(() => {
          const events = window.foldingRecordings.completed;
          window.replayFoldingRecording('completed', events.findLastIndex(event => event.type === 'assistant/message'));
        });
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        assert.equal(await process.getAttribute('aria-expanded'), 'true');
        const finalSelection = await page.evaluate(() => {
          const paragraph = [...document.querySelectorAll('.ai-assistant-markdown p')]
            .find(element => element.textContent === 'COMPACT-CHECK-4719');
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          window.replayFoldingRecording('completed');
          return { sameNode: [...document.querySelectorAll('.ai-assistant-markdown p')]
            .find(element => element.textContent === 'COMPACT-CHECK-4719') === paragraph,
            selected: window.getSelection().toString() };
        });
        assert.deepEqual(finalSelection, { sameNode: true, selected: 'COMPACT-CHECK-4719' });
        await page.evaluate(() => window.getSelection().removeAllRanges());
        await page.waitForFunction(() => document.querySelector('.ai-turn-process-trigger')?.getAttribute('aria-expanded') === 'false');
        await (await processRows()).first().waitFor({ state: 'hidden' });
        await page.getByText(/COMPACT-CHECK-4719/).waitFor();
        assert.equal(await page.locator('[data-ai-node-kind="assistantMessage"]:visible').count(), 1);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${locale}-completed.png`, animations: 'disabled' });
        await process.click();
        await (await processRows()).first().waitFor();
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${locale}-expanded.png`, animations: 'disabled' });
        await reset();
        await beforeCompletion();
        const control = page.locator('[data-ai-process-owner] button').first();
        await control.waitFor({ state: 'visible' });
        await control.focus();
        assert.equal(await control.evaluate(element => document.activeElement === element), true,
          `${engine.name()} ${width} ${locale}: the process control must take focus before completion`);
        await page.evaluate(() => window.replayFoldingRecording('completed'));
        assert.equal(await process.getAttribute('aria-expanded'), 'true', `${engine.name()} ${width} ${locale}: keep the focused process open`);
        assert.equal(await control.evaluate(element => document.activeElement === element), true);
        for (const name of ['failed', 'interleaved']) {
          await reset();
          await page.evaluate(name => window.replayFoldingRecording(name), name);
          await readStart();
          assert.ok(await page.locator('.ai-turn-process-trigger').count());
          assert.ok(await page.locator('.ai-turn-process-trigger').evaluateAll(elements => elements.every(element =>
            element.getAttribute('aria-expanded') === 'true' && !element.disabled)));
          for (const trigger of await page.locator('.ai-turn-process-trigger').all()) {
            const body = (await processRows(trigger)).first();
            await trigger.click();
            assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
            await body.waitFor({ state: 'hidden' });
            await trigger.press('Enter');
            assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
            await body.waitFor({ state: 'visible' });
            await trigger.press('Space');
            await body.waitFor({ state: 'hidden' });
            assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
          }
          await page.screenshot({ path: `${output}/${engine.name()}-${width}-${locale}-${name}-collapsed.png`, animations: 'disabled' });
        }
        if (runtimeEvents) {
          await reset();
          const end = runtimeEvents.findLastIndex(event => event.type === 'turn/end');
          assert.ok(end > 0);
          await page.evaluate(events => window.replayFoldingEvents(events), runtimeEvents.slice(0, end));
          await readStart();
          const progress = page.locator('[data-ai-process-owner] .ai-assistant-markdown p').first();
          await progress.scrollIntoViewIfNeeded();
          const selected = await progress.evaluate(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString();
          });
          assert.ok(selected.trim(), 'The real review must contain selectable process prose');
          await page.evaluate(events => window.replayFoldingEvents(events), runtimeEvents);
          assert.equal(await process.getAttribute('aria-expanded'), 'true');
          assert.equal(await page.evaluate(() => window.getSelection().toString()), selected);
          await reset();
          const answers = await page.evaluate(events => window.replayFoldingEvents(events), runtimeEvents);
          assert.equal(answers.length, 1, 'The complete recorded review must expose exactly one final answer');
          assert.equal(await page.locator('[data-ai-node-kind="systemPrompt"]').count(), 0,
            'The production workspace must filter system prompts from the conversation');
          await page.getByRole('heading', { name: /全仓库深度审查报告/ }).waitFor();
          assert.equal(await process.getAttribute('aria-expanded'), 'false');
          await readStart();
          await page.screenshot({ path: `${output}/${engine.name()}-${width}-${locale}-runtime.png`, animations: 'disabled' });
          await process.click();
          await page.getByText('Two candidate project directories. Let me examine both.', { exact: true }).waitFor();
          assert.equal(await page.getByText('Two candidate project directories. Let me examine both.', { exact: true })
            .evaluate(element => Boolean(element.closest('[data-ai-process-owner]'))), true);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Conversation must fit its container');
        await reset();
        await page.setViewportSize({ width, height: 280 });
        await page.evaluate(() => window.replayFoldingRecording('completed'));
        await page.waitForFunction(() => document.querySelector('.ai-turn-process-trigger')?.getAttribute('aria-expanded') === 'false');
        await (await processRows()).first().waitFor({ state: 'hidden' });
        const viewport = page.locator('[data-message-scroller-viewport]');
        await viewport.focus();
        await viewport.press('End');
        await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop > 0);
        await viewport.press('Home');
        await page.waitForFunction(() => window.foldingAnchor()?.scrollTop === 0);
        const reading = await page.evaluate(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const top = viewport.getBoundingClientRect().top;
          const visible = [...viewport.querySelectorAll('[data-slot="message-scroller-item"]')]
            .find(item => item.getBoundingClientRect().height > 0 && item.getBoundingClientRect().bottom > top);
          return { expected: visible.querySelector('[data-ai-node-key]').dataset.aiNodeKey,
            actual: window.foldingAnchor()?.nodeKey };
        });
        assert.equal(reading.actual, reading.expected, 'Collapsed process rows must not displace the saved reading anchor');
        assert.deepEqual(errors, [], `${engine.name()} ${width} ${locale}`);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('Process folding passed in Chromium and WebKit at 420px and 900px in both locales');
} finally { await server.close(); }
