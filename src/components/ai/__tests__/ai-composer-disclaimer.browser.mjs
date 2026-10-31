import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(tmpdir(), 'shellspan-composer-disclaimer');
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__disclaimer', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        for (const { phase, mode } of [
          { phase: 'active', mode: 'agent' }, { phase: 'hero', mode: 'agent' },
          { phase: 'active', mode: 'ask' }, { phase: 'hero', mode: 'ask' },
        ]) {
          const page = await browser.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__disclaimer`);
          await page.evaluate(async ({ locale, phase, mode }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiComposerSeat } = await import('/src/components/ai/workspace/ai-composer-seat.tsx');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            useAppStore.setState({ locale });
            await initI18n(locale);
            const host = document.createElement('main');
            host.id = 'disclaimer-check';
            host.className = 'ai-panel-shell ai-workspace-root @container/ai-workspace';
            host.style.cssText = 'position:fixed;inset:0;display:flex;align-items:end;background:var(--background)';
            document.body.append(host);
            createRoot(host).render(React.createElement(AiComposerSeat, { phase, mode, status: 'idle' }));
          }, { locale, phase, mode });
          const notice = page.locator('#disclaimer-check [data-slot="ai-composer-disclaimer"]');
          await notice.waitFor();
          for (const width of [900, 360]) {
            await page.setViewportSize({ width, height: 600 });
            const context = `${engine.name()}/${locale}/${phase}/${mode}/${width}`;
            const compact = phase === 'active' && mode === 'agent';
            const result = await notice.evaluate(el => {
              const seat = el.parentElement;
              const measure = () => {
                const seatRect = seat.getBoundingClientRect();
                return {
                  height: seatRect.height,
                  bottom: seatRect.bottom,
                  controls: [...seat.querySelectorAll('[data-slot="ai-composer-notices"], .ai-composer-input-anchor, [data-slot="input-group"], [data-slot="input-group-control"], .ai-composer-toolbar, .ai-composer-toolbar button')].map(control => {
                    const bounds = control.getBoundingClientRect();
                    const display = getComputedStyle(control).display;
                    return { display, x: bounds.x, y: display === 'none' ? bounds.y : bounds.y - seatRect.y,
                      width: bounds.width, height: bounds.height };
                  }),
                };
              };
              // Compare with the original zero margin using the same rendered controls.
              el.style.marginBlockStart = '0px';
              const original = measure();
              el.style.removeProperty('margin-block-start');
              const current = measure();
              const rect = el.getBoundingClientRect();
              const anchor = el.previousElementSibling.getBoundingClientRect();
              const input = el.previousElementSibling.querySelector('[data-slot="input-group"]').getBoundingClientRect();
              const style = getComputedStyle(el);
              const seatStyle = getComputedStyle(el.parentElement);
              return { original, current, text: el.textContent, fontSize: style.fontSize, align: style.textAlign,
                gap: rect.top - anchor.bottom, cardGap: rect.top - input.bottom,
                bottom: rect.bottom, stackGap: seatStyle.rowGap,
                bottomPadding: seatStyle.paddingBottom,
                center: rect.x + rect.width / 2, inputCenter: input.x + input.width / 2,
                fits: input.left >= 0 && input.right <= innerWidth };
            });
            assert.equal(result.text, locale === 'zh-CN'
              ? '内容由AI生成，请仔细甄别' : 'AI-generated content. Please review carefully.');
            assert.equal(result.fontSize, '11px');
            assert.equal(result.align, 'center');
            const expectedGap = compact ? 4 : 7;
            assert.equal(result.gap, expectedGap, `${context}: only active Agent conversations use the compact gap`);
            assert.ok(result.cardGap >= expectedGap && result.cardGap <= expectedGap + 8,
              `${context}: input minimum height leaves no excessive blank space`);
            assert.deepEqual(result.current.controls, result.original.controls,
              `${context}: input, toolbar, buttons and notice area preserve their dimensions and relative positions`);
            assert.equal(result.original.height - result.current.height, compact ? 3 : 0,
              `${context}: only the requested gap changes the composer height`);
            assert.equal(result.original.bottom, result.current.bottom, `${context}: composer keeps its bottom position`);
            assert.equal(result.stackGap, '7px', `${context}: other composer rows keep their spacing`);
            assert.equal(result.bottomPadding, '8px');
            assert.ok(result.bottom <= 600 && result.fits, `${context}: composer fits the viewport`);
            assert.ok(Math.abs(result.center - result.inputCenter) < 1);
            await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${phase}-${mode}-${width}.png`) });
          }
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Composer disclaimer layout passed in Chromium/WebKit, both languages, at 360px/900px. Screenshots: ${artifacts}`);
} finally {
  await server.close();
}
