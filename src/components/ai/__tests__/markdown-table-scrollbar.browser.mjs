import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(root, 'artifacts/tests/markdown-table-scrollbar');
await mkdir(artifacts, { recursive: true });
const source = await readFile(join(root, 'protocol/agent/runtime/terminal-execution-compatibility.md'), 'utf8');
const document = unified().use(remarkParse).use(remarkGfm).parse(source);
const table = document.children.filter(node => node.type === 'table')[1];
assert.ok(table?.position, 'The real compatibility document must contain its feature flag table');
const markdown = source.slice(table.position.start.offset, table.position.end.offset);
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__table-scrollbar', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell" style="padding:16px"></main></body></html>');
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      for (const width of [380, 720]) {
        for (const theme of ['light', 'dark']) {
          const page = await browser.newPage({ viewport: { width, height: 640 }, reducedMotion: 'reduce' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__table-scrollbar`);
          await page.evaluate(async ({ markdown, theme }) => {
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            const { MarkdownContent } = await import('/src/components/ai/assistant-message-content.tsx');
            document.documentElement.dataset.theme = theme;
            createRoot(document.getElementById('root')).render(React.createElement(MarkdownContent, {
              copyLabel: '复制', copiedLabel: '已复制', children: markdown,
            }));
          }, { markdown, theme });
          const viewport = page.locator('.ai-markdown-table-scroll');
          await viewport.waitFor();
          const handle = await viewport.elementHandle();
          const context = `${engine.name()}/${width}/${theme}`;
          const inspect = () => viewport.evaluate(element => ({
            thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
            overflow: getComputedStyle(element).overflowX,
            geometry: [element.clientWidth, element.clientHeight, element.scrollWidth, element.scrollHeight],
          }));
          const waitPaint = () => viewport.evaluate(() => new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.mouse.move(0, 0);
          await waitPaint();
          const hidden = await inspect();
          assert.equal(hidden.thumb, 'rgba(0, 0, 0, 0)', `${context}: scrollbar starts hidden`);
          assert.equal(hidden.overflow, 'auto');
          assert.ok(hidden.geometry[2] > hidden.geometry[0], `${context}: real document table overflows horizontally`);
          await viewport.hover({ position: { x: 10, y: 10 } });
          await waitPaint();
          const hovered = await inspect();
          assert.notEqual(hovered.thumb, hidden.thumb, `${context}: hovering the table reveals its scrollbar`);
          assert.deepEqual(hovered.geometry, hidden.geometry, `${context}: visibility does not change layout`);
          await viewport.focus();
          await page.keyboard.press('ArrowRight');
          assert.ok(await viewport.evaluate(element => document.activeElement === element),
            `${context}: the scroll container retains keyboard focus`);
          await page.mouse.wheel(120, 0);
          await page.waitForFunction(element => element.scrollLeft > 0, handle);
          await viewport.evaluate(element => element.scrollTo({ left: element.scrollWidth, top: element.scrollHeight, behavior: 'instant' }));
          assert.ok(await viewport.evaluate(element => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1),
            `${context}: the last column remains reachable`);
          await viewport.evaluate(element => element.scrollIntoView({ block: 'end' }));
          await viewport.hover({ position: { x: 10, y: (await viewport.boundingBox()).height - 10 } });
          await waitPaint();
          await page.screenshot({ path: join(artifacts, `${engine.name()}-${width}-${theme}-hover.png`) });
          await page.mouse.move(0, 0);
          await waitPaint();
          assert.equal((await inspect()).thumb, hidden.thumb, `${context}: leaving hides the scrollbar again`);
          await page.screenshot({ path: join(artifacts, `${engine.name()}-${width}-${theme}-hidden.png`) });
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await viewport.hover({ position: { x: 10, y: (await viewport.boundingBox()).height - 10 } });
          assert.equal(await viewport.evaluate(element => getComputedStyle(element).transitionDuration), '0.2s',
            `${context}: hover uses the shared Agent fade duration`);
          await page.mouse.move(0, 0);
          assert.equal(await viewport.evaluate(element => getComputedStyle(element).transitionDuration), '0.3s, 0.3s',
            `${context}: leaving uses the shared Agent fade duration`);
          assert.deepEqual(errors, [], `${context}: rendering has no runtime errors`);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Markdown table scrollbar passed Chromium/WebKit hover, layout, and keyboard checks at 380px/720px in both themes. Screenshots: ${artifacts}`);
} finally { await server.close(); }
