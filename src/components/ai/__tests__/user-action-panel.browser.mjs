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
// No model provider, IPC replacement or answer-submission callback is installed.
assert.ok(process.argv[2], 'Pass a production-store JSONL ledger with a selected pending user operation.');
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(line => JSON.parse(line));
assert.ok(events.some(event => event.type === 'question/answered'), 'A committed selection is required.');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = join(tmpdir(), 'shellspan-user-action-review');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error', cacheDir: join(output, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' }, plugins: [tailwindcss()],
  optimizeDeps: {
    entries: [
      'src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts',
      'src/components/ai/workspace/ai-question-panel.tsx',
      'src/components/ui/sonner.tsx',
      'src/lib/ai/question-projection.ts',
      'src/locales/index.ts',
    ],
    include: ['react', 'react-dom', 'react-dom/client'],
  },
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
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      for (const locale of ['en-US', 'zh-CN']) {
        for (const width of [320, 420, 720]) {
          const page = await browser.newPage({
            viewport: { width, height: 640 },
            ...(engine === chromium && { permissions: ['clipboard-read', 'clipboard-write'] }),
          });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          page.on('response', response => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
          });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__user-action`);
          const verificationCommand = await page.evaluate(async ({ events, locale }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiQuestionPanel } = await import('/src/components/ai/workspace/ai-question-panel.tsx');
            const { Toaster } = await import('/src/components/ui/sonner.tsx');
            const { TooltipProvider } = await import('/src/components/ui/tooltip.tsx');
            const { projectQuestions } = await import('/src/lib/ai/question-projection.ts');
            const { pendingUserAction } = await import('/src/types/agent-question.ts');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            await initI18n(locale);
            useAppStore.setState({ locale });
            const question = projectQuestions(events).find(q => pendingUserAction(q));
            const action = question && pendingUserAction(question);
            if (!action) throw new Error('The actual ledger must project a pending user operation.');
            createRoot(document.getElementById('root')).render(React.createElement(TooltipProvider, null,
              React.createElement(AiQuestionPanel, { question }), React.createElement(Toaster)));
            return action.verification_command;
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
          const copyLabel = locale === 'zh-CN' ? '复制命令' : 'Copy command';
          const region = page.locator('.ai-question-panel-content [data-ai-copy-region]');
          const copy = region.getByRole('button', { name: copyLabel });
          const command = region.locator('pre');
          await copy.scrollIntoViewIfNeeded();
          const [regionBox, commandBox, copyBox] = await Promise.all([region.boundingBox(), command.boundingBox(), copy.boundingBox()]);
          const [background, panelBackground] = await Promise.all([
            region.evaluate(element => getComputedStyle(element).backgroundColor),
            page.locator('.ai-question-panel').evaluate(element => getComputedStyle(element).backgroundColor),
          ]);
          assert.notEqual(background, 'rgba(0, 0, 0, 0)', 'The command block must have a background.');
          assert.notEqual(background, panelBackground, 'The command and panel backgrounds must be distinct.');
          assert.equal(await copy.textContent(), '', 'The copy button must have no visible text label.');
          assert.equal(await copy.locator('svg').count(), 1);
          assert.equal(copyBox.height, copyBox.width, 'The copy button must be square.');
          assert.ok(commandBox.x + commandBox.width <= copyBox.x, 'The copy button must not overlap the command.');
          assert.ok(copyBox.x + copyBox.width <= regionBox.x + regionBox.width, 'The copy button must fit inside the command block.');
          const copyOpacity = () => copy.evaluate(element => getComputedStyle(element).opacity);
          assert.equal(await copyOpacity(), '0', 'The copy button must be hidden at rest.');
          await command.hover();
          assert.equal(await copyOpacity(), '1', 'Hovering the command block must reveal the copy button.');
          await page.screenshot({ path: join(output, `${engineName}-${locale}-${width}.png`) });
          await page.mouse.move(0, 0);
          assert.equal(await copyOpacity(), '0', 'Leaving the command block must hide the copy button.');
          if (width === 720) {
            await command.hover();
            await copy.hover();
            await page.locator('[data-slot="tooltip-content"]').filter({ hasText: copyLabel }).waitFor({ timeout: 5_000 });
            await copy.click();
          } else {
            await page.locator('.ai-question-panel-header button').focus();
            await page.keyboard.press('Tab');
            assert.equal(await copy.evaluate(button => button === document.activeElement), true);
            assert.equal(await copyOpacity(), '1', 'Keyboard focus must reveal the copy button.');
            await page.keyboard.press('Enter');
          }
          await page.getByText(locale === 'zh-CN' ? '已复制' : 'Copied', { exact: true }).waitFor();
          if (engine === chromium) {
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), verificationCommand);
          }
          assert.deepEqual(errors, []);
          checks++;
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`User operation layout and copy verified in ${checks} browser/locale/width combinations. Screenshots: ${output}`);
} finally { await server.close(); }
