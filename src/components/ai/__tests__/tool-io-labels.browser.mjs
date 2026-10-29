import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-tool-io-labels');
await mkdir(screenshots, { recursive: true });
const args = ['log', '--oneline', '-3'];
const input = { command: `git ${args.join(' ')}` };
const output = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'tool-io-labels',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="padding:12px"></main></body></html>');
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
      for (const locale of ['zh-CN', 'en-US']) {
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
        await page.evaluate(async ({ input, output, locale }) => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(locale);
          useAppStore.setState({ locale });
          createRoot(document.getElementById('root')).render(React.createElement(AiToolExpandedContent, {
            node: { kind: 'tool', name: 'git', state: 'succeeded', input, output, error: null },
          }));
        }, { input, output, locale });
        const card = page.locator('.ai-io-card');
        await card.waitFor();
        assert.deepEqual(await page.locator('.ai-io-label').allTextContents(), locale === 'zh-CN' ? ['输入', '输出'] : ['IN', 'OUT']);
        assert.deepEqual(await page.locator('.ai-io-text').allTextContents(), [JSON.stringify(input, null, 2), output]);
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          for (const width of [380, 720]) {
            await page.setViewportSize({ width, height: 720 });
            await card.evaluate(element => { element.scrollTop = 0; });
            if (locale === 'zh-CN') await card.screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}.png`) });
            const rows = await page.locator('.ai-io-section').evaluateAll(sections => sections.map(section => {
              // Measure text rather than boxes: the body owns its padding, while the label's parent owns header padding.
              const labelRange = document.createRange();
              labelRange.selectNodeContents(section.querySelector('.ai-io-label'));
              const label = labelRange.getBoundingClientRect();
              const textRange = document.createRange();
              textRange.selectNodeContents(section.querySelector('.ai-io-text'));
              const text = textRange.getBoundingClientRect();
              const copy = section.querySelector('button').getBoundingClientRect();
              return { labelBottom: label.bottom, textTop: text.top, labelLeft: label.left, textLeft: text.left,
                labelRight: label.right, copyLeft: copy.left, copyRight: copy.right, copyBottom: copy.bottom,
                centerOffset: (copy.top + copy.bottom - label.top - label.bottom) / 2,
                clientWidth: section.clientWidth, scrollWidth: section.scrollWidth };
            }));
            for (const row of rows) {
              assert.ok(row.labelBottom < row.textTop, `${engine.name()}/${locale}/${theme}/${width}: label must have its own row`);
              assert.ok(Math.abs(row.labelLeft - row.textLeft) < 1,
                `${engine.name()}/${locale}/${theme}/${width}: label and body text must align (${JSON.stringify(row)})`);
              assert.ok(row.labelRight <= row.copyLeft && row.copyRight <= width);
              assert.ok(Math.abs(row.centerOffset) < 1 && row.copyBottom <= row.textTop);
              assert.ok(row.scrollWidth <= row.clientWidth);
            }
            assert.ok((await card.boundingBox()).height <= 260);
          }
        }
        for (const [index, expected] of [JSON.stringify(input, null, 2), output].entries()) {
          const button = page.locator('.ai-io-section button').nth(index);
          await button.focus();
          assert.equal(await button.evaluate(element => getComputedStyle(element).opacity), '1');
          if (engine === chromium) {
            await button.press('Enter');
            await page.locator('.ai-io-section').nth(index).getByRole('button', { name: locale === 'zh-CN' ? '已复制' : 'Copied', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
          }
        }

        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
        await page.evaluate(async locale => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
          const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
          const { conversationFoldRecording } = await import('/src/test/fixtures/conversation-fold-runtime.ts');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(locale);
          useAppStore.setState({ locale });
          const plan = projectAgentChatNodes(conversationFoldRecording.completed.events)
            .flatMap(item => item.kind === 'turnProcess' ? item.children : [])
            .find(item => item.kind === 'tool' && item.name === 'update_plan');
          if (!plan) throw new Error('Recorded plan tool is missing');
          createRoot(document.getElementById('root')).render(React.createElement(AiToolExpandedContent, { node: plan }));
        }, locale);
        await card.waitFor();
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          for (const width of [380, 720]) {
            await page.setViewportSize({ width, height: 720 });
            for (const offset of [120, 'end']) {
              await card.evaluate((element, offset) => { element.scrollTop = offset === 'end' ? element.scrollHeight : offset; }, offset);
              const layout = await card.evaluate(element => ({
                scrollTop: element.scrollTop,
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                rows: [...element.querySelectorAll('.ai-io-section')].map(section => ({
                  labelBottom: section.querySelector('.ai-io-label').getBoundingClientRect().bottom,
                  textTop: section.querySelector('.ai-io-text').getBoundingClientRect().top,
                })),
              }));
              const context = `${engine.name()}/${locale}/${theme}/${width}/${offset}`;
              assert.ok(layout.scrollTop > 0, `${context}: recorded plan must scroll`);
              assert.ok(layout.scrollWidth <= layout.clientWidth, `${context}: content must fit the card`);
              for (const row of layout.rows) {
                assert.ok(row.labelBottom < row.textTop, `${context}: scrolled label must stay above its text`);
              }
              if (locale === 'zh-CN') await card.screenshot({ path: join(screenshots, `${engine.name()}-plan-${theme}-${width}-${offset === 120 ? 'middle' : 'end'}.png`) });
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Tool input/output labels and recorded plan scrolling passed in Chromium/WebKit, both languages and themes, at 380px/720px. Screenshots: ${screenshots}`);
} finally {
  await server.close();
}
