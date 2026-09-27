import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'question-decline',
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
  for (const width of [380, 720]) {
    const page = await browser.newPage({ viewport: { width, height: 600 } });
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
          identity: { sessionId: 'decline', turnId: 'turn', stepId: 'step', requestId: 'request', callId: 'call', questionRequestId: 'question' },
          questions: [{ id: 'scope', question: '功能上希望保留或新增哪些？', multi_select: false }],
          status: 'pending', answers: [], firstSeq: 1, lastSeq: 1, timestamp: '2026-09-27T00:00:00Z',
        },
        onAnswer: async (input) => {
          document.getElementById('root').dataset.answer = JSON.stringify(input.answers);
        },
      }));
    });
    const decline = page.getByRole('button', { name: '拒绝回答', exact: true });
    await decline.waitFor();
    const bounds = await decline.boundingBox();
    const submitBounds = await page.getByRole('button', { name: '提交', exact: true }).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'Refusal action must stay within the viewport');
    assert.equal(bounds.height, submitBounds.height, 'Footer actions must have equal heights');
    await page.screenshot({ path: join(tmpdir(), `shellspan-question-decline-${width}.png`) });
    await decline.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('root').dataset.answer);
    const answers = JSON.parse(await page.locator('#root').getAttribute('data-answer'));
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0].selected, []);
    assert.match(answers[0].custom, /^用户拒绝回答本题/);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
