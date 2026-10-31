import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-tool-detail-output-spacing');
await mkdir(screenshots, { recursive: true });
const events = JSON.parse(await readFile(join(root, 'src/test/fixtures/tool-result-read-recovery.json'), 'utf8'));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [tailwindcss(), {
    name: 'tool-detail-output-spacing',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell"></main></body></html>');
      });
    },
  }],
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of ['zh-CN', 'en-US']) {
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
        const diagnostic = await page.evaluate(async ({ events, locale }) => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
          const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
          const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(locale);
          useAppStore.setState({ locale });
          const node = projectAgentChatNodes(events.slice(0, 2))
            .flatMap(item => item.kind === 'turnProcess' ? item.children : [])
            .find(item => item.kind === 'tool');
          if (!node) throw new Error('Recorded failure is missing');
          createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
            React.createElement('div', { style: { height: 700 } }, React.createElement(AiToolDetails, { node, onBack() {} })),
            React.createElement('div', { id: 'inline-result' }, React.createElement(AiToolExpandedContent, { node }))));
          return node.error || node.summary;
        }, { events, locale });
        const detail = page.locator('[data-slot="ai-tool-details"]');
        const output = detail.locator('.ai-detail-section').nth(1);
        const text = output.locator('pre');
        await text.waitFor();
        assert.equal(await text.textContent(), diagnostic);
        assert.equal(await page.locator('#inline-result .ai-tool-surface-header').count(), 0, 'Inline errors must not retain an empty heading row');
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          for (const width of [220, 390, 720]) {
            await page.setViewportSize({ width, height: 900 });
            const context = `${engine.name()}/${locale}/${theme}/${width}`;
            const inline = page.locator('#inline-result [data-ai-tool-view="error"]');
            assert.equal(await inline.locator('pre').evaluate(element => {
              const block = element.closest('[data-ai-tool-view="error"]');
              return element.getBoundingClientRect().top - block.getBoundingClientRect().top - block.clientTop;
            }), 0, `${context}: diagnostics start directly inside the content border`);
            if (locale === 'zh-CN') await inline.screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}-inline.png`) });
            const layout = await text.evaluate(element => {
              const style = getComputedStyle(element);
              const region = element.closest('.ai-detail-section > .ai-tool-content-region');
              return {
                top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom),
                lineHeight: parseFloat(style.lineHeight), height: element.getBoundingClientRect().height,
                regionHeight: region.getBoundingClientRect().height,
                clientWidth: region.clientWidth, scrollWidth: region.scrollWidth,
              };
            });
            assert.equal(layout.bottom, layout.top, `${context}: output must have equal vertical padding`);
            assert.equal(layout.top, 8, `${context}: output uses the shared code padding`);
            const rows = (layout.height - layout.top - layout.bottom) / layout.lineHeight;
            assert.ok(rows >= 1 && Math.abs(rows - Math.round(rows)) < 0.05,
              `${context}: output must retain complete readable lines (${rows} rows)`);
            if (width === 220) assert.ok(rows > 1.5, `${context}: narrow output must wrap`);
            assert.ok(Math.abs(layout.regionHeight - layout.height - 2) < 1,
              `${context}: scrolling wrappers must not leave extra space: ${JSON.stringify(layout)}`);
            assert.ok(layout.scrollWidth <= layout.clientWidth, `${context}: wrapped output must fit`);
            assert.equal(await page.locator('#inline-result pre').evaluate(element => getComputedStyle(element).paddingBottom), '8px',
              `${context}: inline tool results use the same padding as details`);
            const copy = output.getByRole('button', { name: locale === 'zh-CN' ? '复制输出' : 'Copy Output', exact: true });
            await copy.focus();
            assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1', `${context}: copy remains keyboard accessible`);
            await copy.blur();
            if (locale === 'zh-CN') await detail.screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}.png`) });
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log(`Tool detail output spacing passed in Chromium/WebKit, both languages and themes, at 220px/390px/720px. Screenshots: ${screenshots}`);
} finally { await server.close(); }
