import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-ai-panel-surfaces');
await mkdir(screenshots, { recursive: true });
const output = join(screenshots, 'build');
await build({
  configFile: false, root, logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  build: {
    target: 'esnext', outDir: output, emptyOutDir: false,
    rolldownOptions: {
      input: join(root, 'scripts/perf/ai-panel-surfaces-page.tsx'),
      output: { entryFileNames: 'surfaces.js', assetFileNames: '[name][extname]' },
    },
  },
});
const css = (await readdir(output)).filter(name => name.endsWith('.css'));
await writeFile(join(output, 'index.html'), `<!doctype html><html><head>${css.map(name => `<link rel="stylesheet" href="/${name}">`).join('')}</head><body><div id="root"></div><script type="module" src="/surfaces.js"></script></body></html>`);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const name = pathname === '/__surfaces' ? 'index.html' : pathname.slice(1);
  try {
    const content = await readFile(join(output, name));
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(name)] ?? 'application/octet-stream');
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log('Surface preview server ready');
  const browser = await chromium.launch(process.env.SHELLSPAN_BROWSER_CHANNEL
    ? { channel: process.env.SHELLSPAN_BROWSER_CHANNEL } : {});
  try {
    const origin = `http://127.0.0.1:${server.address().port}/__surfaces`;
    for (const sample of [
      { width: 1000, height: 800, panelWidth: 720, locale: 'zh-CN', theme: 'light' },
      { width: 1200, height: 720, panelWidth: 380, locale: 'en-US', theme: 'light' },
      { width: 380, height: 600, panelWidth: 380, locale: 'zh-CN', theme: 'dark' },
      { width: 600, height: 420, panelWidth: 520, locale: 'en-US', theme: 'dark' },
      { width: 320, height: 480, panelWidth: 320, locale: 'en-US', theme: 'light' },
    ]) {
      const page = await browser.newPage({ viewport: sample });
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const query = new URLSearchParams(Object.entries(sample).map(([key, value]) => [key, String(value)]));
      const label = `${sample.panelWidth}-${sample.height}-${sample.locale}-${sample.theme}`;
      console.log(`Checking ${label}`);
      await page.goto(`${origin}?${query}`, { waitUntil: 'commit' });
      const panel = page.locator('[data-slot="ai-approval-panel"]');
      await panel.waitFor();
      const radius = await panel.evaluate(element => getComputedStyle(element).borderRadius);
      assert.equal(radius, sample.panelWidth <= 420 ? '14px' : '22px');
      assert.match(await panel.evaluate(element => getComputedStyle(element).boxShadow), /0px 0px 0px 0\.5px/);
      const normal = await panel.boundingBox();
      assert.ok(normal.y >= 40 && normal.x >= 0, JSON.stringify(normal));
      const footer = panel.locator('[data-slot="card-footer"]');
      const heights = await footer.getByRole('button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
      assert.equal(heights[0], heights[1]);
      assert.equal(await footer.evaluate(element => getComputedStyle(element).borderTopColor), 'rgba(0, 0, 0, 0)');
      await panel.screenshot({ path: join(screenshots, `approval-${label}.png`) });

      await page.goto(`${origin}?${query}&long&error`);
      await panel.waitFor();
      await page.screenshot({ path: join(screenshots, `approval-long-${label}.png`) });
      const viewport = panel.locator('[data-slot="scroll-area-viewport"]');
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-slot="scroll-area-viewport"]');
        return element && element.scrollHeight > element.clientHeight;
      });
      const bounds = await panel.boundingBox();
      assert.ok(bounds.height <= sample.height * 0.72 + 1 && bounds.y >= 40, JSON.stringify(bounds));
      assert.ok(bounds.x + bounds.width <= sample.width + 1);
      assert.ok(await viewport.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      const header = panel.locator('[data-slot="card-header"]');
      const headerBefore = await header.boundingBox();
      const footerBefore = await footer.boundingBox();
      assert.ok(footerBefore.y + footerBefore.height <= sample.height);
      await viewport.hover();
      const scrollbar = panel.locator('[data-slot="scroll-area-scrollbar"]');
      await scrollbar.waitFor({ state: 'visible' });
      const bar = await scrollbar.boundingBox();
      assert.ok(Math.abs(bar.x + bar.width - bounds.x - bounds.width) <= 1);
      await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
      assert.ok(await viewport.evaluate(element => element.scrollTop > 0));
      assert.deepEqual(await header.boundingBox(), headerBefore);
      assert.deepEqual(await footer.boundingBox(), footerBefore);
      await footer.getByRole('button').last().click();
      assert.equal(await page.locator('[data-decisions]').textContent(), '1');
      await page.screenshot({ path: join(screenshots, `approval-scroll-${label}.png`) });

      await page.goto(`${origin}?${query}&screen=skills`);
      const editor = page.getByRole('textbox');
      await editor.fill('/');
      const list = page.getByRole('listbox');
      await list.waitFor();
      const popup = page.locator('.ai-completion-popup');
      assert.equal(await popup.locator('[data-slot="card"]').count(), 0);
      await page.waitForFunction(() => {
        const rect = document.querySelector('.ai-completion-popup')?.getBoundingClientRect();
        return rect && rect.y >= 0 && rect.x >= 0 && rect.right <= innerWidth + 1;
      });
      const popupBounds = await popup.boundingBox();
      assert.ok(popupBounds.y >= 0 && popupBounds.x >= 0 && popupBounds.x + popupBounds.width <= sample.width + 1);
      assert.ok(await list.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      assert.equal(await editor.evaluate(element => document.activeElement === element), true);
      await page.screenshot({ path: join(screenshots, `skills-${label}.png`) });
      const skillsHeader = popup.locator('[data-slot="popover-header"]');
      await editor.press('ArrowUp');
      const lastOption = list.getByRole('option').last();
      assert.equal(await lastOption.getAttribute('aria-selected'), 'true');
      await page.waitForFunction(() => {
        const option = document.querySelector('[data-skill-completion] [role="option"][aria-selected="true"]');
        const viewport = option?.parentElement?.parentElement;
        if (!option || !viewport) return false;
        const item = option.getBoundingClientRect();
        const visible = viewport.getBoundingClientRect();
        return item.y >= visible.y - 1 && item.bottom <= visible.bottom + 1;
      });
      const lastBounds = await lastOption.boundingBox();
      const viewportBounds = await list.evaluate(element => element.parentElement.getBoundingClientRect().toJSON());
      assert.ok(lastBounds.y >= viewportBounds.y - 3 && lastBounds.y + lastBounds.height <= viewportBounds.y + viewportBounds.height + 3,
        JSON.stringify({ lastBounds, viewportBounds }));
      const skillsHeaderAfter = await skillsHeader.boundingBox();
      assert.ok(skillsHeaderAfter.y + skillsHeaderAfter.height <= viewportBounds.y + 1);
      await editor.press('ArrowDown');
      await editor.press('Enter');
      assert.match(await editor.textContent(), /^\/system-status /);
      assert.deepEqual(errors, []);
      console.log(`${label}: surface, scrolling, fixed actions and skill keyboard selection passed`);
      await page.close();
    }
    console.log(`Screenshots: ${screenshots}`);
  } finally { await browser.close(); }
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
