import assert from 'node:assert/strict';
import path from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss(), {
    name: 'records-width-test',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/width-test') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/ai-session-records-width.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/width-test`);
  await page.locator('.ai-session-records-detail .ai-conversation-content').waitFor();
  for (const width of [1024, 400]) {
    await page.setViewportSize({ width, height: 800 });
    const sizes = await page.evaluate(() => [...document.querySelectorAll('.ai-workspace-root:not([data-testid])')].map((shell) => {
      const content = shell.querySelector('.ai-conversation-content').getBoundingClientRect();
      const box = shell.getBoundingClientRect();
      const style = getComputedStyle(shell);
      return {
        shell: box.width, content: content.width, left: content.left - box.left,
        inset: parseFloat(style.getPropertyValue('--ai-shell-clearance')) + parseFloat(style.getPropertyValue('--ai-transcript-extra-inset')),
        overflow: shell.scrollWidth > shell.clientWidth,
      };
    }));
    const [detail, standard] = sizes;
    assert.ok(Math.abs(detail.content - (detail.shell - 2 * detail.inset)) < 1);
    assert.ok(Math.abs(detail.left - detail.inset) < 1);
    assert.equal(detail.overflow, false);
    assert.ok(Math.abs(standard.content - Math.min(640, standard.shell - 2 * standard.inset)) < 1);
    const loading = await page.locator('[data-testid="loading-body"]').evaluate((shell) => {
      const body = shell.getBoundingClientRect();
      const status = shell.querySelector('[role="status"]');
      const hint = status.firstElementChild.getBoundingClientRect();
      const spinner = status.querySelector('svg').getBoundingClientRect();
      const text = status.querySelector('span > span').getBoundingClientRect();
      return {
        centerX: hint.x + hint.width / 2 - (body.x + body.width / 2),
        centerY: hint.y + hint.height / 2 - (body.y + body.height / 2),
        gap: text.left - spinner.right,
        label: status.textContent,
      };
    });
    assert.ok(Math.abs(loading.centerX) < 1 && Math.abs(loading.centerY) < 1, 'Loading hint is centered in the entire body');
    assert.equal(loading.gap, 4);
    assert.ok(loading.label.includes('加载'));
  }
  await page.evaluate(async () => {
    const entry = await import('/src/components/ai/__tests__/ai-session-records-width.browser-entry.tsx');
    entry.showRecordsDialog();
  });
  await page.getByRole('searchbox').waitFor();
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 800 });
    const toolbar = await page.getByRole('searchbox').evaluate((input) => {
      const toolbar = input.parentElement.parentElement;
      const controls = [...toolbar.querySelectorAll('input[type="search"], button')].map((control) => control.getBoundingClientRect());
      const icon = input.parentElement.querySelector('svg').getBoundingClientRect();
      const box = input.getBoundingClientRect();
      return {
        heights: controls.map((control) => control.height),
        height: toolbar.getBoundingClientRect().height,
        overflow: toolbar.scrollWidth > toolbar.clientWidth,
        iconOffset: icon.y + icon.height / 2 - (box.y + box.height / 2),
      };
    });
    assert.deepEqual(toolbar.heights, [32, 32, 32, 32]);
    if (width === 1280) assert.equal(toolbar.height, 49);
    assert.equal(toolbar.overflow, false);
    assert.ok(Math.abs(toolbar.iconOffset) < 1);
    await page.screenshot({ path: `/tmp/shellspan-records-toolbar-${width}.png`, animations: 'disabled' });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
