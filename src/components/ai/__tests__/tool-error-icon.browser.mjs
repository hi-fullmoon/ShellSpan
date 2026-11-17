import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const capture = JSON.parse(await readFile(join(root, 'src/tests/fixtures/tool-result-read-recovery.json'), 'utf8'));
const artifacts = join(root, 'artifacts/tests/tool-error-icon');
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__tool_error_icon', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell"></main></body></html>');
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [380, 720]) {
          const page = await browser.newPage({ viewport: { width, height: 640 }, reducedMotion: 'reduce' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__tool_error_icon`);
          await page.evaluate(async ({ capture, locale }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiToolRow } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
            const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            useAppStore.setState({ locale });
            await initI18n(locale);
            const firstTool = events => projectAgentChatNodes(events)
              .flatMap(node => node.kind === 'turnProcess' ? node.children : [])
              .find(node => node.kind === 'tool');
            const failure = firstTool(capture.slice(0, 2));
            const recovered = firstTool(capture);
            assertTool(failure);
            assertTool(recovered);
            function assertTool(tool) {
              if (!tool) throw new Error('Recorded tool result is missing');
            }
            const view = createRoot(document.getElementById('root'));
            window.renderTool = recoveredStage => view.render(React.createElement(AiToolRow, {
              node: recoveredStage ? recovered : failure,
            }));
            window.renderTool(false);
          }, { capture, locale });
          const row = page.locator('.ai-tool-row');
          const arrow = row.locator('.ai-disclosure-chevron');
          await row.waitFor();
          for (const theme of ['light', 'dark']) {
            const context = `${engine.name()}/${locale}/${theme}/${width}`;
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await page.mouse.move(width - 1, 600);
            const dot = await row.locator('.ai-state-dot').evaluate(element => getComputedStyle(element).backgroundColor);
            const summary = await row.locator('.ai-disclosure-summary').evaluate(element => getComputedStyle(element).color);
            assert.notEqual(dot, summary, `${context}: summary retains its muted color`);
            assert.equal(await arrow.evaluate(element => getComputedStyle(element).opacity), '0');
            await row.hover();
            assert.equal(await arrow.evaluate(element => getComputedStyle(element).opacity), '1');
            assert.equal(await arrow.evaluate(element => getComputedStyle(element).color), dot,
              `${context}: hovered arrow matches the red failure dot`);
            await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${theme}-${width}-hover.png`) });
            await page.mouse.move(width - 1, 600);
            await page.keyboard.press('Tab');
            await row.focus();
            assert.equal(await row.evaluate(element => element.matches(':focus-visible')), true);
            assert.equal(await arrow.evaluate(element => getComputedStyle(element).opacity), '1');
            assert.equal(await arrow.evaluate(element => getComputedStyle(element).color), dot,
              `${context}: keyboard focus preserves the red arrow`);
            await row.press('Enter');
            assert.equal(await row.getAttribute('aria-expanded'), 'true');
            assert.equal(await arrow.evaluate(element => getComputedStyle(element).color), dot,
              `${context}: expanded arrow remains red`);
            await row.press('Enter');
            await row.evaluate(element => element.blur());
          }
          await page.evaluate(() => window.renderTool(true));
          await page.locator('[data-tool-recovered="true"]').waitFor();
          await row.hover();
          const recovered = await row.evaluate(element => ({
            arrow: getComputedStyle(element.querySelector('.ai-disclosure-chevron')).color,
            muted: getComputedStyle(element.querySelector('.ai-disclosure-leading')).color,
          }));
          assert.equal(recovered.arrow, recovered.muted, 'Recovered tools restore the normal arrow color');
          assert.equal(await row.locator('.ai-disclosure-summary[data-error]').count(), 0);
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Tool error icon checks passed in Chromium/WebKit, both languages and themes, at 380px/720px. Screenshots: ${artifacts}`);
} finally {
  await server.close();
}
