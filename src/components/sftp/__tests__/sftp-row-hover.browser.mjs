import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createCanvas, loadImage } from 'canvas';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(root, '.artifacts/tests/sftp-row-hover');
await mkdir(artifacts, { recursive: true });
// Read real repository entries; the browser renders the production list and selection logic.
const entries = await Promise.all(['src', 'AGENTS.md', 'package.json'].map(async name => {
  const path = join(root, name);
  const metadata = await stat(path);
  return {
    path, name, kind: metadata.isDirectory() ? 'directory' : 'file',
    size: metadata.size, modifiedAt: Math.floor(metadata.mtimeMs / 1000),
  };
}));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': join(root, 'src') } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__sftp_row_hover', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" style="height:320px;background:var(--app-surface)"></main></body></html>');
});
const colors = row => row.locator('[data-sftp-file-cell]').evaluateAll(cells =>
  cells.map(cell => getComputedStyle(cell).backgroundColor));
const assertSelectedBorders = async (page, rows, context) => {
  const screenshot = await loadImage(await page.screenshot({ path: join(artifacts, 'selected-borders.png') }));
  const canvas = createCanvas(screenshot.width, screenshot.height);
  const pixels = canvas.getContext('2d');
  pixels.drawImage(screenshot, 0, 0);
  for (const row of rows) {
    const bounds = await row.boundingBox();
    assert.ok(bounds, `${context}: selected row is visible`);
    const x = Math.round(bounds.x + 250);
    const top = Array.from(pixels.getImageData(x, Math.round(bounds.y - 1), 1, 1).data);
    const bottom = Array.from(pixels.getImageData(x, Math.round(bounds.y + bounds.height - 1), 1, 1).data);
    // Opaque color-mix and background alpha compositing can round one channel
    // differently in the rasterizer; a full extra divider is much darker.
    assert.ok(top.every((channel, index) => Math.abs(channel - bottom[index]) <= 1),
      `${context}: selected dividers differ: top=${top}, bottom=${bottom}`);
  }
};
const waitForColor = async (row, alpha) => {
  await row.locator('[data-sftp-file-cell]').first().evaluate((cell, alpha) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 3000;
    const check = () => {
      const color = getComputedStyle(cell).backgroundColor;
      if (color.endsWith(`/ ${alpha})`)) resolve();
      else if (performance.now() > deadline) reject(new Error(`Unexpected row color: ${color}`));
      else requestAnimationFrame(check);
    };
    check();
  }), alpha);
};

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        const page = await browser.newPage({ viewport: { width: 960, height: 480 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__sftp_row_hover`);
        await page.evaluate(async ({ entries, locale, root }) => {
          const { mountList } = await import('/src/components/sftp/__tests__/sftp-row-hover.browser.tsx');
          await mountList(entries, locale, root);
        }, { entries, locale, root });
        const row = page.getByTestId('sftp-row').filter({ hasText: 'package.json' });
        const selected = page.getByTestId('sftp-row').filter({ hasText: 'AGENTS.md' });
        const parent = page.getByTestId('sftp-parent-row').last();
        await row.waitFor();
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await page.locator('[data-sftp-file-cell]').first().evaluate(cell => {
            getComputedStyle(cell).backgroundColor;
            return Promise.allSettled(document.getAnimations().map(animation => animation.finished));
          });
          for (const width of [960, 380]) {
            await page.setViewportSize({ width, height: 480 });
            await page.mouse.move(width - 1, 450);
            const initial = await colors(row);
            const selectedColor = await colors(selected);
            assert.equal(new Set(selectedColor).size, 1, 'Selection covers every column');
            await row.hover({ position: { x: 80, y: 16 } });
            await waitForColor(row, '0.05');
            const hovered = await colors(row);
            assert.equal(new Set(hovered).size, 1, 'Hover covers every column');
            assert.notEqual(hovered[0], initial[0], 'Hover changes the row background');
            assert.notEqual(hovered[0], selectedColor[0], 'Hover remains distinct from selection');
            await assertSelectedBorders(page, [selected], `${engine.name()}/${locale}/${theme}/${width}`);
            await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${theme}-${width}.png`) });
            await selected.hover({ position: { x: 80, y: 16 } });
            assert.deepEqual(await colors(selected), selectedColor, 'Hover preserves selection');
            await parent.hover({ position: { x: 80, y: 16 } });
            await waitForColor(parent, '0.05');
            assert.deepEqual(await colors(parent), hovered, 'Parent navigation uses the same hover');
            await page.mouse.move(width - 1, 450);
            await row.locator('[data-sftp-file-cell]').first().evaluate(cell => Promise.all(
              cell.getAnimations().map(animation => animation.finished),
            ));
            assert.deepEqual(await colors(row), initial, 'Leaving restores the background');
          }
        }
        await row.click({ position: { x: 80, y: 16 } });
        await waitForColor(row, '0.1');
        // The draggable row receives native focus on click; inspect selection
        // borders after blur so the browser's focus outline is measured separately.
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await row.locator('[data-sftp-file-cell]').first().evaluate(cell => {
            getComputedStyle(cell).backgroundColor;
            return Promise.allSettled(document.getAnimations().map(animation => animation.finished));
          });
          await assertSelectedBorders(page, [selected, row], `${theme}: adjacent selected rows share one divider`);
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`SFTP hover checks passed in Chromium/WebKit, both themes and languages, at 380px/960px. Screenshots: ${artifacts}`);
} finally {
  await server.close();
}
