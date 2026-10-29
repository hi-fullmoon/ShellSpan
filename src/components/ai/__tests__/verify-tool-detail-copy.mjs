import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const stdout = execFileSync('git', ['log', '--oneline', '-100'], { cwd: root, encoding: 'utf8' });
// Reuse the repository text that reproduced the long-summary collapse in review.
const longSummary = readFileSync(new URL('../../../../AGENTS.md', import.meta.url), 'utf8').slice(0, 650);
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'tool-detail-copy-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell" style="height:100vh"></main></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    for (const locale of ['zh-CN', 'en-US']) {
      for (const scenario of [
        { state: 'failed' }, { state: 'succeeded' }, { state: 'running' },
        { state: 'running', summary: longSummary }, { state: 'succeeded', summary: longSummary },
      ]) {
        const { state, summary } = scenario;
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
        await page.evaluate(async ({ locale, state, summary, stdout, root }) => {
          const { default: React } = await import('/node_modules/.vite/deps/react.js');
          const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(locale);
          useAppStore.setState({ locale });
          // Reproduce the recorded failure and render actual git output, including its running state.
          const error = state === 'failed' ? 'native result evidence did not match the frozen call' : null;
          const node = {
            kind: 'tool', name: error ? 'wait_process' : 'run_terminal_command', nativeName: null,
            state, summary: summary || error || 'git log --oneline -100', durationMs: null,
            input: error
              ? { maxOutputBytes: 2048, processHandle: 'proc-1f7278e9267f4637a717a4888f5681e6', timeoutMs: 2000 }
              : { command: 'git log --oneline -100', cwd: root },
            output: error || (state === 'running' ? null : { stdout, exitCode: 0 }),
            error, effect: 'readOnly', idempotency: 'yes',
            target: { kind: 'local', label: 'zsh' }, approval: null, evidenceRefs: [],
          };
          ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiToolDetails, { node, onBack() {} }));
        }, { locale, state, summary, stdout, root }).catch(error => {
          throw new Error(`${engine.name()}/${locale}/${state}: ${error.message}; ${errors.join('; ')}`, { cause: error });
        });
        await page.locator('.ai-detail-section').first().waitFor();
        for (const { width, height } of [{ width: 390, height: 420 }, { width: 720, height: 800 }, { width: 1280, height: 1000 }]) {
          await page.setViewportSize({ width, height });
          const positions = await page.locator('.ai-tool-copy-button').evaluateAll(buttons => buttons.map(button => {
            const rect = button.getBoundingClientRect();
            const header = button.closest('.ai-detail-section-header').getBoundingClientRect();
            return { right: rect.right, width: rect.width, centerOffset: (rect.top + rect.bottom - header.top - header.bottom) / 2 };
          }));
          assert.equal(positions.length, state === 'running' ? 2 : 3);
          assert.ok(positions.every(position => Math.abs(position.right - positions[0].right) < 1));
          assert.ok(positions.every(position => position.right <= width && position.width > 0 && Math.abs(position.centerOffset) < 1));
          const sections = await page.locator('.ai-detail-section').evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect();
            return { height: rect.height, bottom: rect.bottom, right: rect.right };
          }));
          assert.ok(sections.every(section => Math.abs(section.height - sections[0].height) < 1), 'All three sections must have equal height');
          assert.ok(sections.every(section => section.height > 40 && section.bottom <= height && section.right <= width), 'All sections must stay inside the panel');
          assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'The panel must not add an outer scrollbar');
          if (summary) {
            const summaryRoot = page.locator('.ai-detail-summary');
            assert.equal(await summaryRoot.locator('p').textContent(), summary, 'The full summary must remain available');
            const metrics = await summaryRoot.evaluate(element => ({
              height: element.getBoundingClientRect().height,
              availableHeight: element.parentElement.clientHeight,
            }));
            assert.ok(metrics.height <= metrics.availableHeight * 0.3 + 1, 'The summary must reserve space for all three detail sections');
            const viewport = summaryRoot.locator('[data-slot="scroll-area-viewport"]');
            if (height === 420) {
              const positions = await page.locator('.ai-detail-section').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
              await viewport.focus();
              assert.ok(await viewport.evaluate(element => element.matches(':focus-visible')), 'Long summaries must support keyboard focus');
              await viewport.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
              assert.ok(await viewport.evaluate(element => element.scrollTop > 0), 'Long summaries must scroll independently');
              assert.ok(await page.locator('.ai-detail-section [data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollTop === 0)));
              assert.deepEqual(await page.locator('.ai-detail-section').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top)), positions);
              await viewport.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
              await viewport.blur();
            }
            assert.ok(await page.locator('.ai-detail-section [data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.clientHeight >= 20)), 'Every detail section must keep usable content height');
          }
          if (height === 420) {
            const headers = await page.locator('.ai-detail-section-header').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
            const viewports = page.locator('.ai-detail-section [data-slot="scroll-area-viewport"]');
            for (let index = 0; index < 3; index++) {
              const viewport = viewports.nth(index);
              const overflows = await viewport.evaluate(element => element.scrollHeight > element.clientHeight);
              if (!overflows) continue;
              await viewport.focus();
              assert.ok(await viewport.evaluate(element => document.activeElement === element), 'Scrollable content must be focusable');
              const focus = await viewport.evaluate(element => {
                const viewportStyle = getComputedStyle(element);
                const sectionStyle = getComputedStyle(element.closest('.ai-detail-section'));
                return {
                  visible: element.matches(':focus-visible'),
                  viewportOutline: viewportStyle.outlineStyle,
                  viewportShadow: viewportStyle.boxShadow,
                  sectionOutline: sectionStyle.outlineWidth,
                  sectionOffset: sectionStyle.outlineOffset,
                };
              });
              assert.ok(focus.visible, 'Keyboard focus must remain visible');
              assert.equal(focus.viewportOutline, 'none', 'The scroll viewport must not add a line beneath the section header');
              assert.equal(focus.viewportShadow, 'none', 'A clipped viewport focus ring must not overlap the header divider');
              assert.equal(focus.sectionOutline, '2px', 'Focus must outline the whole section');
              assert.equal(focus.sectionOffset, '2px', 'The section focus outline must remain outside the header and content');
              await viewport.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
              assert.ok(await viewport.evaluate(element => element.scrollTop > 0), 'Overflowing content must scroll');
              assert.equal(await viewports.nth((index + 1) % 3).evaluate(element => element.scrollTop), 0, 'Scrolling must stay within its section');
              await viewport.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
            }
            assert.deepEqual(await page.locator('.ai-detail-section-header').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top)), headers);
            if (state === 'succeeded') {
              await page.screenshot({ path: `/tmp/shellspan-tool-detail-focused-${engine.name()}-${locale}.png` });
            }
            await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
          }
          if (state === 'succeeded') {
            const viewport = page.locator('.ai-detail-section').nth(1).locator('[data-slot="scroll-area-viewport"]');
            assert.ok(await viewport.evaluate(element => element.scrollHeight > element.clientHeight), 'Long terminal output must scroll at section level');
            assert.equal(await page.locator('.ai-terminal-output > div').evaluate(element => getComputedStyle(element).maxHeight), 'none');
            await page.screenshot({ path: `/tmp/shellspan-tool-detail-${summary ? 'long-summary-' : ''}${engine.name()}-${locale}-${width}.png` });
          }
        }
      }
    }
    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
  }
  console.log('Tool detail equal heights, independent scrolling, focus and copy alignment passed in Chromium and WebKit, in both languages.');
} finally {
  await browser?.close();
  await server.close();
}
