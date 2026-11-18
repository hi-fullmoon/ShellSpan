import assert from 'node:assert/strict';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { chromium, errors, webkit } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'ShellSpan browser verification for a truncated SFTP directory name-'));
const route = '/__path_breadcrumb';
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(root, 'artifacts/tests/path-breadcrumb/vite-cache'),
  resolve: { alias: { '@': join(root, 'src') } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['src/components/sftp/path-breadcrumb.tsx'], include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use(route, async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml(route, `<!doctype html>
    <html><body><main id="root" style="margin-top: 64px"></main>
    <script type="module">
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { PathBreadcrumb } from '/src/components/sftp/path-breadcrumb.tsx';
      import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
      import '/src/styles/base.css';
      const path = new URLSearchParams(location.search).get('path');
      createRoot(document.getElementById('root')).render(createElement(TooltipProvider, null,
        createElement(PathBreadcrumb, { path, pathKind: 'local', onNavigate: () => {} }),
      ));
    </script></body></html>`));
});

try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}${route}?path=${encodeURIComponent(directory)}`;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(url);
      const tooltip = page.locator('[data-slot="tooltip-content"]');
      const longName = basename(directory);
      const longSegment = page.getByRole('button', { name: longName, exact: true });
      const rootSegment = page.getByRole('button', { name: '/', exact: true });

      for (const width of [960, 380]) {
        await page.setViewportSize({ width, height: 360 });
        await rootSegment.hover();
        await assert.rejects(tooltip.waitFor({ state: 'visible', timeout: 1000 }), errors.TimeoutError,
          'A fully visible root label must not show a tooltip');

        if (width === 960) {
          await page.getByRole('button', { name: basename(dirname(directory)), exact: true }).hover();
          await assert.rejects(tooltip.waitFor({ state: 'visible', timeout: 1000 }), errors.TimeoutError,
            'A fully visible directory name must not show a tooltip');
        }

        assert.ok(await longSegment.locator('span').evaluate(label =>
          label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis'),
        'The directory name must actually be truncated in the rendered breadcrumb');
        await longSegment.hover();
        await tooltip.waitFor({ state: 'visible', timeout: 3000 });
        assert.equal(await tooltip.textContent(), longName);
        await page.mouse.move(width - 1, 350);
        await tooltip.waitFor({ state: 'hidden' });
      }

      const buttonCount = await page.getByRole('button').count();
      for (let index = 0; index < buttonCount; index += 1) {
        await page.keyboard.press('Tab');
      }
      assert.ok(await longSegment.evaluate(button => button === document.activeElement));
      await tooltip.waitFor({ state: 'visible', timeout: 3000 });
      assert.equal(await tooltip.textContent(), longName);
      await page.keyboard.press('Escape');
      await tooltip.waitFor({ state: 'hidden' });
      assert.ok(await longSegment.evaluate(button => button === document.activeElement));
      assert.deepEqual(pageErrors, []);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
  await rmdir(directory);
}
