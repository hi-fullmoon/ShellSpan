import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = `${root}.phase4-acceptance/turn-fold`;
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
        const readStart = async () => {
          const viewport = page.locator('[data-message-scroller-viewport]');
          await viewport.focus();
          await page.keyboard.press('Home');
          await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop <= 2);
        };
        const beforeCompletion = () => page.evaluate(() => {
          const events = window.foldingRecordings.completed;
          window.replayFoldingRecording('completed', events.findIndex(event => event.type === 'turn/end'));
        });
        await reset();
        await page.evaluate(() => window.replayFoldingRecording('progress'));
        const prose = page.getByText('Two candidate project directories. Let me examine both.', { exact: true });
        await prose.waitFor();
        assert.equal(await prose.evaluate(element => Boolean(element.closest('.ai-turn-process-body'))), true);
        assert.equal(await page.locator('[data-ai-node-kind="assistantMessage"]').count(), 0);
        await process.click();
        await prose.waitFor({ state: 'hidden' });
        await process.press('Enter');
        await prose.waitFor();
        await reset();
        await beforeCompletion();
        assert.equal(await process.getAttribute('aria-expanded'), 'true');
        await page.evaluate(() => window.replayFoldingRecording('completed'));
        await page.waitForFunction(() => document.querySelector('.ai-turn-process-trigger')?.getAttribute('aria-expanded') === 'false');
        await page.locator('.ai-turn-process-body').waitFor({ state: 'hidden' });
        await page.getByText(/COMPACT-CHECK-4719/).waitFor();
        assert.equal(await page.locator('[data-ai-node-kind="assistantMessage"]').count(), 1);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${locale}-completed.png`, animations: 'disabled' });
        await process.click();
        await page.locator('.ai-turn-process-body').waitFor();
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${locale}-expanded.png`, animations: 'disabled' });
        await reset();
        await beforeCompletion();
        const control = page.locator('.ai-turn-process-body button').first();
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
          assert.ok(await page.locator('.ai-turn-process-trigger').count());
          assert.ok(await page.locator('.ai-turn-process-trigger').evaluateAll(elements => elements.every(element =>
            element.getAttribute('aria-expanded') === 'true' && element.disabled)));
        }
        if (runtimeEvents) {
          await reset();
          const end = runtimeEvents.findLastIndex(event => event.type === 'turn/end');
          assert.ok(end > 0);
          await page.evaluate(events => window.replayFoldingEvents(events), runtimeEvents.slice(0, end));
          await readStart();
          const progress = page.locator('.ai-turn-process-body .ai-assistant-markdown p').first();
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
            .evaluate(element => Boolean(element.closest('.ai-turn-process-body'))), true);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Conversation must fit its container');
        assert.deepEqual(errors, [], `${engine.name()} ${width} ${locale}`);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('Process folding passed in Chromium and WebKit at 420px and 900px in both locales');
} finally { await server.close(); }
