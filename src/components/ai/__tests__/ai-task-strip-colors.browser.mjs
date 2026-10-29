import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Render recorded plan steps through the production component and theme styles.
assert.ok(process.argv[2], 'Pass a real session JSONL path containing a task plan');
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
const plan = events.findLast(event => event.type === 'task/plan' && event.data.steps.length);
assert.ok(plan, 'The session must contain a nonempty task plan');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-task-strip-colors');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><main id="root" class="ai-panel-shell ai-workspace-root p-4"></main></body></html>'));
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.SHELLSPAN_TEST_BROWSER_CHANNEL ?? 'chromium' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(async steps => {
    const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { AiTaskStrip } = await import('/src/components/ai/workspace/ai-task-strip.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    createRoot(document.getElementById('root')).render(React.createElement(AiTaskStrip, { steps, active: false }));
  }, plan.data.steps);
  const strip = page.locator('.ai-task-strip');
  const toggle = page.locator('.ai-task-strip-trigger');
  await strip.waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [320, 760]) {
      await page.setViewportSize({ width, height: 480 });
      for (const expanded of [false, true]) {
        if ((await toggle.getAttribute('aria-expanded') === 'true') !== expanded) await toggle.click();
        await toggle.blur();
        await page.mouse.move(0, 0);
        const metrics = await strip.evaluate(element => {
          const style = getComputedStyle(element);
          const probe = document.createElement('span');
          probe.style.background = 'var(--ai-code-block)';
          element.append(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          context.fillStyle = style.backgroundColor;
          context.fillRect(0, 0, 1, 1);
          const trigger = element.querySelector('.ai-task-strip-trigger');
          const center = node => {
            const rect = node.getBoundingClientRect();
            return rect.top + rect.height / 2;
          };
          return {
            background: style.backgroundColor, expected,
            channels: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3),
            fits: element.scrollWidth <= element.clientWidth + 1,
            height: trigger.getBoundingClientRect().height,
            centers: [...trigger.children].map(center), center: center(trigger),
          };
        });
        assert.equal(metrics.background, metrics.expected, 'Tasks must share the neutral content surface');
        assert.ok(Math.max(...metrics.channels) - Math.min(...metrics.channels) <= 2, `${theme}/${width}: task background must remain neutral gray`);
        assert.ok(metrics.fits, `${theme}/${width}: task strip must fit the panel`);
        assert.equal(metrics.height, 32);
        for (const center of metrics.centers) assert.ok(Math.abs(center - metrics.center) <= 1, 'Task icon, title and progress must remain vertically aligned');
        assert.equal(await strip.locator('li').count(), expanded ? plan.data.steps.length : 0);
        await strip.screenshot({ path: join(screenshots, `${theme}-${width}-${expanded ? 'expanded' : 'folded'}.png`) });
        await toggle.hover();
        await strip.screenshot({ path: join(screenshots, `${theme}-${width}-${expanded ? 'expanded' : 'folded'}-hover.png`) });
      }
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Keyboard folding must remain available');
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Task strip colors, alignment and keyboard folding passed in light/dark themes at 320px and 760px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
