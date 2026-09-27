import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-question-actions-hover');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'question-actions-hover',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell"></main></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { AiQuestionPanel } = await import('/src/components/ai/workspace/ai-question-panel.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiQuestionPanel, {
      question: {
        identity: { sessionId: 'hover', turnId: 'turn', stepId: 'step', requestId: 'request', callId: 'call', questionRequestId: 'question' },
        questions: [{ id: 'frequency', header: '发生频率', question: '这种现象大概多久出现一次?', multi_select: false }],
        status: 'pending', answers: [], firstSeq: 1, lastSeq: 1, timestamp: '2026-09-27T00:00:00Z',
      },
    }));
  });
  const buttons = page.locator('.ai-question-panel-actions button');
  await buttons.first().click();
  for (const width of [380, 720]) {
    await page.setViewportSize({ width, height: 400 });
    for (let index = 0; index < 2; index += 1) {
      const button = buttons.nth(index);
      const before = await button.boundingBox();
      await button.hover();
      await page.waitForFunction(element => getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)', await button.elementHandle());
      await button.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
      const geometry = await button.evaluate(element => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const icon = element.querySelector('svg').getBoundingClientRect();
        return {
          width: box.width, height: box.height,
          backgroundWidth: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          backgroundHeight: box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
          clip: style.backgroundClip, iconWidth: icon.width, iconHeight: icon.height,
          centered: icon.x + icon.width / 2 === box.x + box.width / 2 && icon.y + icon.height / 2 === box.y + box.height / 2,
        };
      });
      assert.deepEqual(geometry, {
        width: 32, height: 32, backgroundWidth: 24, backgroundHeight: 24,
        clip: 'content-box', iconWidth: 14, iconHeight: 14, centered: true,
      });
      assert.deepEqual(await button.boundingBox(), before, 'Hover must preserve action placement');
      await page.screenshot({ path: join(screenshots, `${width}-${index}.png`) });
    }
  }
  await buttons.first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await buttons.first().getAttribute('aria-expanded'), 'true');
  await buttons.nth(1).click();
  assert.equal(await buttons.first().getAttribute('aria-expanded'), 'false');
  console.log(`Question action hover checks passed at 380px and 720px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
