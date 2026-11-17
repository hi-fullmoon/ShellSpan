import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = `${root}artifacts/tests/composer-markdown`;
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error', cacheDir: `${artifacts}/vite-cache`,
  resolve: { alias: { '@': `${root}src` } },
  plugins: [react(), tailwindcss(), {
    name: 'markdown-composer-acceptance',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        void vite.transformIndexHtml(request.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/ai-composer-markdown.browser.tsx"></script></body></html>')
          .then(html => response.end(html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});

const source = '# Deployment 发布计划\n\n**Review** *changes* and ~~old steps~~\n- [x] Verify the build\n> Keep a backup\n[Docs](https://example.com)\n\n```sh\n/system-status @src/components/\n```';
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 900]) for (const theme of ['light', 'dark']) for (const locale of ['en-US', 'zh-CN']) {
        const page = await browser.newPage({ viewport: { width, height: 720 }, colorScheme: theme });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${origin}/?locale=${locale}`);
        await page.evaluate(async theme => { const { applyTheme } = await import('/src/lib/theme.ts'); applyTheme(theme); }, theme);
        const editor = page.getByRole('textbox');
        await editor.fill(source);
        await page.waitForFunction(expected => document.querySelector('output').dataset.draft === expected, source);
        const highlights = await page.evaluate(() => [...CSS.highlights].map(([name, ranges]) => ({ name, text: [...ranges].map(range => range.toString()).join('') })));
        assert.ok(highlights.some(item => item.name === 'ai-composer-md-heading' && item.text.includes('# Deployment')));
        assert.ok(highlights.some(item => item.name === 'ai-composer-md-code' && item.text.includes('/system-status @src/components/')));
        assert.equal(await editor.locator('[data-composer-command], [data-composer-directory]').count(), 0);
        assert.equal(await editor.locator('h1, strong, pre, ul').count(), 0);
        await page.screenshot({ path: `${artifacts}/${engine.name()}-${width}-${theme}-${locale}.png` });
        await editor.press('Enter');
        await page.waitForFunction(expected => document.body.dataset.submitted === expected, source);

        await editor.fill('word');
        await editor.press('ControlOrMeta+a');
        await editor.press('ControlOrMeta+b');
        await page.waitForFunction(() => document.querySelector('output').dataset.draft === '**word**');
        await editor.press('ControlOrMeta+z');
        await page.waitForFunction(() => document.querySelector('output').dataset.draft === 'word');

        await editor.fill(Array.from({ length: 32 }, (_, i) => `- Line ${i + 1}: Markdown 内容 wraps in a narrow composer`).join('\n'));
        const metrics = await editor.evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight, width: element.clientWidth, scrollWidth: element.scrollWidth }));
        assert.ok(metrics.scroll > metrics.height, 'Long drafts must scroll in the input');
        assert.ok(metrics.height <= 336 && metrics.height <= 720 * 0.42);
        assert.ok(metrics.scrollWidth <= metrics.width + 1, 'Source text must wrap');
        const send = await page.getByRole('button', { name: locale === 'zh-CN' ? '发送' : 'Send', exact: true }).boundingBox();
        assert.ok(send && send.x >= 0 && send.x + send.width <= width && send.y + send.height <= 720);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('Markdown source, highlighting, keyboard editing and scrolling passed in Chromium/WebKit at 380/900px, light/dark, English/Chinese.');
} finally { await server.close(); }
