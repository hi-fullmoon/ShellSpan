import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Render a selected pending user operation from the supplied JSONL ledger.
// No model provider, IPC replacement or answer-submission callback is installed.
assert.ok(process.argv[2], 'Pass a JSONL ledger with a selected pending user operation.');
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(line => JSON.parse(line));
assert.ok(events.some(event => event.type === 'question/answered'), 'A committed selection is required.');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = join(root, 'artifacts/tests/user-action-review');
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
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/src-tauri/target/**', '**/artifacts/**'] }, fs: { allow: [root, realpathSync(join(root, 'node_modules'))] } },
});
server.middlewares.use('/__user-action', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell @container/ai-workspace" style="height:100vh;display:flex;flex-direction:column;justify-content:flex-end"></main></body></html>');
});
let checks = 0;
try {
  await server.listen();
  const channel = process.env.SHELLSPAN_BROWSER_CHANNEL;
  const engines = channel ? [['chromium', chromium]] : [['chromium', chromium], ['webkit', webkit]];
  for (const [engineName, engine] of engines) {
    const browser = await engine.launch(engine === chromium ? { channel: channel || 'chromium' } : {});
    try {
      for (const locale of ['en-US', 'zh-CN']) {
        for (const width of [200, 320, 420, 720]) {
          const page = await browser.newPage({
            viewport: { width, height: width === 200 ? 800 : 640 },
            ...(engine === chromium && { permissions: ['clipboard-read', 'clipboard-write'] }),
          });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          page.on('response', response => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
          });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__user-action`, { timeout: 15_000 });
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
          const copiedLabel = locale === 'zh-CN' ? '已复制' : 'Copied';
          const instructionsCopy = page.getByRole('button', { name: locale === 'zh-CN' ? '复制操作说明' : 'Copy instructions' });
          assert.equal(await instructionsCopy.evaluate(element => getComputedStyle(element).opacity), '1');
          await instructionsCopy.click();
          await page.locator('.ai-question-panel-actions').getByRole('button', { name: copiedLabel, exact: true }).waitFor();
          assert.equal(await page.locator('[data-sonner-toast]').count(), 0, 'Copy success must stay on the button.');
          await page.screenshot({ path: join(output, `${engineName}-${locale}-${width}-instructions.png`) });
          if (engine === chromium) {
            const instructions = await page.evaluate(async events => {
              const { projectQuestions } = await import('/src/lib/ai/question-projection.ts');
              const { pendingUserAction } = await import('/src/types/agent-question.ts');
              return pendingUserAction(projectQuestions(events).find(q => pendingUserAction(q))).instructions;
            }, events);
            assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), instructions.replace(/\r\n/g, '\n'));
          }
          const copyLabel = locale === 'zh-CN' ? '复制命令' : 'Copy command';
          await page.locator('.ai-question-verification-trigger').click();
          const region = page.locator('.ai-question-panel-content [data-ai-copy-region]').filter({ has: page.locator('[data-ai-copy-anchor]') });
          const copy = region.locator('button');
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
          const iconBox = await copy.locator('svg').boundingBox();
          assert.equal(copyBox.height, copyBox.width, 'The copy button must be square.');
          assert.equal(await copy.evaluate(element => getComputedStyle(element).position), 'absolute');
          const { firstLineCenter, lineCount } = await command.locator('code').evaluate(element => {
            const commandText = document.createRange();
            commandText.selectNodeContents(element);
            const lineCount = commandText.getClientRects().length;
            const baselineMarker = document.createElement('span');
            baselineMarker.style.cssText = 'display:inline-block;width:0;height:1ex;vertical-align:baseline';
            element.prepend(baselineMarker);
            const { top, height } = baselineMarker.getBoundingClientRect();
            baselineMarker.remove();
            return { firstLineCenter: top + height / 2, lineCount };
          });
          if (width === 200) assert.ok(lineCount > 1, 'The command must wrap in the narrow viewport.');
          const iconCenter = iconBox.y + iconBox.height / 2;
          assert.ok(Math.abs(iconCenter - firstLineCenter) <= 0.5,
            `The copy icon center (${iconCenter}) must align with the first command line (${firstLineCenter}).`);
          const commandPadding = await command.evaluate(element => parseFloat(getComputedStyle(element).paddingRight));
          assert.ok(commandBox.x + commandBox.width - commandPadding <= copyBox.x,
            'The copy button must stay inside the space reserved to the right of the command text.');
          const rightBorder = await region.evaluate(element => parseFloat(getComputedStyle(element).borderRightWidth));
          const rightInset = regionBox.x + regionBox.width - rightBorder - copyBox.x - copyBox.width;
          assert.ok(Math.abs(rightInset - 14) <= 0.5,
            `The copy button must use the shared 14px inset inside the command border, got ${rightInset}px.`);
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
            await page.locator('.ai-question-panel-actions').getByRole('button').last().focus();
            for (let tab = 0; tab < 8 && !await copy.evaluate(button => button === document.activeElement); tab++) {
              await page.keyboard.press('Tab');
            }
            assert.equal(await copy.evaluate(button => button === document.activeElement), true);
            assert.equal(await copyOpacity(), '1', 'Keyboard focus must reveal the copy button.');
            await page.keyboard.press('Enter');
          }
          await region.getByRole('button', { name: copiedLabel, exact: true }).waitFor();
          assert.equal(await copy.locator('.lucide-check').count(), 1);
          assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
          if (engine === chromium) {
            assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), verificationCommand.replace(/\r\n/g, '\n'));
          }
          const markdownRegion = page.locator('.ai-markdown-code-block [data-ai-copy-region]').first();
          if (await markdownRegion.count()) {
            const source = await markdownRegion.locator('code').textContent();
            await markdownRegion.hover();
            await markdownRegion.locator('button').click();
            await markdownRegion.getByRole('button', { name: copiedLabel, exact: true }).waitFor();
            if (engine === chromium) assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), source.replace(/\n$/, ''));
            assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
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
