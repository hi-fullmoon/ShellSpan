import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/ai-style-audit.browser-entry.tsx';
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/styles', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/styles', `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/styles`);
        for (const locale of ['zh-CN', 'en-US']) {
          for (const draft of ['', 'Long draft\n'.repeat(80)]) {
            await page.evaluate(async args => {
              const { show } = await import(args.entry);
              await show(args.locale, args.draft);
            }, { entry, locale, draft });
            const editor = page.getByRole('textbox');
            await editor.waitFor();
            assert.equal(await page.locator('.ai-markdown-image-alt').textContent(), locale === 'zh-CN' ? '[图片]' : '[image]');
            const geometry = await editor.evaluate(el => {
              const rect = el.getBoundingClientRect();
              const parent = el.parentElement.getBoundingClientRect();
              return { rightInset: parent.right - rect.right, height: rect.height,
                scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
                paddingLeft: getComputedStyle(el).paddingLeft };
            });
            assert.ok(geometry.rightInset <= 1, `Scroll layer must reach its parent edge: ${JSON.stringify(geometry)}`);
            assert.equal(geometry.paddingLeft, '16px');
            if (draft) {
              assert.ok(geometry.scrollHeight > geometry.clientHeight);
              assert.ok(geometry.height <= 303);
              assert.ok(await editor.evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop > 0; }));
            } else {
              const aligned = await page.locator('.ai-composer-placeholder').evaluate(el => {
                const editor = el.previousElementSibling;
                return Math.abs(el.getBoundingClientRect().left - editor.getBoundingClientRect().left - parseFloat(getComputedStyle(editor).paddingLeft)) < 1;
              });
              assert.ok(aligned, 'Placeholder must align with editable text');
            }
          }
        }
        await page.screenshot({ path: `/tmp/ai-style-audit-${engine.name()}-${width}.png` });
        await page.evaluate(async entry => { const { showRecords } = await import(entry); showRecords(); }, entry);
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await dialog.evaluate(async el => {
          await Promise.all(el.getAnimations().map(animation => animation.finished));
        });
        for (const dark of [false, true]) {
          await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
          const geometry = await dialog.evaluate(el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const probe = document.createElement('span');
            probe.style.backgroundColor = 'var(--app-surface)';
            el.append(probe);
            const surfaceMatches = style.backgroundColor === getComputedStyle(probe).backgroundColor;
            probe.remove();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
              surfaceMatches, radius: style.borderRadius };
          });
          assert.ok(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= 720, JSON.stringify(geometry));
          assert.ok(geometry.surfaceMatches);
          assert.ok(await dialog.getByRole('button', { name: 'Close', exact: true }).isVisible());
          await page.screenshot({ path: `/tmp/ai-records-style-${engine.name()}-${width}-${dark}.png` });
        }
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('AI composer, image fallback and records-dialog styles passed in Chromium/WebKit at 360px/900px.');
} finally { await server.close(); }
