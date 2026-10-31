import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const sources = await Promise.all(['AGENTS.md', 'CONTRIBUTING.md', 'README.md'].map(path => readFile(new URL(path, `file://${root}`), 'utf8')));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-reasoning-scroll-${process.pid}`,
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__reasoning', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell"></main></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const mode of ['agent', 'ask']) {
        for (const width of [380, 720]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__reasoning`);
          await page.evaluate(async ({ source, mode }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiConversationNodeList, aiAskConversationNodeRenderers } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
            const { taskTokenBudgetEvidence } = await import('/src/test/fixtures/task-token-budget.ts');
            const { initI18n } = await import('/src/locales/index.ts');
            await initI18n('en-US');
            const header = taskTokenBudgetEvidence.failed.header;
            let node = { kind: 'reasoning', key: header.sessionId, sourceKind: 'agent',
              sessionId: header.sessionId, turnId: null, stepId: null, firstSeq: 0, lastSeq: 0,
              timestamp: new Date(header.createdAtUnixMs).toISOString(), requestId: null,
              summary: '', content: source, state: 'streaming' };
            const root = createRoot(document.getElementById('root'));
            const render = () => root.render(React.createElement(AiConversationNodeList, {
              nodes: [node], renderers: mode === 'ask' ? aiAskConversationNodeRenderers : undefined,
            }));
            window.appendReasoning = text => {
              node = { ...node, content: `${node.content}\n\n${text}`, lastSeq: node.lastSeq + 1 };
              render();
            };
            window.finishReasoning = () => {
              node = { ...node, state: 'completed', lastSeq: node.lastSeq + 1 };
              render();
            };
            render();
          }, { source: sources[0], mode });
          const context = `${engine.name()}/${mode}/${width}`;
          const trigger = page.locator('.ai-reasoning-row [data-slot="collapsible-trigger"]');
          await trigger.waitFor();
          if (mode === 'agent') {
            const summary = page.locator('.ai-disclosure-summary');
            assert.deepEqual(await summary.evaluate(element => ({
              whiteSpace: getComputedStyle(element).whiteSpace,
              overflow: getComputedStyle(element).overflowX,
              textOverflow: getComputedStyle(element).textOverflow,
              height: element.getBoundingClientRect().height,
            })), { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', height: 24 },
            `${context}: collapsed reasoning summary stays on one line`);
          }
          if (await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
          else if (mode === 'ask') {
            await trigger.press('Space');
            await trigger.press('Space');
          }
          const viewport = page.locator('.ai-reasoning-viewport');
          await viewport.waitFor();
          await page.keyboard.press('Tab');
          await viewport.focus();
          assert.deepEqual(await viewport.evaluate(element => ({
            focused: element.matches(':focus-visible'),
            outline: getComputedStyle(element).outlineStyle,
            shadow: getComputedStyle(element).boxShadow,
          })), { focused: true, outline: 'none', shadow: 'none' },
          `${context}: keyboard scrolling remains available without a focus border`);
          const waitAtEnd = () => page.waitForFunction(() => {
            const element = document.querySelector('.ai-reasoning-viewport');
            return element.scrollHeight - element.scrollTop - element.clientHeight <= 2
              && !(element.dataset.scrollable ?? '').split(' ').includes('end');
          });
          await waitAtEnd();
          assert.ok((await viewport.boundingBox()).height <= 260, `${context}: reasoning stays within 260px`);
          assert.ok(await viewport.evaluate(element => element.scrollTop > 0), `${context}: initial stream follows the end`);
          await viewport.hover();
          await page.mouse.wheel(0, -400);
          await page.waitForFunction(() => {
            const element = document.querySelector('.ai-reasoning-viewport');
            return element.scrollHeight - element.scrollTop - element.clientHeight > 100;
          });
          const readingTop = await viewport.evaluate(element => element.scrollTop);
          await page.evaluate(source => window.appendReasoning(source), sources[1]);
          await page.waitForFunction(source => document.querySelector('.ai-reasoning-body').textContent.includes(source), 'Thank you for contributing!');
          assert.ok(Math.abs(await viewport.evaluate(element => element.scrollTop) - readingTop) <= 2, `${context}: new content preserves a manual reading position`);
          await viewport.hover();
          await page.mouse.wheel(0, 100000);
          await waitAtEnd();
          const previousLength = await page.locator('.ai-reasoning-body').evaluate(element => element.textContent.length);
          await page.evaluate(source => window.appendReasoning(source), sources[2]);
          await page.waitForFunction(length => document.querySelector('.ai-reasoning-body').textContent.length > length, previousLength);
          await waitAtEnd();
          await viewport.hover();
          await page.mouse.wheel(0, -400);
          await page.waitForFunction(() => {
            const element = document.querySelector('.ai-reasoning-viewport');
            return element.scrollHeight - element.scrollTop - element.clientHeight > 100;
          });
          const beforeCompletion = await viewport.evaluate(element => element.scrollTop);
          assert.ok(beforeCompletion > 0, `${context}: completion case starts in the middle of the content`);
          await page.evaluate(() => window.finishReasoning());
          await page.locator('.ai-reasoning-row[data-state="ok"]').waitFor();
          assert.ok(Math.abs(await viewport.evaluate(element => element.scrollTop) - beforeCompletion) <= 2,
            `${context}: completion preserves the manual reading position`);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log('Reasoning height, single-line preview, stream following and manual reading passed in Chromium/WebKit, Agent/Ask, at 380px/720px.');
} finally { await server.close(); }
