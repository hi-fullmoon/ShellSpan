import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-http-probe-timeout');
await mkdir(screenshots, { recursive: true });
// Diagnostic captured from the reported failure, rendered by the production component.
const diagnostic = 'Target loopback HTTP request exceeded its total deadline; target loopback SSH transport exceeded its total deadline';
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'http-probe-timeout-review',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell"></main></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const locale of ['zh-CN', 'en-US']) {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.evaluate(async ({ locale, diagnostic }) => {
      const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
      await import('/src/styles/base.css');
      await import('/src/components/ai/styles/styles.css');
      const { AiToolRow } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
      const { initI18n } = await import('/src/locales/index.ts');
      const { useAppStore } = await import('/src/stores/appStore.ts');
      await initI18n(locale);
      useAppStore.setState({ locale });
      createRoot(document.getElementById('root')).render(React.createElement(AiToolRow, {
        node: { kind: 'tool', name: 'probe_http', nativeName: 'probe_http', state: 'failed',
          summary: diagnostic, error: diagnostic, output: diagnostic, durationMs: null,
          input: { method: 'get', port: 80, path: '/' } },
      }));
    }, { locale, diagnostic });
    const row = page.locator('.ai-tool-row');
    assert.equal(await row.innerText(), locale === 'zh-CN'
      ? 'HTTP 检查\nHTTP 健康检查超时' : 'HTTP check\nHTTP health check timed out');
    await row.focus();
    await page.keyboard.press('Enter');
    await page.locator('.ai-web-answer').waitFor();
    await page.waitForFunction(() => {
      const panel = document.querySelector('.ai-tool-row-root > [data-slot="collapsible-content"]');
      return panel && panel.getBoundingClientRect().height >= panel.scrollHeight - 1;
    });
    assert.equal(await page.locator('.ai-detail-code').innerText(), diagnostic);
    for (const width of [380, 720]) {
      await page.setViewportSize({ width, height: 420 });
      const fits = await page.locator('.ai-web-block').evaluate(element => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth;
      });
      assert.ok(fits, `${locale}/${width}: the probe details must fit the panel`);
      const spacing = await page.locator('.ai-block-banner').evaluate(element => {
        const icon = element.querySelector('svg').getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element.querySelector(':scope > span'));
        return range.getBoundingClientRect().left - icon.right;
      });
      assert.ok(Math.abs(spacing - 4) < 1, `${locale}/${width}: icon/text gap must remain 4px`);
      await page.screenshot({ path: join(screenshots, `${locale}-${width}.png`) });
    }
    await row.focus();
    await page.keyboard.press('Enter');
    assert.equal(await row.getAttribute('aria-expanded'), 'false');
  }
  assert.deepEqual(errors, []);
  console.log(`HTTP probe timeout rendering passed in both languages at 380px and 720px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
