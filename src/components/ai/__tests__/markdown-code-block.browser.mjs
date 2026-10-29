import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const source = (await readFile(new URL('../../../../AGENTS.md', import.meta.url), 'utf8')).trimEnd();
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'markdown-code-browser-test',
    resolveId(id) { if (id === '/code-runtime.js') return id; },
    load(id) {
      if (id === '/code-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { MarkdownContent } from '/src/components/ai/assistant-message-content.tsx';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell" style="padding:16px"></main></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      for (const width of [360, 560, 1000]) {
        for (const theme of ['light', 'dark']) {
          const page = await browser.newPage({ viewport: { width, height: 640 } });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
          await page.evaluate(async ({ source, theme }) => {
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            document.documentElement.dataset.theme = theme;
            const { React, createRoot, MarkdownContent } = await import('/code-runtime.js');
            createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
              ...[true, false].map(showCodeBlockActions => React.createElement(MarkdownContent, {
                key: String(showCodeBlockActions), copyLabel: '复制', copiedLabel: '已复制', showCodeBlockActions,
                children: '### AGENTS.md\n\n~~~\n' + source + '\n~~~\n\n~~~markdown\n' + source + '\n~~~',
              })),
            ));
          }, { source, theme });
          await page.locator('.ai-markdown-code-block').first().waitFor();
          const blocks = page.locator('.ai-markdown-code-block');
          assert.equal(await blocks.count(), 4);
          assert.equal(await blocks.nth(2).locator('.ai-markdown-code-toolbar').count(), 0);
          assert.equal(await blocks.nth(3).locator('.ai-code-block-language').innerText(), 'markdown');
          for (let index = 0; index < 4; index++) {
            const layout = await blocks.nth(index).evaluate(block => {
              const pre = block.querySelector('pre');
              const blockRect = block.getBoundingClientRect();
              const preRect = pre.getBoundingClientRect();
              const style = getComputedStyle(block);
              return {
                rightGap: blockRect.right - preRect.right - parseFloat(style.borderRightWidth),
                leftGap: preRect.left - blockRect.left - parseFloat(style.borderLeftWidth),
                bottomGap: blockRect.bottom - preRect.bottom - parseFloat(style.borderBottomWidth),
                marginRight: getComputedStyle(pre).marginRight,
                overflowX: getComputedStyle(pre).overflowX,
                overflowY: getComputedStyle(pre).overflowY,
                scrollHeight: pre.scrollHeight, clientHeight: pre.clientHeight,
              };
            });
            assert.equal(layout.marginRight, '0px', 'Copy actions must not create an outside gutter');
            assert.ok(Math.abs(layout.leftGap) < 1 && Math.abs(layout.rightGap) < 1 && Math.abs(layout.bottomGap) < 1,
              `${engine.name()}/${width}/${theme}/${index}: the scroll layer must reach the block edges`);
            assert.equal(layout.overflowX, 'auto');
            assert.equal(layout.overflowY, 'auto');
            assert.ok(layout.scrollHeight > layout.clientHeight, 'Real repository content must scroll vertically');
          }
          const metrics = await blocks.first().evaluate(block => {
            const pre = block.querySelector('pre');
            const button = block.querySelector('button');
            const icon = button.querySelector('svg').getBoundingClientRect();
            return {
              whiteSpace: getComputedStyle(pre).whiteSpace,
              scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth,
              overflow: document.documentElement.scrollWidth > innerWidth,
              buttonText: button.textContent,
              buttonWidth: button.getBoundingClientRect().width,
              iconWidth: icon.width,
              buttonHeight: button.getBoundingClientRect().height,
              background: getComputedStyle(pre).backgroundColor,
              contentTop: pre.getBoundingClientRect().top - block.getBoundingClientRect().top + parseFloat(getComputedStyle(pre).paddingTop),
              buttonPosition: getComputedStyle(button).position,
              buttonParent: button.offsetParent === block,
            };
          });
          assert.equal(metrics.whiteSpace, 'pre');
          assert.equal(metrics.overflow, false);
          assert.equal(metrics.buttonText, '');
          assert.equal(metrics.buttonWidth, 24);
          assert.equal(metrics.iconWidth, 12);
          assert.equal(metrics.buttonHeight, 24);
          assert.equal(metrics.background, 'rgba(0, 0, 0, 0)');
          assert.ok(metrics.contentTop <= 13, 'Unlabelled code starts directly below the block padding');
          assert.equal(metrics.buttonPosition, 'absolute');
          assert.equal(metrics.buttonParent, true, 'The copy button must be anchored to the code block');
          for (let index = 0; index < 2; index++) {
            const block = blocks.nth(index);
            const button = block.locator('button');
            await block.scrollIntoViewIfNeeded();
            const before = await button.boundingBox();
            await block.locator('pre').evaluate(element => element.scrollTo({ top: element.scrollHeight, left: element.scrollWidth, behavior: 'instant' }));
            assert.deepEqual(await button.boundingBox(), before, 'Scrolling content must not move its copy action');
            await block.locator('pre').evaluate(element => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
          }
          if (width < 1000) assert.ok(metrics.scrollWidth > metrics.clientWidth);
          const pre = blocks.first().locator('pre');
          await pre.focus();
          await page.keyboard.press('ArrowRight');
          assert.ok(await pre.evaluate(node => document.activeElement === node));
          if (width < 1000) {
            await pre.hover();
            await page.mouse.wheel(100, 0);
            await page.waitForFunction(() => document.querySelector('pre').scrollLeft > 0);
          }
          if (engine === chromium) {
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            await blocks.first().hover({ position: { x: 5, y: 5 } });
            assert.equal(await blocks.first().locator('button').evaluate(element => getComputedStyle(element).opacity), '1');
            await page.getByRole('button', { name: '复制', exact: true }).first().click();
            await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
          }
          if (engine === chromium && width === 560) {
            await page.screenshot({ path: `/tmp/shellspan-code-block-${theme}.png` });
          }
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log('Markdown code blocks passed Chromium/WebKit layout, keyboard, and clipboard checks.');
} finally { await server.close(); }
