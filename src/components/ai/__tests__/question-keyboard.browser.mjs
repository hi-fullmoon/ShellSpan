import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Read a real durable ledger and replay through the production question projector.
// No runtime, IPC, provider, or answer-submission callback is installed.
const ledger = process.argv[2];
assert.ok(ledger, 'Pass a real session JSONL ledger containing a multi-question single-select request.');
const events = [];
let requested;
const lines = createInterface({ input: createReadStream(ledger), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const event = JSON.parse(line);
  events.push(event);
  const questions = event.type === 'question/requested' ? event.data.arguments.questions : null;
  if (questions?.length > 1 && !questions[0].multi_select
    && questions[0].options?.length > 1 && questions[1].options?.length > 1) {
    requested = event;
    break;
  }
}
assert.ok(requested, 'The real ledger must contain consecutive questions with at least two options.');

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-question-keyboard');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__question-keyboard', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell @container/ai-workspace" style="height:100vh;display:flex;flex-direction:column;justify-content:flex-end"></main></body></html>');
});

let checks = 0;
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [320, 720]) {
          const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__question-keyboard`);
          const labels = await page.evaluate(async ({ events, locale, width }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiQuestionPanel } = await import('/src/components/ai/workspace/ai-question-panel.tsx');
            const { ToggleGroup, ToggleGroupItem } = await import('/src/components/ui/toggle-group.tsx');
            const { projectQuestions } = await import('/src/lib/ai/question-projection.ts');
            const { initI18n, t } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            await initI18n(locale);
            useAppStore.setState({ locale });
            const question = projectQuestions(events).find(question => question.firstSeq === events.at(-1).seq);
            if (question?.status !== 'pending') throw new Error('The production projection must yield the recorded pending question.');
            const host = document.getElementById('root');
            host.style.width = `${width}px`;
            const view = createRoot(host);
            view.render(React.createElement(AiQuestionPanel, { question }));
            window.showHorizontalQuestionOptions = () => {
              view.render(React.createElement(ToggleGroup, { 'aria-label': question.questions[0].question },
                question.questions[0].options.map(option => React.createElement(ToggleGroupItem, {
                  key: option.label, value: option.label,
                }, option.label))));
            };
            return {
              firstOption: question.questions[0].options[0].label,
              count: question.questions.length,
              previous: t('ai.workspace.question.previous'),
              next: t('ai.workspace.question.next'),
              submit: t('ai.workspace.question.submit'),
            };
          }, { events, locale, width });
          const options = page.locator('[data-slot="toggle-group-item"]');
          await options.first().waitFor();
          assert.equal(await page.getByRole('button', { name: labels.submit, exact: true }).isDisabled(), true,
            'The rendering check must never enable answer submission without a runtime callback.');
          assert.equal(await options.first().evaluate(element => element === document.activeElement), false,
            'Mounting a question must not steal focus.');
          await options.first().focus();
          await page.keyboard.press('ArrowDown');
          assert.equal(await options.nth(1).evaluate(element => element === document.activeElement), true,
            'ArrowDown must follow the vertical answer layout.');
          await page.keyboard.press('ArrowUp');
          assert.equal(await options.first().evaluate(element => element === document.activeElement), true);
          await page.keyboard.press('ArrowRight');
          assert.equal(await options.first().evaluate(element => element === document.activeElement), true,
            'Horizontal navigation must not move focus in the vertical answer group.');
          await page.keyboard.press('Enter');
          await page.waitForFunction(count => document.querySelector('.ai-question-pagination span')?.textContent.trim() === `2/${count}`, labels.count);
          await page.waitForFunction(() => document.querySelector('[data-slot="toggle-group-item"]') === document.activeElement);
          assert.equal(await options.first().evaluate(element => element === document.activeElement), true,
            'Selecting a single answer must transfer focus to the next question.');
          await page.keyboard.press('ArrowDown');
          assert.equal(await options.nth(1).evaluate(element => element === document.activeElement), true,
            'Keyboard navigation must continue in the next question without an extra Tab.');

          const previous = page.getByRole('button', { name: labels.previous, exact: true });
          await previous.focus();
          await page.keyboard.press('Enter');
          await page.waitForFunction(count => document.querySelector('.ai-question-pagination span')?.textContent.trim() === `1/${count}`, labels.count);
          assert.equal(await page.getByRole('button', { name: labels.firstOption, exact: true }).getAttribute('aria-pressed'), 'true',
            'Moving between questions must retain the selected answer.');
          const next = page.getByRole('button', { name: labels.next, exact: true });
          await next.focus();
          await page.keyboard.press('Enter');
          await page.waitForFunction(count => document.querySelector('.ai-question-pagination span')?.textContent.trim() === `2/${count}`, labels.count);
          if (await next.isEnabled()) {
            assert.equal(await next.evaluate(element => element === document.activeElement), true,
              'Manual pagination must preserve focus while its initiating button remains enabled.');
          }
          await page.evaluate(() => document.fonts.ready);
          await page.locator('#root').screenshot({ path: join(screenshots, `${engine.name()}-${locale}-${width}.png`) });

          await page.evaluate(() => window.showHorizontalQuestionOptions());
          await page.locator('[data-slot="ai-question-panel"]').waitFor({ state: 'detached' });
          await options.first().focus();
          await page.keyboard.press('ArrowDown');
          assert.equal(await options.first().evaluate(element => element === document.activeElement), true,
            'The shared component must preserve its default horizontal keyboard behavior.');
          await page.keyboard.press('ArrowRight');
          assert.equal(await options.nth(1).evaluate(element => element === document.activeElement), true);
          await page.keyboard.press('ArrowLeft');
          assert.equal(await options.first().evaluate(element => element === document.activeElement), true);
          assert.deepEqual(errors, [], 'Question keyboard interaction must not raise browser errors.');
          await page.close();
          checks++;
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Question keyboard checks passed: ${checks} engine/locale/container combinations. Screenshots: ${screenshots}`);
} finally { await server.close(); }
