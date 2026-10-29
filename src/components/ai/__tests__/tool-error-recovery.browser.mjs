import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const capture = JSON.parse(await readFile(join(root, 'src/test/fixtures/tool-result-read-recovery.json'), 'utf8'));
const diagnostic = capture.find(event => event.type === 'tool/result' && event.data.status === 'failed').data.summary;
const screenshots = join(tmpdir(), 'shellspan-tool-error-recovery');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'tool-error-recovery',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="height:100vh"></main></body></html>');
      });
    },
  }],
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      const page = await browser.newPage(engine === chromium ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [380, 720]) {
          await page.setViewportSize({ width, height: 640 });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
          await page.evaluate(async ({ capture, locale }) => {
            const { default: React } = await import('/node_modules/.vite/deps/react.js');
            const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiToolRow } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
            const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
            const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            await initI18n(locale);
            useAppStore.setState({ locale });
            const firstTool = events => projectAgentChatNodes(events)
              .flatMap(node => node.kind === 'turnProcess' ? node.children : [])
              .find(node => node.kind === 'tool');
            const failure = firstTool(capture.slice(0, 2));
            const recovered = firstTool(capture);
            const view = ReactDOM.createRoot(document.getElementById('root'));
            window.renderRecovery = stage => view.render(stage === 'details'
              ? React.createElement(AiToolDetails, { node: recovered, onBack() {} })
              : React.createElement(AiToolRow, { node: stage === 'failure' ? failure : recovered }));
            window.renderRecovery('failure');
          }, { capture, locale });
          const row = page.locator('.ai-tool-row');
          await row.waitFor();
          assert.ok(!(await row.innerText()).includes(diagnostic));
          for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            const appearance = await row.evaluate(element => {
              const summary = element.querySelector('.ai-disclosure-summary[data-error]');
              const leading = element.querySelector('.ai-disclosure-leading');
              const dot = element.querySelector('.ai-state-dot[data-state="failed"]');
              return {
                summary: getComputedStyle(summary).color,
                muted: getComputedStyle(leading).color,
                dot: getComputedStyle(dot).backgroundColor,
                right: element.getBoundingClientRect().right,
                label: element.getAttribute('aria-label'),
                text: summary.textContent,
              };
            });
            assert.equal(appearance.summary, appearance.muted,
              `${engine.name()}/${locale}/${theme}/${width}: failure summary must use the muted text color`);
            assert.notEqual(appearance.summary, appearance.dot, 'Failure emphasis must stay on the status dot');
            assert.ok(appearance.label.includes(appearance.text), 'Failure summary must remain readable in the accessible label');
            assert.ok(appearance.right <= width, 'Failure row must fit the narrow panel');
            await page.screenshot({ path: join(screenshots, `${engine.name()}-${locale}-${theme}-${width}-failure.png`) });
          }
          await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
          await row.focus();
          await page.keyboard.press('Enter');
          await page.getByText(diagnostic, { exact: true }).waitFor();
          assert.equal(await page.getByText(diagnostic, { exact: true }).count(), 1);
          await page.waitForFunction(() => {
            const panel = document.querySelector('.ai-tool-row-root > [data-slot="collapsible-content"]');
            return panel && panel.getBoundingClientRect().height >= panel.scrollHeight - 1;
          });
          const errorCard = page.locator('[data-ai-tool-view="error"]');
          const copyButton = errorCard.getByRole('button', { name: locale === 'zh-CN' ? '复制输出' : 'Copy output', exact: true });
          const errorGeometry = await errorCard.evaluate(element => {
            const header = element.querySelector('.ai-tool-surface-header').getBoundingClientRect();
            const label = element.querySelector('.ai-block-banner > span').getBoundingClientRect();
            const code = element.querySelector('code');
            const text = document.createRange();
            text.selectNodeContents(code);
            const firstLine = text.getClientRects()[0];
            const copy = element.querySelector('button');
            const button = copy.getBoundingClientRect();
            const pre = element.querySelector('pre');
            const body = pre.getBoundingClientRect();
            return {
              gap: firstLine.top - label.bottom,
              headerBottom: header.bottom,
              lineHeight: parseFloat(getComputedStyle(pre).lineHeight),
              bodyTop: body.top,
              textTop: firstLine.top,
              textRight: body.right - parseFloat(getComputedStyle(pre).paddingRight),
              buttonTop: button.top, buttonLeft: button.left, buttonRight: button.right,
              copyInHeader: Boolean(copy.closest('.ai-block-banner')),
              bodyOwnsCopy: copy.closest('[data-ai-copy-region]')?.contains(code),
            };
          });
          assert.ok(Math.abs(errorGeometry.bodyTop - errorGeometry.headerBottom) < 1,
            `The diagnostic body must directly follow its heading: ${JSON.stringify(errorGeometry)}`);
          assert.ok(errorGeometry.gap >= 0 && errorGeometry.gap <= errorGeometry.lineHeight,
            `Error label and diagnostic must stay within one line of each other: ${JSON.stringify(errorGeometry)}`);
          assert.equal(errorGeometry.copyInHeader, true);
          assert.equal(errorGeometry.bodyOwnsCopy, false);
          assert.ok(errorGeometry.buttonTop < errorGeometry.bodyTop && errorGeometry.buttonRight <= width,
            'The error copy action must stay in the heading above the diagnostic');
          await page.mouse.move(width - 1, 600);
          assert.equal(await copyButton.evaluate(element => getComputedStyle(element).opacity), '0',
            'The error copy icon must stay hidden until its diagnostic is hovered');
          assert.equal(await copyButton.evaluate(element => getComputedStyle(element).pointerEvents), 'none');
          await errorCard.locator('.ai-block-banner').hover();
          assert.equal(await copyButton.evaluate(element => getComputedStyle(element).opacity), '1',
            'Hovering the error heading must reveal its copy icon');
          await errorCard.locator('[data-ai-copy-region]').hover({ position: { x: 16, y: 8 } });
          assert.equal(await copyButton.evaluate(element => getComputedStyle(element).opacity), '1');
          await page.screenshot({ path: join(screenshots, `${engine.name()}-${locale}-${width}-error-spacing.png`) });
          await page.mouse.move(width - 1, 600);
          assert.equal(await copyButton.evaluate(element => getComputedStyle(element).opacity), '0',
            'Leaving the diagnostic must hide its copy icon');
          await copyButton.focus();
          assert.equal(await copyButton.evaluate(element => getComputedStyle(element).opacity), '1');
          if (engine === chromium) {
            await copyButton.press('Enter');
            await errorCard.getByRole('button', { name: locale === 'zh-CN' ? '已复制' : 'Copied', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), diagnostic);
          }
          await page.evaluate(() => window.renderRecovery('recovered'));
          await page.locator('[data-tool-recovered="true"]').waitFor();
          assert.equal(await row.getAttribute('aria-expanded'), 'false');
          await page.getByText(diagnostic, { exact: true }).waitFor({ state: 'hidden' });
          assert.equal(await page.locator('.ai-disclosure-summary[data-error]').count(), 0);
          await page.screenshot({ path: join(screenshots, `${engine.name()}-${locale}-${width}-collapsed.png`) });
          await row.focus();
          await page.keyboard.press('Enter');
          await page.getByText(diagnostic, { exact: true }).waitFor();
          assert.equal(await page.getByText(diagnostic, { exact: true }).count(), 1);
          await page.waitForFunction(() => {
            const panel = document.querySelector('.ai-tool-row-root > [data-slot="collapsible-content"]');
            return panel && panel.getBoundingClientRect().height >= panel.scrollHeight - 1;
          });
          const geometry = await row.evaluate(element => {
            const leading = element.querySelector('.ai-disclosure-leading').getBoundingClientRect();
            const title = element.querySelector('.ai-disclosure-title').getBoundingClientRect();
            return { gap: title.left - leading.right, right: element.getBoundingClientRect().right };
          });
          assert.ok(Math.abs(geometry.gap - 4) < 1, 'Tool icon and title must retain a 4px gap');
          assert.ok(geometry.right <= width, 'Tool record must fit the narrow panel');
          await page.screenshot({ path: join(screenshots, `${engine.name()}-${locale}-${width}-expanded.png`) });
          const surface = await page.locator('[data-ai-tool-view="error"]').evaluate(element => ({
            right: element.getBoundingClientRect().right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
            children: [...element.querySelectorAll('*')].map(child => ({
              tag: child.tagName, className: child.getAttribute('class'), right: child.getBoundingClientRect().right,
              scrollWidth: child.scrollWidth, clientWidth: child.clientWidth,
            })),
          }));
          assert.ok(surface.right <= width && surface.scrollWidth <= surface.clientWidth,
            `${engine.name()}/${locale}/${width}: ${JSON.stringify(surface)}`);
          await row.focus();
          await page.keyboard.press('Enter');
          assert.equal(await row.getAttribute('aria-expanded'), 'false');
          await page.evaluate(() => window.renderRecovery('details'));
          await page.locator('[data-slot="ai-tool-details"]').waitFor();
          assert.equal(await page.getByText(diagnostic, { exact: true }).count(), 1);
          assert.equal(await page.locator('.ai-detail-error').count(), 0);
          assert.equal(await page.locator('[data-ai-tool-view="error"] > .ai-block-banner').count(), 0);
          assert.equal(await page.getByText(locale === 'zh-CN' ? '查看错误详情' : 'View error details', { exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: locale === 'zh-CN' ? '复制输出' : 'Copy Output', exact: true }).count(), 1);
          assert.ok(await page.locator('[data-slot="ai-tool-details"]').evaluate(element =>
            element.scrollWidth <= element.clientWidth));
          await page.screenshot({ path: join(screenshots, `${engine.name()}-${locale}-${width}-details.png`) });
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
  console.log(`Tool error recovery rendering passed in Chromium/WebKit, both languages, at 380px/720px. Screenshots: ${screenshots}`);
} finally {
  await server.close();
}
