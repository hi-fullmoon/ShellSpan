import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Render the ledger exported by the real Session store regression test.
// No provider, IPC replacement or answer-submission callback is installed.
assert.ok(process.argv[2], 'Pass a production-store JSONL ledger with a selected pending user operation.');
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(line => JSON.parse(line));
assert.ok(events.some(event => event.type === 'question/answered'), 'A committed selection is required.');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = join(tmpdir(), 'shellspan-user-action-review');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error', cacheDir: join(output, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' }, plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root, realpathSync(join(root, 'node_modules'))] } },
});
server.middlewares.use('/__user-action', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell @container/ai-workspace" style="height:100vh;display:flex;flex-direction:column;justify-content:flex-end"></main></body></html>');
});
let checks = 0;
try {
  await server.listen();
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['en-US', 'zh-CN']) {
        for (const width of [320, 420, 720]) {
          const page = await browser.newPage({ viewport: { width, height: 640 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          page.on('response', response => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
          });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__user-action`);
          await page.evaluate(async ({ events, locale }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiQuestionPanel } = await import('/src/components/ai/workspace/ai-question-panel.tsx');
            const { projectQuestions } = await import('/src/lib/ai/question-projection.ts');
            const { pendingUserAction } = await import('/src/types/agent-question.ts');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            await initI18n(locale);
            useAppStore.setState({ locale });
            const question = projectQuestions(events).find(q => pendingUserAction(q));
            if (!question) throw new Error('The actual ledger must project a pending user operation.');
            createRoot(document.getElementById('root')).render(React.createElement(AiQuestionPanel, { question }));
          }, { events, locale });
          await page.locator('.ai-question-panel-footer button').last().waitFor();
          await page.evaluate(() => document.fonts.ready);
          assert.equal(await page.getByRole('textbox').count(), 0);
          const dimensions = await page.evaluate(() => {
            const rect = element => {
              const { left, top, right, bottom } = element.getBoundingClientRect();
              return { left, top, right, bottom };
            };
            return {
              panel: rect(document.querySelector('.ai-question-panel')),
              footer: rect(document.querySelector('.ai-question-panel-footer')),
              buttons: [...document.querySelectorAll('.ai-question-panel-footer button')].map(rect),
              content: getComputedStyle(document.querySelector('.ai-question-panel-content')).overflowY,
              documentWidth: document.documentElement.scrollWidth,
            };
          });
          assert.ok(dimensions.panel.left >= -1 && dimensions.panel.right <= width + 1, JSON.stringify(dimensions));
          assert.ok(dimensions.footer.bottom <= dimensions.panel.bottom + 1, JSON.stringify(dimensions));
          assert.ok(dimensions.documentWidth <= width, JSON.stringify(dimensions));
          assert.equal(dimensions.content, 'auto');
          for (const button of dimensions.buttons) {
            assert.ok(button.left >= dimensions.panel.left && button.right <= dimensions.panel.right, JSON.stringify(dimensions));
            assert.ok(button.bottom <= dimensions.panel.bottom, JSON.stringify(dimensions));
          }
          assert.deepEqual(errors, []);
          await page.screenshot({ path: join(output, `${engineName}-${locale}-${width}.png`) });
          checks++;
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`User operation layout verified in ${checks} browser/locale/width combinations. Screenshots: ${output}`);
} finally { await server.close(); }
